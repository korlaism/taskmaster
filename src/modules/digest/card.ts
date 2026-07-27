import type { AdaptiveCardPayload } from "../teams-adapter/index.js";
import type { DigestContent } from "./domain.js";

const MAX_PER_PERSON_ROWS = 15; // keep the channel post within Adaptive Card practical limits

export function renderDigestChannelCard(content: DigestContent): AdaptiveCardPayload {
  const s = content.executiveSummary;
  const shownPeople = content.perPerson.slice(0, MAX_PER_PERSON_ROWS);
  const truncated = content.perPerson.length > shownPeople.length;

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      { type: "TextBlock", size: "Large", weight: "Bolder", text: `Daily engineering digest — ${content.cycleDate}` },
      {
        type: "FactSet",
        facts: [
          { title: "Submitted", value: `${s.submitted}/${s.developersExpected}` },
          { title: "Missing", value: String(s.missing) },
          { title: "Tickets picked", value: String(s.ticketsPicked) },
          { title: "Tickets closed", value: String(s.ticketsClosed) },
          { title: "Tickets created", value: String(s.ticketsCreated) },
          { title: "QA tickets created", value: String(s.qaTicketsCreated) },
          { title: "In QA", value: String(s.ticketsInQA) },
          { title: "Pending approval", value: String(s.itemsPendingApproval) },
          { title: "Commits pushed", value: String(s.commitsPushed) },
          { title: "PRs opened", value: String(s.prsOpened) },
          { title: "PRs merged", value: String(s.prsMerged) },
          { title: "Active blockers", value: String(s.activeBlockers) },
        ],
      },
      { type: "TextBlock", size: "Medium", weight: "Bolder", text: "Per-person updates", spacing: "Medium" },
      ...shownPeople.flatMap((p) => [
        { type: "TextBlock", weight: "Bolder", text: `${p.displayName} — ${p.submissionStatus}` },
        {
          type: "TextBlock",
          wrap: true,
          isSubtle: true,
          text: p.submissionStatus === "missing" ? "No submission" : p.completedToday || "(no summary provided)",
        },
      ]),
      ...(truncated
        ? [{ type: "TextBlock", isSubtle: true, text: `+${content.perPerson.length - shownPeople.length} more — see full report in app.` }]
        : []),
      { type: "TextBlock", size: "Medium", weight: "Bolder", text: "Attention required", spacing: "Medium" },
      {
        type: "FactSet",
        facts: [
          { title: "Missing updates", value: content.attentionRequired.missingUpdates.join(", ") || "None" },
          { title: "Unmapped identities", value: content.attentionRequired.unmappedIdentities.join(", ") || "None" },
          { title: "Stale review requests", value: content.attentionRequired.staleReviewRequests.join(", ") || "None" },
          { title: "Failed CI checks", value: content.attentionRequired.failedCiChecks.join(", ") || "None" },
        ],
      },
    ],
  };
}
