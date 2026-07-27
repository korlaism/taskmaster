import { pool, query } from "../../shared/db.js";
import type { SubmissionInput, SubmissionStatus, UpdateCycle, UpdateSubmission } from "./domain.js";

interface CycleRow {
  id: string;
  organization_id: string;
  cycle_date: string;
  window_start: Date;
  window_end: Date;
  cutoff_at: Date;
  digest_publish_at: Date;
}

function cycleToDomain(row: CycleRow): UpdateCycle {
  return {
    id: row.id,
    organizationId: row.organization_id,
    cycleDate: row.cycle_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    cutoffAt: row.cutoff_at,
    digestPublishAt: row.digest_publish_at,
  };
}

export async function ensureCycle(params: {
  organizationId: string;
  cycleDate: string;
  windowStart: Date;
  windowEnd: Date;
  cutoffAt: Date;
  digestPublishAt: Date;
}): Promise<UpdateCycle> {
  const inserted = await query<CycleRow>(
    `INSERT INTO update_cycles (organization_id, cycle_date, window_start, window_end, cutoff_at, digest_publish_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, cycle_date) DO NOTHING
     RETURNING *`,
    [params.organizationId, params.cycleDate, params.windowStart, params.windowEnd, params.cutoffAt, params.digestPublishAt]
  );
  if (inserted[0]) return cycleToDomain(inserted[0]);

  const existing = await query<CycleRow>(
    `SELECT * FROM update_cycles WHERE organization_id = $1 AND cycle_date = $2`,
    [params.organizationId, params.cycleDate]
  );
  return cycleToDomain(existing[0]!);
}

export async function getCycleById(cycleId: string): Promise<UpdateCycle | undefined> {
  const rows = await query<CycleRow>(`SELECT * FROM update_cycles WHERE id = $1`, [cycleId]);
  return rows[0] ? cycleToDomain(rows[0]) : undefined;
}

export async function getCycleByDate(organizationId: string, cycleDate: string): Promise<UpdateCycle | undefined> {
  const rows = await query<CycleRow>(`SELECT * FROM update_cycles WHERE organization_id = $1 AND cycle_date = $2`, [
    organizationId,
    cycleDate,
  ]);
  return rows[0] ? cycleToDomain(rows[0]) : undefined;
}

interface SubmissionRow {
  id: string;
  cycle_id: string;
  user_id: string;
  status: SubmissionStatus;
  skip_reason: string | null;
  completed_today: string | null;
  in_progress: string | null;
  blockers: string | null;
  next_planned: string | null;
  review_required: boolean;
  additional_notes: string | null;
  idempotency_key: string;
  submitted_at: Date | null;
}

function submissionToDomain(row: SubmissionRow): UpdateSubmission {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    userId: row.user_id,
    status: row.status,
    skipReason: row.skip_reason,
    completedToday: row.completed_today,
    inProgress: row.in_progress,
    blockers: row.blockers,
    nextPlanned: row.next_planned,
    reviewRequired: row.review_required,
    additionalNotes: row.additional_notes,
    idempotencyKey: row.idempotency_key,
    submittedAt: row.submitted_at,
  };
}

export async function getSubmission(cycleId: string, userId: string): Promise<UpdateSubmission | undefined> {
  const rows = await query<SubmissionRow>(`SELECT * FROM update_submissions WHERE cycle_id = $1 AND user_id = $2`, [
    cycleId,
    userId,
  ]);
  return rows[0] ? submissionToDomain(rows[0]) : undefined;
}

/**
 * Idempotent + revisable in one statement: the `WHERE idempotency_key IS DISTINCT FROM`
 * guard means a retried submit carrying the *same* idempotency key updates nothing
 * (RETURNING yields no row, callers fall back to reading the existing row back), while
 * a submit carrying a *new* key (a genuine revision) updates the single row for this
 * (cycle, user) in place. This is the database-constraint-backed idempotency the
 * product spec asks for, not an app-level check-then-insert race.
 */
export async function upsertSubmission(
  input: SubmissionInput
): Promise<{ submission: UpdateSubmission; isNewRevision: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const submittedAt = input.status === "submitted" ? new Date() : null;
    const { rows } = await client.query<SubmissionRow>(
      `INSERT INTO update_submissions
         (cycle_id, user_id, status, skip_reason, completed_today, in_progress, blockers, next_planned,
          review_required, additional_notes, idempotency_key, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (cycle_id, user_id) DO UPDATE SET
         status = EXCLUDED.status,
         skip_reason = EXCLUDED.skip_reason,
         completed_today = EXCLUDED.completed_today,
         in_progress = EXCLUDED.in_progress,
         blockers = EXCLUDED.blockers,
         next_planned = EXCLUDED.next_planned,
         review_required = EXCLUDED.review_required,
         additional_notes = EXCLUDED.additional_notes,
         idempotency_key = EXCLUDED.idempotency_key,
         submitted_at = EXCLUDED.submitted_at,
         updated_at = now()
       WHERE update_submissions.idempotency_key IS DISTINCT FROM EXCLUDED.idempotency_key
       RETURNING *`,
      [
        input.cycleId,
        input.userId,
        input.status,
        input.skipReason ?? null,
        input.completedToday ?? null,
        input.inProgress ?? null,
        input.blockers ?? null,
        input.nextPlanned ?? null,
        input.reviewRequired ?? false,
        input.additionalNotes ?? null,
        input.idempotencyKey,
        submittedAt,
      ]
    );

    if (rows.length === 0) {
      // Same idempotency key as the row already on file: a retried submit, not a revision.
      const existing = await client.query<SubmissionRow>(
        `SELECT * FROM update_submissions WHERE cycle_id = $1 AND user_id = $2`,
        [input.cycleId, input.userId]
      );
      await client.query("COMMIT");
      return { submission: submissionToDomain(existing.rows[0]!), isNewRevision: false };
    }

    if (input.jiraIssueKeys) {
      await client.query(`DELETE FROM update_submission_items WHERE submission_id = $1`, [rows[0]!.id]);
      for (const key of input.jiraIssueKeys) {
        await client.query(
          `INSERT INTO update_submission_items (submission_id, jira_issue_key, selected, source)
           VALUES ($1, $2, TRUE, 'manual')
           ON CONFLICT (submission_id, jira_issue_key) DO NOTHING`,
          [rows[0]!.id, key]
        );
      }
    }

    await client.query("COMMIT");
    return { submission: submissionToDomain(rows[0]!), isNewRevision: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listSubmissionItems(submissionId: string): Promise<string[]> {
  const rows = await query<{ jira_issue_key: string }>(
    `SELECT jira_issue_key FROM update_submission_items WHERE submission_id = $1 AND selected = TRUE`,
    [submissionId]
  );
  return rows.map((r) => r.jira_issue_key);
}

export async function listSubmissionsForCycle(cycleId: string): Promise<UpdateSubmission[]> {
  const rows = await query<SubmissionRow>(`SELECT * FROM update_submissions WHERE cycle_id = $1`, [cycleId]);
  return rows.map(submissionToDomain);
}
