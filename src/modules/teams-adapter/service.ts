import { childLogger } from "../../shared/logger.js";
import type { AdaptiveCardPayload, ConversationSubjectType, SendResult, TeamsClient } from "./domain.js";
import * as repo from "./repository.js";

const log = childLogger({ module: "teams-adapter" });

export interface DeliveryOutcome {
  delivered: boolean;
  /** Present when delivered=false; distinguishes "retry later" from "give up". */
  reason?: "no_conversation_reference" | "blocked" | "not_installed" | "throttled" | "transient_error";
  retryable: boolean;
}

export class TeamsAdapterService {
  constructor(private readonly client: TeamsClient) {}

  async captureConversationReference(params: {
    organizationId: string;
    subjectType: ConversationSubjectType;
    subjectId: string;
    serviceUrl: string;
    conversationId: string;
    tenantId: string;
  }): Promise<void> {
    await repo.upsertConversationReference({
      organizationId: params.organizationId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      serviceUrl: params.serviceUrl,
      conversationId: params.conversationId,
      tenantId: params.tenantId,
      isValid: true,
    });
  }

  async sendPersonalCard(
    organizationId: string,
    userId: string,
    card: AdaptiveCardPayload
  ): Promise<DeliveryOutcome> {
    return this.send(organizationId, "user", userId, card, (ref) => this.client.sendPersonalMessage(ref, card));
  }

  async sendChannelCard(
    organizationId: string,
    channelId: string,
    card: AdaptiveCardPayload
  ): Promise<DeliveryOutcome> {
    return this.send(organizationId, "channel", channelId, card, (ref) => this.client.sendChannelMessage(ref, card));
  }

  private async send(
    organizationId: string,
    subjectType: ConversationSubjectType,
    subjectId: string,
    _card: AdaptiveCardPayload,
    doSend: (ref: NonNullable<Awaited<ReturnType<typeof repo.getConversationReference>>>) => Promise<SendResult>
  ): Promise<DeliveryOutcome> {
    const ref = await repo.getConversationReference(organizationId, subjectType, subjectId);
    if (!ref || !ref.isValid) {
      log.warn({ organizationId, subjectType, subjectId }, "no valid conversation reference; failing gracefully");
      return { delivered: false, reason: "no_conversation_reference", retryable: false };
    }

    const result = await doSend(ref);
    if (result.ok) return { delivered: true, retryable: false };

    log.warn({ organizationId, subjectType, subjectId, kind: result.kind }, "teams delivery failed");
    if (result.kind === "blocked" || result.kind === "not_installed") {
      await repo.markConversationReferenceInvalid(organizationId, subjectType, subjectId);
      return { delivered: false, reason: result.kind, retryable: false };
    }
    // 'throttled' and 'transient_error' are retryable by the outbox dispatcher's backoff.
    return { delivered: false, reason: result.kind, retryable: true };
  }
}
