export type ConversationSubjectType = "user" | "channel";

export interface ConversationReference {
  organizationId: string;
  subjectType: ConversationSubjectType;
  subjectId: string;
  serviceUrl: string;
  conversationId: string;
  tenantId: string;
  isValid: boolean;
}

/** Adaptive Card payload — kept as an opaque JSON object here; card *shape* for the
 * daily-update card lives in daily-updates (the module that knows its schema). */
export type AdaptiveCardPayload = Record<string, unknown>;

export type SendResult =
  | { ok: true }
  | { ok: false; kind: "blocked" | "not_installed" | "throttled" | "transient_error"; detail?: string };

/**
 * The seam a real Teams SDK client implements. Isolating this interface is what lets
 * the concrete SDK package (currently in flux — see docs/02-permissions-and-installation.md)
 * be swapped without touching any workflow module.
 */
export interface TeamsClient {
  sendPersonalMessage(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult>;
  sendChannelMessage(ref: ConversationReference, card: AdaptiveCardPayload): Promise<SendResult>;
}
