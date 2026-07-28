import { query } from "../../shared/db.js";
import type { ReviewRequest, ReviewState } from "./domain.js";

interface ReviewRequestRow {
  id: string;
  organization_id: string;
  requester_id: string;
  reviewer_id: string;
  jira_issue_key: string;
  pull_request_id: string | null;
  pull_request_url: string | null;
  branch_name: string | null;
  commit_sha: string | null;
  requester_note: string | null;
  state: ReviewState;
  requested_at: Date;
  responded_at: Date | null;
}

function toDomain(row: ReviewRequestRow): ReviewRequest {
  return {
    id: row.id,
    organizationId: row.organization_id,
    requesterId: row.requester_id,
    reviewerId: row.reviewer_id,
    jiraIssueKey: row.jira_issue_key,
    pullRequestId: row.pull_request_id,
    pullRequestUrl: row.pull_request_url,
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    requesterNote: row.requester_note,
    state: row.state,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
  };
}

export async function createReviewRequest(params: {
  organizationId: string;
  requesterId: string;
  reviewerId: string;
  jiraIssueKey: string;
  pullRequestId: string | null;
  pullRequestUrl: string | null;
  branchName: string | null;
  commitSha: string | null;
  requesterNote: string | null;
  idempotencyKey: string;
}): Promise<{ request: ReviewRequest; isNew: boolean }> {
  const inserted = await query<ReviewRequestRow>(
    `INSERT INTO review_requests
       (organization_id, requester_id, reviewer_id, jira_issue_key, pull_request_id, pull_request_url, branch_name, commit_sha, requester_note, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      params.organizationId,
      params.requesterId,
      params.reviewerId,
      params.jiraIssueKey,
      params.pullRequestId,
      params.pullRequestUrl,
      params.branchName,
      params.commitSha,
      params.requesterNote,
      params.idempotencyKey,
    ]
  );
  if (inserted[0]) return { request: toDomain(inserted[0]), isNew: true };
  const existing = await query<ReviewRequestRow>(`SELECT * FROM review_requests WHERE idempotency_key = $1`, [
    params.idempotencyKey,
  ]);
  return { request: toDomain(existing[0]!), isNew: false };
}

export async function setState(id: string, state: ReviewState): Promise<void> {
  await query(`UPDATE review_requests SET state = $2, responded_at = now() WHERE id = $1`, [id, state]);
}

export async function getById(id: string): Promise<ReviewRequest | undefined> {
  const rows = await query<ReviewRequestRow>(`SELECT * FROM review_requests WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : undefined;
}

/** Requested more than `olderThanMs` ago and still awaiting a decision — feeds the
 * digest's "stale review requests" attention-required section. */
export async function listStale(organizationId: string, olderThanMs: number): Promise<ReviewRequest[]> {
  const rows = await query<ReviewRequestRow>(
    `SELECT * FROM review_requests
     WHERE organization_id = $1 AND state = 'requested' AND requested_at < now() - ($2 || ' milliseconds')::interval`,
    [organizationId, olderThanMs]
  );
  return rows.map(toDomain);
}
