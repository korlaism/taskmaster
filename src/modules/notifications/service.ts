import type { Clock } from "../../shared/clock.js";
import { childLogger } from "../../shared/logger.js";
import type { OutboxEvent } from "./domain.js";
import * as repo from "./repository.js";

const log = childLogger({ module: "notifications" });
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 10 * 60_000;

function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  const jitter = Math.random() * exp * 0.2;
  return exp + jitter;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

/** The single outbox dispatcher every durable side effect (Teams send, Jira write,
 * Git write) flows through: retry with exponential backoff, dead-letter after
 * MAX_ATTEMPTS, manual replay, and — because every enqueue is dedupe-keyed — safe
 * to run from multiple worker instances at once. */
export class NotificationsService {
  constructor(private readonly clock: Clock) {}

  enqueue = repo.enqueue;
  listDeadLetters = repo.listDeadLetters;
  replayDeadLetter = repo.replayDeadLetter;

  async dispatchDue(handlers: Partial<Record<string, OutboxHandler>>, batchSize = 25): Promise<void> {
    const now = this.clock.now();
    const events = await repo.claimDue(now, batchSize);
    for (const event of events) {
      const handler = handlers[event.eventType];
      try {
        if (!handler) throw new Error(`no outbox handler registered for event type ${event.eventType}`);
        await handler(event);
        await repo.markDone(event.id);
      } catch (err) {
        const nextAttemptAt = new Date(now.getTime() + backoffMs(event.attempts));
        log.warn(
          { eventId: event.id, eventType: event.eventType, attempts: event.attempts, err: (err as Error).message },
          "outbox delivery failed; scheduled retry"
        );
        await repo.markFailed(event.id, (err as Error).message, nextAttemptAt, MAX_ATTEMPTS);
      }
    }
  }
}
