export interface Organization {
  id: string;
  name: string;
  timezone: string;
  defaultReminderTime: string; // 'HH:MM'
  updateCutoffTime: string;
  digestPublishTime: string;
  weekendsDisabled: boolean;
}

export interface TeamsInstallation {
  organizationId: string;
  scope: "personal" | "team";
  teamId: string | null;
  channelId: string | null;
}

export interface JiraProject {
  id: string;
  organizationId: string;
  projectKey: string;
  isQaProject: boolean;
}
