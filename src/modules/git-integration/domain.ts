/**
 * No implementation ships in V1 — the actual provider (GitHub/GitLab/Bitbucket) is an
 * unresolved decision (docs/00). This interface is what review-workflow and metrics
 * code against, so picking the provider later means writing one adapter file, not
 * touching callers.
 */
export interface Commit {
  sha: string;
  authorExternalId: string | null;
  authoredAt: Date;
  isMerge: boolean;
  linkedJiraIssueKeys: string[];
}

export interface PullRequest {
  providerPrId: string;
  title: string;
  authorExternalId: string | null;
  branchName: string | null;
  linkedJiraIssueKeys: string[];
  state: "open" | "merged" | "closed";
  openedAt: Date | null;
  mergedAt: Date | null;
  url: string;
}

export interface CheckStatus {
  name: string;
  state: "success" | "failure" | "pending";
  url: string | null;
}

export interface NormalizedWebhookEvent {
  type: "push" | "pull_request" | "pull_request_review" | "check_run";
  repositoryProviderId: string;
  payload: unknown;
}

export interface GitProvider {
  listUserCommits(externalAccountId: string, since: Date, until: Date): Promise<Commit[]>;
  getCommit(repositoryProviderId: string, sha: string): Promise<Commit | undefined>;
  getPullRequest(repositoryProviderId: string, providerPrId: string): Promise<PullRequest | undefined>;
  listPullRequestsForIssue(jiraIssueKey: string): Promise<PullRequest[]>;
  getPullRequestReviewState(repositoryProviderId: string, providerPrId: string): Promise<string>;
  requestReview(repositoryProviderId: string, providerPrId: string, reviewerExternalId: string): Promise<void>;
  /** V1: never called automatically. Only invoked from an explicit, authorized human
   * action, and only if the concrete provider integration supports it safely. */
  approvePullRequest(repositoryProviderId: string, providerPrId: string): Promise<void>;
  getChecks(repositoryProviderId: string, providerPrId: string): Promise<CheckStatus[]>;
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean;
  normalizeWebhookEvent(rawBody: unknown): NormalizedWebhookEvent[];
}
