import type { AdaptiveCardPayload } from "../teams-adapter/index.js";
import type { ReviewState } from "./domain.js";

export interface ReviewRequestCardContext {
  reviewId: string;
  jiraIssueKey: string;
  jiraUrl: string;
  jiraSummary?: string;
  pullRequestUrl: string | null;
  branchName: string | null;
  commitSha: string | null;
  requesterName: string;
  requesterNote: string | null;
  acknowledgeIdempotencyKey: string;
  approveIdempotencyKey: string;
  changesRequestedIdempotencyKey: string;
}

/** Sent to the reviewer (see docs/07-adaptive-card-wireframes.md, wireframe #2). */
export function buildReviewRequestCard(ctx: ReviewRequestCardContext): AdaptiveCardPayload {
  const decisionData = (decision: ReviewState, idempotencyKey: string) => ({
    reviewId: ctx.reviewId,
    decision,
    idempotencyKey,
  });

  const body: unknown[] = [
    { type: "TextBlock", size: "Large", weight: "Bolder", text: `Review requested — ${ctx.jiraIssueKey}` },
    {
      type: "TextBlock",
      wrap: true,
      text: `[${ctx.jiraIssueKey}${ctx.jiraSummary ? " — " + ctx.jiraSummary : ""}](${ctx.jiraUrl})`,
    },
  ];
  if (ctx.pullRequestUrl) {
    body.push({ type: "TextBlock", wrap: true, text: `[Pull request](${ctx.pullRequestUrl})` });
  }
  if (ctx.branchName) {
    body.push({ type: "TextBlock", wrap: true, isSubtle: true, text: `Branch: ${ctx.branchName}` });
  }
  body.push({ type: "TextBlock", wrap: true, text: `From: ${ctx.requesterName}` });
  if (ctx.requesterNote) {
    body.push({ type: "TextBlock", wrap: true, text: `"${ctx.requesterNote}"` });
  }

  const actions: unknown[] = [
    {
      type: "Action.Submit",
      title: "Acknowledge",
      data: decisionData("acknowledged", ctx.acknowledgeIdempotencyKey),
    },
    { type: "Action.Submit", title: "Approve", data: decisionData("approved", ctx.approveIdempotencyKey) },
    {
      type: "Action.Submit",
      title: "Needs changes",
      data: decisionData("changes_requested", ctx.changesRequestedIdempotencyKey),
    },
  ];
  if (ctx.pullRequestUrl) {
    actions.push({ type: "Action.OpenUrl", title: "Open PR", url: ctx.pullRequestUrl });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions,
  };
}

export interface ReviewDecisionSubmission {
  reviewId: string;
  decision: ReviewState;
  idempotencyKey: string;
}

export function parseReviewDecisionSubmission(raw: Record<string, unknown>): ReviewDecisionSubmission {
  return {
    reviewId: String(raw.reviewId),
    decision: raw.decision as ReviewState,
    idempotencyKey: String(raw.idempotencyKey),
  };
}
