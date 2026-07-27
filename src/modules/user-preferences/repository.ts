import { query } from "../../shared/db.js";
import type { UserPreferences } from "./domain.js";

interface PreferencesRow {
  user_id: string;
  timezone_override: string | null;
  reminder_time_override: string | null;
  paused_until: string | null;
  follow_up_enabled: boolean;
}

function toDomain(row: PreferencesRow): UserPreferences {
  return {
    userId: row.user_id,
    timezoneOverride: row.timezone_override,
    reminderTimeOverride: row.reminder_time_override,
    pausedUntil: row.paused_until,
    followUpEnabled: row.follow_up_enabled,
  };
}

export async function getPreferences(userId: string): Promise<UserPreferences | undefined> {
  const rows = await query<PreferencesRow>(`SELECT * FROM user_preferences WHERE user_id = $1`, [userId]);
  return rows[0] ? toDomain(rows[0]) : undefined;
}

export async function upsertPreferences(
  userId: string,
  patch: Partial<Omit<UserPreferences, "userId">>
): Promise<UserPreferences> {
  const existing = await getPreferences(userId);
  const merged = {
    timezoneOverride: patch.timezoneOverride ?? existing?.timezoneOverride ?? null,
    reminderTimeOverride: patch.reminderTimeOverride ?? existing?.reminderTimeOverride ?? null,
    pausedUntil: patch.pausedUntil !== undefined ? patch.pausedUntil : existing?.pausedUntil ?? null,
    followUpEnabled: patch.followUpEnabled ?? existing?.followUpEnabled ?? false,
  };
  const rows = await query<PreferencesRow>(
    `INSERT INTO user_preferences (user_id, timezone_override, reminder_time_override, paused_until, follow_up_enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       timezone_override = EXCLUDED.timezone_override,
       reminder_time_override = EXCLUDED.reminder_time_override,
       paused_until = EXCLUDED.paused_until,
       follow_up_enabled = EXCLUDED.follow_up_enabled,
       updated_at = now()
     RETURNING *`,
    [userId, merged.timezoneOverride, merged.reminderTimeOverride, merged.pausedUntil, merged.followUpEnabled]
  );
  return toDomain(rows[0]!);
}
