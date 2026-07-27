import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { MetricsService } from "../../src/modules/metrics/index.js";
import { pool } from "../../src/shared/db.js";
import { resetDatabase } from "../support/reset-db.js";
import { seedOrganization } from "../support/seed.js";

const WINDOW_START = new Date("2026-01-15T14:00:00.000Z"); // yesterday's cutoff (09:00 EST)
const WINDOW_END = new Date("2026-01-16T14:00:00.000Z"); // today's cutoff

async function makeProject(key: string, statusMap: Record<string, string>) {
  const { rows } = await pool.query(
    `INSERT INTO jira_projects (organization_id, jira_project_key) VALUES ($1, $2) RETURNING id`,
    [env.ORG_ID, key]
  );
  const projectId = rows[0].id;
  for (const [rawStatus, bucket] of Object.entries(statusMap)) {
    await pool.query(`INSERT INTO jira_status_mappings (project_id, raw_status, bucket) VALUES ($1, $2, $3)`, [
      projectId,
      rawStatus,
      bucket,
    ]);
  }
  return projectId;
}

async function makeIssue(projectId: string, key: string, status: string, createdAt: Date) {
  const { rows } = await pool.query(
    `INSERT INTO jira_issues (organization_id, jira_issue_id, issue_key, project_id, current_status, created_at_jira, updated_at_jira)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
    [env.ORG_ID, key, key, projectId, status, createdAt]
  );
  return rows[0].id;
}

async function addEvent(issueId: string, eventType: string, from: string | null, to: string | null, occurredAt: Date) {
  await pool.query(
    `INSERT INTO jira_issue_events (jira_issue_id, event_type, from_value, to_value, occurred_at, source)
     VALUES ($1, $2, $3, $4, $5, 'webhook')`,
    [issueId, eventType, from, to, occurredAt]
  );
}

describe("metrics: deterministic, status-mapping-driven, window-bounded", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("counts tickets picked/closed correctly across two projects with different workflow status names", async () => {
    // Project ALPHA calls its terminal state "Done"; project BETA calls its terminal state "Closed".
    // Both must count toward ticketsClosed once mapped to the 'done' bucket.
    const alpha = await makeProject("ALPHA", { "To Do": "not_started", "In Progress": "active", Done: "done" });
    const beta = await makeProject("BETA", { Backlog: "not_started", Doing: "active", Closed: "done" });

    const alphaIssue = await makeIssue(alpha, "ALPHA-1", "Done", new Date("2026-01-10T00:00:00.000Z"));
    await addEvent(alphaIssue, "status_changed", "To Do", "In Progress", new Date("2026-01-15T15:00:00.000Z")); // picked, in-window
    await addEvent(alphaIssue, "status_changed", "In Progress", "Done", new Date("2026-01-15T18:00:00.000Z")); // closed, in-window

    const betaIssue = await makeIssue(beta, "BETA-1", "Closed", new Date("2026-01-10T00:00:00.000Z"));
    await addEvent(betaIssue, "status_changed", "Backlog", "Doing", new Date("2026-01-15T16:00:00.000Z")); // picked
    await addEvent(betaIssue, "status_changed", "Doing", "Closed", new Date("2026-01-15T20:00:00.000Z")); // closed

    const metrics = new MetricsService();
    const summary = await metrics.computeExecutiveSummary(
      { organizationId: env.ORG_ID, windowStart: WINDOW_START, windowEnd: WINDOW_END },
      2,
      []
    );

    expect(summary.ticketsPicked).toBe(2);
    expect(summary.ticketsClosed).toBe(2);
  });

  it("excludes a status change that lands exactly on the window boundary (window end is exclusive)", async () => {
    const proj = await makeProject("SIM40", { "To Do": "not_started", Done: "done" });
    const issue = await makeIssue(proj, "SIM40-1", "Done", new Date("2026-01-10T00:00:00.000Z"));

    await addEvent(issue, "status_changed", "To Do", "Done", WINDOW_END); // exactly at cutoff -> next cycle, not this one
    const inWindow = await makeIssue(proj, "SIM40-2", "Done", new Date("2026-01-10T00:00:00.000Z"));
    await addEvent(inWindow, "status_changed", "To Do", "Done", new Date(WINDOW_END.getTime() - 1)); // 1ms before cutoff

    const metrics = new MetricsService();
    const summary = await metrics.computeExecutiveSummary(
      { organizationId: env.ORG_ID, windowStart: WINDOW_START, windowEnd: WINDOW_END },
      1,
      []
    );
    expect(summary.ticketsClosed).toBe(1);
  });

  it("counts commits once, excluding merge commits from the count", async () => {
    const conn = await pool.query(
      `INSERT INTO git_connections (organization_id, provider) VALUES ($1, 'github') RETURNING id`,
      [env.ORG_ID]
    );
    const repo = await pool.query(
      `INSERT INTO repositories (organization_id, git_connection_id, provider_repo_id, full_name) VALUES ($1, $2, 'r1', 'org/repo') RETURNING id`,
      [env.ORG_ID, conn.rows[0].id]
    );
    const repositoryId = repo.rows[0].id;

    await pool.query(
      `INSERT INTO commits (repository_id, sha, authored_at, is_merge) VALUES ($1, 'sha1', $2, FALSE)`,
      [repositoryId, new Date("2026-01-15T16:00:00.000Z")]
    );
    await pool.query(
      `INSERT INTO commits (repository_id, sha, authored_at, is_merge) VALUES ($1, 'sha2', $2, FALSE)`,
      [repositoryId, new Date("2026-01-15T17:00:00.000Z")]
    );
    // A merge commit surfacing via both a push event and a PR-merge event should still
    // be a single row (unique repository_id+sha) and excluded from the push count.
    await pool.query(
      `INSERT INTO commits (repository_id, sha, authored_at, is_merge) VALUES ($1, 'merge-sha', $2, TRUE)
       ON CONFLICT (repository_id, sha) DO NOTHING`,
      [repositoryId, new Date("2026-01-15T18:00:00.000Z")]
    );
    await pool.query(
      `INSERT INTO commits (repository_id, sha, authored_at, is_merge) VALUES ($1, 'merge-sha', $2, TRUE)
       ON CONFLICT (repository_id, sha) DO NOTHING`,
      [repositoryId, new Date("2026-01-15T18:00:00.000Z")]
    );

    const metrics = new MetricsService();
    const summary = await metrics.computeExecutiveSummary(
      { organizationId: env.ORG_ID, windowStart: WINDOW_START, windowEnd: WINDOW_END },
      1,
      []
    );
    expect(summary.commitsPushed).toBe(2);

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM commits WHERE repository_id = $1`, [
      repositoryId,
    ]);
    expect(rows[0].count).toBe(3); // 2 regular + 1 deduped merge row, not 4
  });
});
