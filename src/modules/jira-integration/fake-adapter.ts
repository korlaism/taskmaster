import type {
  CreateIssueInput,
  CreateMetaField,
  JiraClient,
  JiraIssueEventInput,
  JiraIssueSuggestion,
} from "./domain.js";

/**
 * V1 vertical-slice stand-in for a real Jira Cloud/Data Center adapter. Seeded with
 * fixture data per Entra/Teams user so the reminder card and digest have something
 * real (if fake) to enrich with. Replace with a real adapter behind this same
 * JiraClient interface once Jira Cloud vs Data Center is confirmed (docs/03).
 */
export class FakeJiraAdapter implements JiraClient {
  private readonly fixtures = new Map<string, JiraIssueSuggestion[]>();

  seedSuggestions(userExternalAccountId: string, suggestions: JiraIssueSuggestion[]) {
    this.fixtures.set(userExternalAccountId, suggestions);
  }

  async suggestIssuesForReportingWindow(params: {
    userExternalAccountId: string;
  }): Promise<JiraIssueSuggestion[]> {
    return this.fixtures.get(params.userExternalAccountId) ?? [];
  }

  async searchIssuesByJql(): Promise<JiraIssueSuggestion[]> {
    return [];
  }

  async getCreateMeta(): Promise<CreateMetaField[]> {
    return [
      { fieldId: "summary", name: "Summary", required: true },
      { fieldId: "description", name: "Description", required: true },
      { fieldId: "priority", name: "Priority", required: false },
    ];
  }

  async createIssue(input: CreateIssueInput): Promise<{ issueKey: string; url: string }> {
    const issueKey = `FAKE-${Math.floor(Math.random() * 100000)}`;
    return { issueKey, url: `https://fake-jira.invalid/browse/${issueKey}` };
  }

  async addComment(): Promise<void> {
    /* no-op in fake adapter */
  }

  async transitionIssue(): Promise<void> {
    /* no-op in fake adapter */
  }

  verifyWebhookSignature(): boolean {
    return true;
  }

  normalizeWebhookEvent(): JiraIssueEventInput[] {
    return [];
  }
}
