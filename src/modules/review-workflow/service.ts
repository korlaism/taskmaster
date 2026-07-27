import type { AuditService } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { PolicyEngine, ReviewRequest, ReviewState } from "./domain.js";
import * as repo from "./repository.js";

export class ReviewWorkflowService {
  constructor(
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
    private readonly policyEngine: PolicyEngine
  ) {}

  /** "Request review for SIM40-1234 from Lead Name" — the command/button both resolve to this. */
  async requestReview(params: {
    organizationId: string;
    requesterId: string;
    reviewerId: string;
    jiraIssueKey: string;
    pullRequestId?: string;
    branchName?: string;
    commitSha?: string;
    requesterNote?: string;
    idempotencyKey: string;
  }): Promise<ReviewRequest> {
    await this.identity.requireEnabled(params.requesterId);
    await this.identity.requireRole(params.reviewerId, "lead");

    const request = await repo.createReviewRequest({
      organizationId: params.organizationId,
      requesterId: params.requesterId,
      reviewerId: params.reviewerId,
      jiraIssueKey: params.jiraIssueKey,
      pullRequestId: params.pullRequestId ?? null,
      branchName: params.branchName ?? null,
      commitSha: params.commitSha ?? null,
      requesterNote: params.requesterNote ?? null,
      idempotencyKey: params.idempotencyKey,
    });

    await this.audit.record({
      organizationId: params.organizationId,
      actorUserId: params.requesterId,
      action: "review_request.create",
      targetType: "review_request",
      targetId: request.id,
      details: { jiraIssueKey: params.jiraIssueKey, reviewerId: params.reviewerId },
    });
    return request;
  }

  /** Acknowledge / approve / request-changes — always a recorded human decision.
   * evaluateAutoApproval is consulted for future auto-approval eligibility but its
   * result is informational only in V1 (always false) and never substitutes for this call. */
  async recordDecision(params: {
    organizationId: string;
    reviewId: string;
    actingUserId: string;
    decision: ReviewState;
  }): Promise<void> {
    await this.identity.requireRole(params.actingUserId, "lead");
    const request = await repo.getById(params.reviewId);
    if (!request) throw new Error("review request not found");

    await this.policyEngine.evaluateAutoApproval({ reviewRequest: request }); // logged for future use, never trusted

    await repo.setState(params.reviewId, params.decision);
    await this.audit.record({
      organizationId: params.organizationId,
      actorUserId: params.actingUserId,
      action: `review_request.${params.decision}`,
      targetType: "review_request",
      targetId: params.reviewId,
    });
  }
}
