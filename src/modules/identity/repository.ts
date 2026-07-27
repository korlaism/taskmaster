import { query } from "../../shared/db.js";
import type { Role, User } from "./domain.js";

interface UserRow {
  id: string;
  organization_id: string;
  entra_object_id: string;
  display_name: string;
  email: string | null;
  enabled: boolean;
}

function toDomain(row: UserRow): User {
  return {
    id: row.id,
    organizationId: row.organization_id,
    entraObjectId: row.entra_object_id,
    displayName: row.display_name,
    email: row.email,
    enabled: row.enabled,
  };
}

export async function upsertUser(params: {
  organizationId: string;
  entraObjectId: string;
  displayName: string;
  email: string | null;
}): Promise<User> {
  const rows = await query<UserRow>(
    `INSERT INTO users (organization_id, entra_object_id, display_name, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, entra_object_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email
     RETURNING *`,
    [params.organizationId, params.entraObjectId, params.displayName, params.email]
  );
  return toDomain(rows[0]!);
}

export async function getUserById(userId: string): Promise<User | undefined> {
  const rows = await query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
  return rows[0] ? toDomain(rows[0]) : undefined;
}

export async function listEnabledUsers(organizationId: string): Promise<User[]> {
  const rows = await query<UserRow>(`SELECT * FROM users WHERE organization_id = $1 AND enabled = TRUE`, [
    organizationId,
  ]);
  return rows.map(toDomain);
}

export async function setUserEnabled(userId: string, enabled: boolean): Promise<void> {
  await query(`UPDATE users SET enabled = $2 WHERE id = $1`, [userId, enabled]);
}

export async function assignRole(userId: string, role: Role): Promise<void> {
  await query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, role]);
}

export async function listRoles(userId: string): Promise<Role[]> {
  const rows = await query<{ role: Role }>(`SELECT role FROM user_roles WHERE user_id = $1`, [userId]);
  return rows.map((r) => r.role);
}

export async function getExternalAccountId(userId: string, provider: "jira" | "git"): Promise<string | undefined> {
  const rows = await query<{ external_account_id: string }>(
    `SELECT external_account_id FROM external_identities WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
  return rows[0]?.external_account_id;
}

export async function linkExternalIdentity(
  organizationId: string,
  userId: string,
  provider: "jira" | "git",
  externalAccountId: string
): Promise<void> {
  await query(
    `INSERT INTO external_identities (organization_id, user_id, provider, external_account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, external_account_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [organizationId, userId, provider, externalAccountId]
  );
}

/** Users with no linked account for `provider` — surfaced in the digest's "Attention
 * required" section since Jira/Git activity can't be attributed to them. */
export async function listUsersMissingExternalIdentity(
  organizationId: string,
  provider: "jira" | "git"
): Promise<User[]> {
  const rows = await query<UserRow>(
    `SELECT u.* FROM users u
     WHERE u.organization_id = $1 AND u.enabled = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM external_identities ei WHERE ei.user_id = u.id AND ei.provider = $2
       )`,
    [organizationId, provider]
  );
  return rows.map(toDomain);
}
