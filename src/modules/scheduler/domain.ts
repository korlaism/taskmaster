export type NotificationJobType = "daily_reminder" | "follow_up_reminder" | "digest_publish";

export interface NotificationJob {
  id: string;
  organizationId: string;
  jobType: NotificationJobType;
  subjectUserId: string | null; // null for org-level jobs (digest_publish)
  scheduledFor: Date;
  status: "pending" | "claimed" | "done" | "dead_letter";
  attemptCount: number;
}
