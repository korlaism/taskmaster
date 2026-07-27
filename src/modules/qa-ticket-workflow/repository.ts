import { query } from "../../shared/db.js";
import type { QaTicketFormPayload, QaTicketRequest } from "./domain.js";

interface Row {
  id: string;
  organization_id: string;
  requester_id: string;
  jira_project_id: string;
  issue_key: string | null;
  status: QaTicketRequest["status"];
}

function toDomain(row: Row): QaTicketRequest {
  return {
    id: row.id,
    organizationId: row.organization_id,
    requesterId: row.requester_id,
    jiraProjectId: row.jira_project_id,
    issueKey: row.issue_key,
    status: row.status,
  };
}

export async function createPending(params: {
  organizationId: string;
  requesterId: string;
  jiraProjectId: string;
  formPayload: QaTicketFormPayload;
  idempotencyKey: string;
}): Promise<{ request: QaTicketRequest; isNew: boolean }> {
  const inserted = await query<Row>(
    `INSERT INTO qa_ticket_requests (organization_id, requester_id, jira_project_id, form_payload, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [params.organizationId, params.requesterId, params.jiraProjectId, JSON.stringify(params.formPayload), params.idempotencyKey]
  );
  if (inserted[0]) return { request: toDomain(inserted[0]), isNew: true };
  const existing = await query<Row>(`SELECT * FROM qa_ticket_requests WHERE idempotency_key = $1`, [
    params.idempotencyKey,
  ]);
  return { request: toDomain(existing[0]!), isNew: false };
}

export async function markCreated(id: string, issueKey: string): Promise<void> {
  await query(`UPDATE qa_ticket_requests SET status = 'created', issue_key = $2 WHERE id = $1`, [id, issueKey]);
}

export async function markFailed(id: string): Promise<void> {
  await query(`UPDATE qa_ticket_requests SET status = 'failed' WHERE id = $1`, [id]);
}
