import type { UpdateSubmission } from "../daily-updates/index.js";
import type { ExecutiveSummary, ReportingWindow } from "./domain.js";
import * as repo from "./repository.js";

export class MetricsService {
  /** Submission-derived counts (developersExpected/submitted/missing/activeBlockers) come
   * from explicit user submissions — the source of truth for self-reported state — while
   * everything else is queried fresh from Jira/Git event tables. Nothing here is inferred
   * by an LLM. */
  async computeExecutiveSummary(
    window: ReportingWindow,
    enabledUserCount: number,
    submissions: UpdateSubmission[]
  ): Promise<ExecutiveSummary> {
    const submitted = submissions.filter((s) => s.status === "submitted").length;
    const skipped = submissions.filter((s) => s.status === "skipped").length;
    const missing = Math.max(0, enabledUserCount - submitted - skipped);
    const activeBlockers = submissions.filter((s) => !!s.blockers && s.blockers.trim().length > 0).length;

    const [ticketsPicked, ticketsClosed, ticketsCreated, qaTicketsCreated, ticketsInQA, itemsPendingApproval, commitsPushed, prsOpened, prsMerged] =
      await Promise.all([
        repo.countTicketsPicked(window),
        repo.countTicketsClosed(window),
        repo.countTicketsCreated(window),
        repo.countQaTicketsCreated(window),
        repo.countTicketsInQa(window.organizationId),
        repo.countItemsPendingApproval(window.organizationId),
        repo.countCommitsPushed(window),
        repo.countPrsOpened(window),
        repo.countPrsMerged(window),
      ]);

    const summary: ExecutiveSummary = {
      developersExpected: enabledUserCount,
      submitted,
      missing,
      ticketsPicked,
      ticketsClosed,
      ticketsCreated,
      qaTicketsCreated,
      ticketsInQA,
      itemsPendingApproval,
      commitsPushed,
      prsOpened,
      prsMerged,
      activeBlockers,
    };
    return summary;
  }
}
