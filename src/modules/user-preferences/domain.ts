export interface UserPreferences {
  userId: string;
  timezoneOverride: string | null;
  reminderTimeOverride: string | null; // 'HH:MM'
  pausedUntil: string | null; // 'YYYY-MM-DD', inclusive
  followUpEnabled: boolean;
}
