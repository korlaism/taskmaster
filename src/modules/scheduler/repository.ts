import type { PoolClient } from "pg";
import { pool, query } from "../../shared/db.js";
import type { NotificationJob, NotificationJobType } from "./domain.js";

interface JobRow {
  id: string;
  organization_id: string;
  job_type: NotificationJobType;
  subject_user_id: string | null;
  scheduled_for: Date;
  status: NotificationJob["status"];
  attempt_count: number;
}

function toDomain(row: JobRow): NotificationJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    jobType: row.job_type,
    subjectUserId: row.subject_user_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    attemptCount: row.attempt_count,
  };
}

/** Idempotent: a repeated call for the same (org, job type, subject, instant) is a no-op
 * thanks to the unique dedupe_key constraint — this is what lets "ensure today's jobs
 * exist" run on every tick without ever double-scheduling. */
export async function ensureJobScheduled(params: {
  organizationId: string;
  jobType: NotificationJobType;
  subjectUserId: string | null;
  scheduledFor: Date;
  dedupeKey: string;
}): Promise<void> {
  await query(
    `INSERT INTO notification_jobs (organization_id, job_type, subject_user_id, scheduled_for, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [params.organizationId, params.jobType, params.subjectUserId, params.scheduledFor, params.dedupeKey]
  );
}

/**
 * Claims due jobs using SELECT ... FOR UPDATE SKIP LOCKED so that when multiple worker
 * instances tick concurrently, each due job is claimed by exactly one of them — no
 * distributed lock service required.
 */
export async function claimDueJobs(now: Date, workerId: string, limit: number): Promise<NotificationJob[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<JobRow>(
      `SELECT * FROM notification_jobs
       WHERE status = 'pending' AND scheduled_for <= $1
       ORDER BY scheduled_for ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit]
    );
    if (rows.length > 0) {
      await client.query(
        `UPDATE notification_jobs SET status = 'claimed', claimed_at = $1, claimed_by = $2
         WHERE id = ANY($3::uuid[])`,
        [now, workerId, rows.map((r) => r.id)]
      );
    }
    await client.query("COMMIT");
    return rows.map(toDomain);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Lease-expiry recovery: a job stuck in 'claimed' past the lease window means the
 * worker that claimed it died before finishing — hand it back to the pending pool
 * instead of leaving it stuck forever. */
export async function reclaimStaleClaims(staleBefore: Date): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notification_jobs SET status = 'pending', claimed_at = NULL, claimed_by = NULL
     WHERE status = 'claimed' AND claimed_at < $1
     RETURNING id`,
    [staleBefore]
  );
  return rows.length;
}

export async function markJobDone(jobId: string): Promise<void> {
  await query(`UPDATE notification_jobs SET status = 'done' WHERE id = $1`, [jobId]);
}

export async function markJobFailed(jobId: string, error: string, maxAttempts: number): Promise<void> {
  await query(
    `UPDATE notification_jobs
     SET attempt_count = attempt_count + 1,
         last_error = $2,
         status = CASE WHEN attempt_count + 1 >= $3 THEN 'dead_letter' ELSE 'pending' END
     WHERE id = $1`,
    [jobId, error, maxAttempts]
  );
}

export async function replayDeadLetter(jobId: string): Promise<void> {
  await query(
    `UPDATE notification_jobs SET status = 'pending', attempt_count = 0, last_error = NULL WHERE id = $1`,
    [jobId]
  );
}
