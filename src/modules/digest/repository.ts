import { query } from "../../shared/db.js";
import type { DigestContent } from "./domain.js";

interface SnapshotRow {
  id: string;
  cycle_id: string;
  published_at: Date;
  content_json: DigestContent;
}

export async function getSnapshot(cycleId: string): Promise<SnapshotRow | undefined> {
  const rows = await query<SnapshotRow>(`SELECT * FROM digest_snapshots WHERE cycle_id = $1`, [cycleId]);
  return rows[0];
}

/** Immutable once written: publishing twice for the same cycle is a no-op here — the
 * unique constraint on cycle_id is what makes "publish exactly once" a database
 * guarantee rather than an application race. */
export async function insertSnapshotIfAbsent(
  cycleId: string,
  content: DigestContent,
  publishedBy: string
): Promise<SnapshotRow> {
  const inserted = await query<SnapshotRow>(
    `INSERT INTO digest_snapshots (cycle_id, content_json, published_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (cycle_id) DO NOTHING
     RETURNING *`,
    [cycleId, JSON.stringify(content), publishedBy]
  );
  if (inserted[0]) return inserted[0];
  return (await getSnapshot(cycleId))!;
}
