import { query } from "../../shared/db.js";
import type { ReportingWindow } from "./domain.js";

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ count: string }>(sql, params);
  return Number(rows[0]?.count ?? 0);
}

/** Ticket picked: assigned, or transitioned not_started -> active, within the window. */
export async function countTicketsPicked(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(DISTINCT jie.jira_issue_id) AS count
     FROM jira_issue_events jie
     JOIN jira_issues ji ON ji.id = jie.jira_issue_id
     WHERE ji.organization_id = $1 AND jie.occurred_at >= $2 AND jie.occurred_at < $3
       AND (
         jie.event_type = 'assigned'
         OR (
           jie.event_type = 'status_changed'
           AND EXISTS (SELECT 1 FROM jira_status_mappings sm WHERE sm.project_id = ji.project_id AND sm.raw_status = jie.from_value AND sm.bucket = 'not_started')
           AND EXISTS (SELECT 1 FROM jira_status_mappings sm WHERE sm.project_id = ji.project_id AND sm.raw_status = jie.to_value AND sm.bucket = 'active')
         )
       )`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}

/** Ticket closed: transitioned into a configured Done-bucket status within the window. */
export async function countTicketsClosed(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(DISTINCT jie.jira_issue_id) AS count
     FROM jira_issue_events jie
     JOIN jira_issues ji ON ji.id = jie.jira_issue_id
     WHERE ji.organization_id = $1 AND jie.occurred_at >= $2 AND jie.occurred_at < $3
       AND jie.event_type = 'status_changed'
       AND EXISTS (SELECT 1 FROM jira_status_mappings sm WHERE sm.project_id = ji.project_id AND sm.raw_status = jie.to_value AND sm.bucket = 'done')`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}

/** Ticket created: Jira creation timestamp within the window (not a derived event). */
export async function countTicketsCreated(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(*) AS count FROM jira_issues
     WHERE organization_id = $1 AND created_at_jira >= $2 AND created_at_jira < $3`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}

/** QA ticket created: routed through the Teams QA workflow, within the window. */
export async function countQaTicketsCreated(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(*) AS count FROM qa_ticket_requests
     WHERE organization_id = $1 AND status = 'created' AND created_at >= $2 AND created_at < $3`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}

/** In QA: current-state snapshot (not window-bounded) — status belongs to the configured QA bucket. */
export async function countTicketsInQa(organizationId: string): Promise<number> {
  return count(
    `SELECT COUNT(DISTINCT ji.id) AS count
     FROM jira_issues ji
     JOIN jira_status_mappings sm ON sm.project_id = ji.project_id AND sm.raw_status = ji.current_status
     WHERE ji.organization_id = $1 AND sm.bucket = 'qa'`,
    [organizationId]
  );
}

/** Pending approval: Jira status in the approval bucket, or an open PR lacking an approved review. */
export async function countItemsPendingApproval(organizationId: string): Promise<number> {
  const jiraPending = await count(
    `SELECT COUNT(DISTINCT ji.id) AS count
     FROM jira_issues ji
     JOIN jira_status_mappings sm ON sm.project_id = ji.project_id AND sm.raw_status = ji.current_status
     WHERE ji.organization_id = $1 AND sm.bucket = 'approval'`,
    [organizationId]
  );
  const prPending = await count(
    `SELECT COUNT(DISTINCT pr.id) AS count
     FROM pull_requests pr
     JOIN repositories r ON r.id = pr.repository_id
     WHERE r.organization_id = $1 AND pr.state = 'open'
       AND NOT EXISTS (SELECT 1 FROM pull_request_reviews prr WHERE prr.pull_request_id = pr.id AND prr.state = 'approved')`,
    [organizationId]
  );
  return jiraPending + prPending;
}

/** Commit pushed: unique (repository, sha), excluding merge commits so they aren't
 * double-counted when they surface via both a push event and a PR-merge event. */
export async function countCommitsPushed(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(DISTINCT c.id) AS count
     FROM commits c
     JOIN repositories r ON r.id = c.repository_id
     WHERE r.organization_id = $1 AND c.authored_at >= $2 AND c.authored_at < $3 AND c.is_merge = FALSE`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}

export async function countPrsOpened(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(*) AS count FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id
     WHERE r.organization_id = $1 AND pr.opened_at >= $2 AND pr.opened_at < $3`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}

export async function countPrsMerged(w: ReportingWindow): Promise<number> {
  return count(
    `SELECT COUNT(*) AS count FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id
     WHERE r.organization_id = $1 AND pr.merged_at >= $2 AND pr.merged_at < $3`,
    [w.organizationId, w.windowStart, w.windowEnd]
  );
}
