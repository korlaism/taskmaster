import type { AdaptiveCardPayload } from "../teams-adapter/index.js";
import type { QaTicketFormPayload } from "./domain.js";

export interface QaTicketCardContext {
  /** QA-designated project keys the requester can choose from (docs/03: dynamic
   * fields are scoped to admin-configured QA projects, not every Jira project). */
  qaProjectKeys: string[];
  idempotencyKey: string;
}

/** See docs/07-adaptive-card-wireframes.md, wireframe #3. Severity/component/environment
 * are free-text here rather than dynamically populated dropdowns — the actual required-
 * field validation against live createmeta happens server-side in
 * qa-ticket-workflow/service.ts, which is what a Jira project with different required
 * screens actually needs to be handled correctly, not the card layout itself. */
export function buildQaTicketCard(ctx: QaTicketCardContext): AdaptiveCardPayload {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      { type: "TextBlock", size: "Large", weight: "Bolder", text: "Create Jira ticket (QA)" },
      {
        type: "Input.ChoiceSet",
        id: "projectKey",
        label: "Project",
        style: "compact",
        choices: ctx.qaProjectKeys.map((key) => ({ title: key, value: key })),
      },
      { type: "Input.Text", id: "issueType", label: "Issue type (e.g. Bug, Task)", value: "Bug" },
      { type: "Input.Text", id: "summary", label: "Summary" },
      { type: "Input.Text", id: "description", label: "Description", isMultiline: true },
      { type: "Input.Text", id: "severity", label: "Severity / priority" },
      { type: "Input.Text", id: "component", label: "Component" },
      { type: "Input.Text", id: "environment", label: "Environment" },
      { type: "Input.Text", id: "stepsToReproduce", label: "Steps to reproduce", isMultiline: true },
      { type: "Input.Text", id: "expectedResult", label: "Expected result", isMultiline: true },
      { type: "Input.Text", id: "actualResult", label: "Actual result", isMultiline: true },
      { type: "Input.Text", id: "evidenceLinks", label: "Evidence / log links (comma-separated)" },
      { type: "Input.Text", id: "relatedIssueKey", label: "Related issue (epic/story)" },
      { type: "Input.Text", id: "suggestedAssigneeExternalId", label: "Suggested assignee" },
    ],
    actions: [
      { type: "Action.Submit", title: "Create ticket", data: { idempotencyKey: ctx.idempotencyKey } },
    ],
  };
}

export interface QaTicketSubmission {
  projectKey: string;
  form: QaTicketFormPayload;
  idempotencyKey: string;
}

export function parseQaTicketSubmission(raw: Record<string, unknown>): QaTicketSubmission {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const evidenceLinks = str(raw.evidenceLinks)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    projectKey: String(raw.projectKey),
    idempotencyKey: String(raw.idempotencyKey),
    form: {
      jiraProjectId: "", // resolved server-side from projectKey before calling the service
      issueType: str(raw.issueType) ?? "Bug",
      summary: String(raw.summary ?? ""),
      description: String(raw.description ?? ""),
      severity: str(raw.severity),
      component: str(raw.component),
      environment: str(raw.environment),
      stepsToReproduce: str(raw.stepsToReproduce),
      expectedResult: str(raw.expectedResult),
      actualResult: str(raw.actualResult),
      evidenceLinks,
      relatedIssueKey: str(raw.relatedIssueKey),
      suggestedAssigneeExternalId: str(raw.suggestedAssigneeExternalId),
    },
  };
}
