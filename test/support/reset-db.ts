import { pool } from "../../src/shared/db.js";

// Every app table except the static `roles` seed table, which migrations populate once
// and application code never mutates.
const TABLES = [
  "organization_holidays",
  "user_roles",
  "user_preferences",
  "external_identities",
  "teams_installations",
  "conversation_references",
  "jira_connections",
  "jira_status_mappings",
  "jira_issue_events",
  "jira_issues",
  "jira_projects",
  "git_connections",
  "pull_request_reviews",
  "pull_requests",
  "commits",
  "repositories",
  "update_submission_items",
  "update_submissions",
  "update_cycles",
  "review_requests",
  "qa_ticket_requests",
  "notification_jobs",
  "outbox_events",
  "digest_snapshots",
  "audit_events",
  "integration_failures",
  "users",
  "organizations",
];

export async function resetDatabase(): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}
