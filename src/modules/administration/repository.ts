import { query } from "../../shared/db.js";
import type { Organization, TeamsInstallation } from "./domain.js";

interface OrgRow {
  id: string;
  name: string;
  timezone: string;
  default_reminder_time: string;
  update_cutoff_time: string;
  digest_publish_time: string;
  weekends_disabled: boolean;
}

function toDomain(row: OrgRow): Organization {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    defaultReminderTime: row.default_reminder_time.slice(0, 5),
    updateCutoffTime: row.update_cutoff_time.slice(0, 5),
    digestPublishTime: row.digest_publish_time.slice(0, 5),
    weekendsDisabled: row.weekends_disabled,
  };
}

export async function upsertOrganization(org: {
  id: string;
  name: string;
  timezone: string;
  defaultReminderTime: string;
  updateCutoffTime: string;
  digestPublishTime: string;
  weekendsDisabled: boolean;
}): Promise<Organization> {
  const rows = await query<OrgRow>(
    `INSERT INTO organizations (id, name, timezone, default_reminder_time, update_cutoff_time, digest_publish_time, weekends_disabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       timezone = EXCLUDED.timezone,
       default_reminder_time = EXCLUDED.default_reminder_time,
       update_cutoff_time = EXCLUDED.update_cutoff_time,
       digest_publish_time = EXCLUDED.digest_publish_time,
       weekends_disabled = EXCLUDED.weekends_disabled
     RETURNING *`,
    [org.id, org.name, org.timezone, org.defaultReminderTime, org.updateCutoffTime, org.digestPublishTime, org.weekendsDisabled]
  );
  return toDomain(rows[0]!);
}

export async function getOrganization(id: string): Promise<Organization | undefined> {
  const rows = await query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : undefined;
}

export async function setDigestChannel(organizationId: string, teamId: string, channelId: string): Promise<void> {
  await query(
    `INSERT INTO teams_installations (organization_id, scope, team_id, channel_id)
     VALUES ($1, 'team', $2, $3)`,
    [organizationId, teamId, channelId]
  );
}

export async function listIntegrationFailures(organizationId: string, resolvedOnly = false) {
  return query(
    `SELECT * FROM integration_failures WHERE organization_id = $1 AND resolved = $2 ORDER BY occurred_at DESC`,
    [organizationId, resolvedOnly]
  );
}

export async function getDigestChannel(organizationId: string): Promise<TeamsInstallation | undefined> {
  const rows = await query<{ organization_id: string; scope: "personal" | "team"; team_id: string | null; channel_id: string | null }>(
    `SELECT organization_id, scope, team_id, channel_id FROM teams_installations
     WHERE organization_id = $1 AND scope = 'team' AND uninstalled_at IS NULL
     ORDER BY installed_at DESC LIMIT 1`,
    [organizationId]
  );
  const row = rows[0];
  return row
    ? { organizationId: row.organization_id, scope: row.scope, teamId: row.team_id, channelId: row.channel_id }
    : undefined;
}
