export interface JiraIssueSuggestion {
  issueKey: string;
  summary: string;
  status: string;
  reason: "assigned_during_window" | "status_changed_during_window" | "created_by_user" | "currently_assigned_active";
}

export interface JiraIssueEventInput {
  jiraIssueId: string;
  issueKey: string;
  projectKey: string;
  eventType: "created" | "assigned" | "status_changed" | "updated";
  fromValue: string | null;
  toValue: string | null;
  actorExternalId: string | null;
  occurredAt: Date;
  source: "webhook" | "reconciliation";
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  fields: Record<string, unknown>; // validated against createmeta before calling
}

export interface CreateMetaField {
  fieldId: string;
  name: string;
  required: boolean;
  allowedValues?: string[];
}

/**
 * The full contract the real Jira Cloud/Data Center adapter will implement (see
 * docs/03-jira-authentication-plan.md). FakeJiraAdapter below implements only what
 * the vertical slice exercises (issue suggestion); every other method is a documented
 * stub so the interface — not a partial guess at it — is what downstream modules code against.
 */
export interface JiraClient {
  suggestIssuesForReportingWindow(params: {
    userExternalAccountId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<JiraIssueSuggestion[]>;

  searchIssuesByJql(jql: string): Promise<JiraIssueSuggestion[]>;
  getCreateMeta(projectKey: string, issueType: string): Promise<CreateMetaField[]>;
  createIssue(input: CreateIssueInput): Promise<{ issueKey: string; url: string }>;
  addComment(issueKey: string, body: string): Promise<void>;
  transitionIssue(issueKey: string, transitionName: string): Promise<void>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean;
  normalizeWebhookEvent(rawBody: unknown): JiraIssueEventInput[];
}
