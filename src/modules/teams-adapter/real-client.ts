import type { App } from "@microsoft/teams.apps";
import type { AdaptiveCardPayload, ConversationReference, SendResult, TeamsClient } from "./domain.js";

/**
 * Real Teams client — wraps @microsoft/teams.apps' `App.send`, the SDK confirmed
 * current via its npm listing and Microsoft Learn docs (aka.ms/teams-sdk-ts) while
 * building this adapter. This is the file `LocalSimTeamsClient` was always meant to
 * be replaced by (see ADR-5, docs/01).
 *
 * IMPORTANT: this class is implemented against the SDK's published type declarations
 * and documented behavior, but has not been exercised against a live Microsoft 365
 * tenant — no Entra app registration / Azure Bot resource was available while writing
 * it (see docs/02-teams-permissions-and-installation.md for the registration steps
 * and what to verify once real credentials exist). In particular, the error-shape
 * checks in `classifyError` are a best-effort mapping across a few plausible HTTP
 * client error shapes, not something confirmed against a real 403/404/429 response.
 */
export class TeamsAppClient implements TeamsClient {
  constructor(private readonly app: App) {}

  async sendPersonalMessage(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult> {
    return this.send(ref, card);
  }

  async sendChannelMessage(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult> {
    return this.send(ref, card);
  }

  private async send(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult> {
    try {
      // The SDK accepts a raw Adaptive Card JSON object directly as the activity to
      // send (per the Teams SDK "Building Adaptive Cards" guide's `await send(card)`
      // form) — no MessageActivity wrapping needed for a card-only message.
      await this.app.send(ref.conversationId, card as never);
      return { ok: true };
    } catch (err) {
      return { ok: false, ...this.classifyError(err) };
    }
  }

  private classifyError(err: unknown): Omit<Extract<SendResult, { ok: false }>, "ok"> {
    const e = err as { status?: number; statusCode?: number; response?: { status?: number } } & Error;
    const status = e?.status ?? e?.statusCode ?? e?.response?.status;
    const detail = e?.message ?? String(err);

    if (status === 403) return { kind: "blocked", detail };
    if (status === 404 || status === 410) return { kind: "not_installed", detail };
    if (status === 429) return { kind: "throttled", detail };
    return { kind: "transient_error", detail };
  }
}
