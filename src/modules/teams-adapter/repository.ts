import { query } from "../../shared/db.js";
import type { ConversationReference, ConversationSubjectType } from "./domain.js";

interface ConversationReferenceRow {
  organization_id: string;
  subject_type: ConversationSubjectType;
  subject_id: string;
  service_url: string;
  conversation_id: string;
  tenant_id: string;
  is_valid: boolean;
}

function toDomain(row: ConversationReferenceRow): ConversationReference {
  return {
    organizationId: row.organization_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    serviceUrl: row.service_url,
    conversationId: row.conversation_id,
    tenantId: row.tenant_id,
    isValid: row.is_valid,
  };
}

export async function upsertConversationReference(ref: ConversationReference): Promise<void> {
  await query(
    `INSERT INTO conversation_references
       (organization_id, subject_type, subject_id, service_url, conversation_id, tenant_id, is_valid)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     ON CONFLICT (organization_id, subject_type, subject_id)
     DO UPDATE SET service_url = EXCLUDED.service_url,
                   conversation_id = EXCLUDED.conversation_id,
                   tenant_id = EXCLUDED.tenant_id,
                   is_valid = TRUE`,
    [ref.organizationId, ref.subjectType, ref.subjectId, ref.serviceUrl, ref.conversationId, ref.tenantId]
  );
}

export async function getConversationReference(
  organizationId: string,
  subjectType: ConversationSubjectType,
  subjectId: string
): Promise<ConversationReference | undefined> {
  const rows = await query<ConversationReferenceRow>(
    `SELECT * FROM conversation_references WHERE organization_id = $1 AND subject_type = $2 AND subject_id = $3`,
    [organizationId, subjectType, subjectId]
  );
  return rows[0] ? toDomain(rows[0]) : undefined;
}

export async function markConversationReferenceInvalid(
  organizationId: string,
  subjectType: ConversationSubjectType,
  subjectId: string
): Promise<void> {
  await query(
    `UPDATE conversation_references SET is_valid = FALSE
     WHERE organization_id = $1 AND subject_type = $2 AND subject_id = $3`,
    [organizationId, subjectType, subjectId]
  );
}
