import type { AdaptiveCardPayload, ConversationReference, SendResult, TeamsClient } from "./domain.js";

interface DeliveredCard {
  card: AdaptiveCardPayload;
  deliveredAt: string;
}

/**
 * Stands in for a real Teams client so the vertical slice runs without a live M365
 * tenant. Cards are held in memory and exposed to a "fake Teams client" (a script,
 * curl, or the local-sim HTTP router) so the full round trip — send card, user acts
 * on it, workflow continues — can be exercised end to end locally.
 *
 * This is the single file a real Teams SDK integration replaces; nothing outside
 * teams-adapter should ever import it directly.
 */
export class LocalSimTeamsClient implements TeamsClient {
  private readonly inbox = new Map<string, DeliveredCard>();
  private readonly forcedFailures = new Map<string, SendResult>();

  /** Test/demo hook: force the next send to a subject to fail in a specific way
   * (e.g. simulate a user who blocked the bot, or a Teams 429). */
  forceNextFailure(subjectId: string, result: Extract<SendResult, { ok: false }>) {
    this.forcedFailures.set(subjectId, result);
  }

  async sendPersonalMessage(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult> {
    return this.deliver(ref, card);
  }

  async sendChannelMessage(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult> {
    return this.deliver(ref, card);
  }

  private async deliver(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult> {
    const forced = this.forcedFailures.get(ref.subjectId);
    if (forced) {
      this.forcedFailures.delete(ref.subjectId);
      return forced;
    }
    this.inbox.set(ref.subjectId, { card, deliveredAt: new Date().toISOString() });
    return { ok: true };
  }

  /** Local-sim inspection API — not part of the TeamsClient contract. */
  getLastCard(subjectId: string): DeliveredCard | undefined {
    return this.inbox.get(subjectId);
  }
}
