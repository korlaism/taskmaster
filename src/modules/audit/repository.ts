import { query } from "../../shared/db.js";
import type { AuditEvent } from "./domain.js";

// Append-only by convention: this file must never grow an UPDATE or DELETE statement.
export async function insertAuditEvent(event: AuditEvent): Promise<void> {
  await query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, details_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.organizationId,
      event.actorUserId,
      event.action,
      event.targetType,
      event.targetId,
      JSON.stringify(event.details ?? {}),
    ]
  );
}

export async function listRecentAuditEvents(organizationId: string, limit = 100) {
  return query(`SELECT * FROM audit_events WHERE organization_id = $1 ORDER BY occurred_at DESC LIMIT $2`, [
    organizationId,
    limit,
  ]);
}
