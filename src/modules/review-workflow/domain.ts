export type ReviewState = "requested" | "acknowledged" | "approved" | "changes_requested";

export interface ReviewRequest {
  id: string;
  organizationId: string;
  requesterId: string;
  reviewerId: string;
  jiraIssueKey: string;
  pullRequestId: string | null;
  /** Raw PR URL, supplied directly by the requester — a stand-in until the
   * git-integration ingestion pipeline (Phase 5, docs/09) populates pull_request_id
   * from real webhook data. */
  pullRequestUrl: string | null;
  branchName: string | null;
  commitSha: string | null;
  requesterNote: string | null;
  state: ReviewState;
  requestedAt: Date;
  respondedAt: Date | null;
}

export interface PolicyContext {
  reviewRequest: ReviewRequest;
  checks?: { name: string; state: "success" | "failure" | "pending" }[];
}

/**
 * The seam for a future policy/AI-assist engine. V1 ships only NoopPolicyEngine:
 * evaluateAutoApproval always false (per product requirement — the LLM/policy layer
 * is never the source of truth for approval), and the other two are unimplemented
 * placeholders a later phase fills in.
 */
export interface PolicyEngine {
  evaluateAutoApproval(context: PolicyContext): Promise<boolean>;
  produceReviewRecommendation(context: PolicyContext): Promise<string | null>;
  executeApproval(context: PolicyContext): Promise<void>;
}

export class NoopPolicyEngine implements PolicyEngine {
  async evaluateAutoApproval(): Promise<boolean> {
    return false;
  }
  async produceReviewRecommendation(): Promise<string | null> {
    return null;
  }
  async executeApproval(): Promise<void> {
    throw new Error("executeApproval is not implemented in V1 — approval is human-only and recorded, never executed automatically");
  }
}
