import type { AdaptiveCardPayload } from "../teams-adapter/index.js";
import type { JiraIssueSuggestion } from "../jira-integration/index.js";
import type { SubmissionInput, SubmissionStatus } from "./domain.js";

export interface DailyUpdateCardContext {
  cycleId: string;
  cycleDate: string;
  userId: string;
  idempotencyKey: string;
  suggestions: JiraIssueSuggestion[];
}

/**
 * Adaptive Card 1.5 body for the daily update. Field names in the Action.Submit `data`
 * block are the contract src/modules/daily-updates/service.ts#parseCardSubmission
 * expects back — keep the two in sync if this changes. See docs/07-adaptive-card-wireframes.md.
 */
export function buildDailyUpdateCard(ctx: DailyUpdateCardContext): AdaptiveCardPayload {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      { type: "TextBlock", size: "Large", weight: "Bolder", text: `Daily update — ${ctx.cycleDate}` },
      { type: "TextBlock", wrap: true, isSubtle: true, text: "Suggested Jira tickets for this reporting window:" },
      ...ctx.suggestions.map((s) => ({
        type: "Input.Toggle",
        id: `ticket_${s.issueKey}`,
        title: `${s.issueKey} — ${s.summary} (${s.status})`,
        value: "true",
        valueOn: "true",
        valueOff: "false",
      })),
      { type: "Input.Text", id: "additionalTicket", label: "Add another Jira ticket by key (optional)" },
      { type: "Input.Text", id: "completedToday", label: "Completed today", isMultiline: true },
      { type: "Input.Text", id: "inProgress", label: "In progress", isMultiline: true },
      { type: "Input.Text", id: "blockers", label: "Blockers", isMultiline: true },
      { type: "Input.Text", id: "nextPlanned", label: "Next planned work", isMultiline: true },
      { type: "Input.Toggle", id: "reviewRequired", title: "Review required?", value: "false" },
      { type: "Input.Text", id: "reviewerName", label: "Reviewer or lead (if review required)" },
      { type: "Input.Text", id: "additionalNotes", label: "Additional notes", isMultiline: true },
      { type: "Input.Text", id: "skipReason", label: "No update needed — reason (leave blank otherwise)" },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Save draft",
        data: { cycleId: ctx.cycleId, userId: ctx.userId, idempotencyKey: ctx.idempotencyKey, intent: "draft" },
      },
      {
        type: "Action.Submit",
        title: "Submit update",
        data: { cycleId: ctx.cycleId, userId: ctx.userId, idempotencyKey: ctx.idempotencyKey, intent: "submit" },
      },
    ],
  };
}

/**
 * Teams merges Action.Submit `data` with all Input.* values into one flat object on
 * submit — this is the inverse of buildDailyUpdateCard's field ids/data block above.
 */
export function parseCardSubmission(raw: Record<string, unknown>): SubmissionInput {
  const jiraIssueKeys: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("ticket_") && value === "true") {
      jiraIssueKeys.push(key.slice("ticket_".length));
    }
  }
  const additionalTicket = typeof raw.additionalTicket === "string" ? raw.additionalTicket.trim() : "";
  if (additionalTicket) jiraIssueKeys.push(additionalTicket.toUpperCase());

  const skipReason = typeof raw.skipReason === "string" ? raw.skipReason.trim() : "";
  const intent = raw.intent === "draft" ? "draft" : "submit";
  const status: SubmissionStatus = skipReason ? "skipped" : intent === "draft" ? "draft" : "submitted";

  return {
    cycleId: String(raw.cycleId),
    userId: String(raw.userId),
    idempotencyKey: String(raw.idempotencyKey),
    status,
    skipReason: skipReason || null,
    completedToday: (raw.completedToday as string) ?? null,
    inProgress: (raw.inProgress as string) ?? null,
    blockers: (raw.blockers as string) ?? null,
    nextPlanned: (raw.nextPlanned as string) ?? null,
    reviewRequired: raw.reviewRequired === "true",
    additionalNotes: (raw.additionalNotes as string) ?? null,
    jiraIssueKeys,
  };
}
