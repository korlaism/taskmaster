import { pool, query } from "../../shared/db.js";
import type { OutboxAggregateType, OutboxEvent } from "./domain.js";

interface OutboxRow {
  id: string;
  aggregate_type: OutboxAggregateType;
  aggregate_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: OutboxEvent["status"];
  attempts: number;
}

function toDomain(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
  };
}

/** Idempotent enqueue: retried callers (e.g. a scheduler tick re-run after a crash)
 * never create a second outbox row for the same logical event. */
export async function enqueue(params: {
  aggregateType: OutboxAggregateType;
  aggregateId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}): Promise<void> {
  await query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [params.aggregateType, params.aggregateId, params.eventType, JSON.stringify(params.payload), params.dedupeKey]
  );
}

export async function claimDue(now: Date, limit: number): Promise<OutboxEvent[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OutboxRow>(
      `SELECT * FROM outbox_events
       WHERE status = 'pending' AND next_attempt_at <= $1
       ORDER BY next_attempt_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit]
    );
    if (rows.length > 0) {
      await client.query(`UPDATE outbox_events SET status = 'processing' WHERE id = ANY($1::uuid[])`, [
        rows.map((r) => r.id),
      ]);
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

export async function markDone(id: string): Promise<void> {
  await query(`UPDATE outbox_events SET status = 'done' WHERE id = $1`, [id]);
}

export async function markFailed(
  id: string,
  error: string,
  nextAttemptAt: Date,
  maxAttempts: number
): Promise<void> {
  await query(
    `UPDATE outbox_events
     SET attempts = attempts + 1,
         last_error = $2,
         next_attempt_at = $3,
         status = CASE WHEN attempts + 1 >= $4 THEN 'dead_letter' ELSE 'pending' END
     WHERE id = $1`,
    [id, error, nextAttemptAt, maxAttempts]
  );
}

export async function replayDeadLetter(id: string): Promise<void> {
  await query(
    `UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
     WHERE id = $1`,
    [id]
  );
}

export async function listDeadLetters(): Promise<OutboxEvent[]> {
  const rows = await query<OutboxRow>(`SELECT * FROM outbox_events WHERE status = 'dead_letter'`);
  return rows.map(toDomain);
}
