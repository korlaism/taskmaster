import type { ExecutiveSummary } from "../metrics/index.js";

export interface PerPersonEntry {
  userId: string;
  displayName: string;
  submissionStatus: "submitted" | "skipped" | "missing";
  completedToday: string | null;
  inProgress: string | null;
  blockers: string | null;
  nextPlanned: string | null;
  jiraIssueKeys: string[];
  reviewRequired: boolean;
}

export interface AttentionRequired {
  missingUpdates: string[];
  blockedTickets: string[];
  staleReviewRequests: string[];
  failedCiChecks: string[];
  pendingApprovalOverThreshold: string[];
  unmappedIdentities: string[];
}

export interface DigestContent {
  cycleId: string;
  cycleDate: string;
  executiveSummary: ExecutiveSummary;
  perPerson: PerPersonEntry[];
  attentionRequired: AttentionRequired;
}
