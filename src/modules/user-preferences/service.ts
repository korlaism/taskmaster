import * as repo from "./repository.js";

export interface EffectiveSchedulePreference {
  timezone: string;
  reminderTime: string; // 'HH:MM'
  isPaused: boolean;
}

export class UserPreferencesService {
  getPreferences = repo.getPreferences;
  setReminderTimeOverride = (userId: string, time: string | null) =>
    repo.upsertPreferences(userId, { reminderTimeOverride: time });
  setTimezoneOverride = (userId: string, timezone: string | null) =>
    repo.upsertPreferences(userId, { timezoneOverride: timezone });
  setPause = (userId: string, pausedUntil: string | null) => repo.upsertPreferences(userId, { pausedUntil });
  setFollowUpEnabled = (userId: string, enabled: boolean) =>
    repo.upsertPreferences(userId, { followUpEnabled: enabled });

  /** Precedence: explicit user override wins; otherwise inherit the organization default.
   * This is the single place that precedence is decided, so scheduler and admin views
   * can't drift out of sync on "which time actually applies". */
  async getEffective(
    userId: string,
    orgDefaults: { timezone: string; reminderTime: string },
    onDate: string
  ): Promise<EffectiveSchedulePreference> {
    const prefs = await repo.getPreferences(userId);
    return {
      timezone: prefs?.timezoneOverride ?? orgDefaults.timezone,
      reminderTime: prefs?.reminderTimeOverride ?? orgDefaults.reminderTime,
      isPaused: !!prefs?.pausedUntil && prefs.pausedUntil >= onDate,
    };
  }
}
