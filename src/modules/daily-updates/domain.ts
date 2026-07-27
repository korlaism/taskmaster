export interface UpdateCycle {
  id: string;
  organizationId: string;
  cycleDate: string; // 'YYYY-MM-DD', in org timezone
  windowStart: Date;
  windowEnd: Date;
  cutoffAt: Date;
  digestPublishAt: Date;
}

export type SubmissionStatus = "draft" | "submitted" | "skipped";

export interface SubmissionInput {
  cycleId: string;
  userId: string;
  status: SubmissionStatus;
  skipReason?: string | null;
  completedToday?: string | null;
  inProgress?: string | null;
  blockers?: string | null;
  nextPlanned?: string | null;
  reviewRequired?: boolean;
  additionalNotes?: string | null;
  idempotencyKey: string;
  jiraIssueKeys?: string[];
}

export interface UpdateSubmission {
  id: string;
  cycleId: string;
  userId: string;
  status: SubmissionStatus;
  skipReason: string | null;
  completedToday: string | null;
  inProgress: string | null;
  blockers: string | null;
  nextPlanned: string | null;
  reviewRequired: boolean;
  additionalNotes: string | null;
  idempotencyKey: string;
  submittedAt: Date | null;
}
