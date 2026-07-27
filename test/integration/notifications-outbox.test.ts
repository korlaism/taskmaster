import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/shared/clock.js";
import { NotificationsService } from "../../src/modules/notifications/index.js";
import { pool } from "../../src/shared/db.js";
import { resetDatabase } from "../support/reset-db.js";

describe("notifications outbox: idempotency, retry/backoff, dead-letter, replay", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("enqueueing the same dedupe key twice creates only one outbox row", async () => {
    const service = new NotificationsService(fixedClock("2026-01-15T14:00:00.000Z"));
    const enqueueOne = () =>
      service.enqueue({
        aggregateType: "reminder",
        aggregateId: null,
        eventType: "send_reminder_card",
        payload: { foo: "bar" },
        dedupeKey: "dupe-key-1",
      });
    await enqueueOne();
    await enqueueOne();

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM outbox_events WHERE dedupe_key = $1`, [
      "dupe-key-1",
    ]);
    expect(rows[0].count).toBe(1);
  });

  it("a webhook-style duplicate delivery of the same logical event is a no-op", async () => {
    // Simulates "a webhook arrives twice": the caller derives the same dedupe key from
    // the webhook's own event id both times.
    // enqueue()'s next_attempt_at defaults to the database's real now(); the service's
    // clock must be at or after that for the event to look due, hence a far-future
    // fixed clock rather than an arbitrary past date.
    const service = new NotificationsService(fixedClock("2999-01-01T00:00:00.000Z"));
    let handlerCalls = 0;
    for (let i = 0; i < 2; i++) {
      await service.enqueue({
        aggregateType: "jira_action",
        aggregateId: "issue-123",
        eventType: "jira_webhook_replay_test",
        payload: {},
        dedupeKey: "jira-webhook-event-42",
      });
    }
    await service.dispatchDue({ jira_webhook_replay_test: async () => void handlerCalls++ });
    expect(handlerCalls).toBe(1);
  });

  it("retries a failing handler with backoff and eventually dead-letters it", async () => {
    const service = new NotificationsService(fixedClock("2999-01-01T00:00:00.000Z"));
    await service.enqueue({
      aggregateType: "reminder",
      aggregateId: null,
      eventType: "always_fails",
      payload: {},
      dedupeKey: "always-fails-1",
    });

    let attempts = 0;
    for (let i = 0; i < 8; i++) {
      await service.dispatchDue({
        always_fails: async () => {
          attempts++;
          throw new Error("simulated transient failure");
        },
      });
      // Bypass real backoff wait time in the test — the service's fixedClock never
      // advances, so pull next_attempt_at back to well before it (not DB now(), which
      // would be the real wall-clock time and unrelated to the fixed clock the service
      // is using) so the next dispatchDue call can immediately re-claim it.
      await pool.query(`UPDATE outbox_events SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = $1`, [
        "always-fails-1",
      ]);
    }

    expect(attempts).toBe(8);
    const { rows } = await pool.query(`SELECT status, attempts FROM outbox_events WHERE dedupe_key = $1`, [
      "always-fails-1",
    ]);
    expect(rows[0].status).toBe("dead_letter");
    expect(rows[0].attempts).toBe(8);
  });

  it("a replayed dead-letter is retried and can succeed", async () => {
    // replayDeadLetter resets next_attempt_at to the database's real now(); the
    // service's clock must be at or after real wall-clock time for the event to look
    // due, hence a far-future fixed clock rather than an arbitrary past date.
    const service = new NotificationsService(fixedClock("2999-01-01T00:00:00.000Z"));
    await pool.query(
      `INSERT INTO outbox_events (aggregate_type, event_type, payload, dedupe_key, status, attempts, next_attempt_at)
       VALUES ('reminder', 'recoverable', '{}', 'dead-1', 'dead_letter', 8, now())`
    );
    const { rows } = await pool.query(`SELECT id FROM outbox_events WHERE dedupe_key = 'dead-1'`);
    await service.replayDeadLetter(rows[0].id);

    let succeeded = false;
    await service.dispatchDue({ recoverable: async () => void (succeeded = true) });
    expect(succeeded).toBe(true);
    const { rows: after } = await pool.query(`SELECT status FROM outbox_events WHERE dedupe_key = 'dead-1'`);
    expect(after[0].status).toBe("done");
  });
});
