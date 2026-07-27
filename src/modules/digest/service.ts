import type { DailyUpdatesService, UpdateCycle } from "../daily-updates/index.js";
import type { IdentityService } from "../identity/index.js";
import type { MetricsService } from "../metrics/index.js";
import { renderDigestChannelCard } from "./card.js";
import type { AttentionRequired, DigestContent, PerPersonEntry } from "./domain.js";
import * as repo from "./repository.js";

export class DigestService {
  constructor(
    private readonly identity: IdentityService,
    private readonly dailyUpdates: DailyUpdatesService,
    private readonly metrics: MetricsService
  ) {}

  private async render(organizationId: string, cycle: UpdateCycle): Promise<DigestContent> {
    const enabledUsers = await this.identity.listEnabledUsers(organizationId);
    const submissions = await this.dailyUpdates.listSubmissionsForCycle(cycle.id);
    const submissionByUser = new Map(submissions.map((s) => [s.userId, s]));

    const executiveSummary = await this.metrics.computeExecutiveSummary(
      { organizationId, windowStart: cycle.windowStart, windowEnd: cycle.windowEnd },
      enabledUsers.length,
      submissions
    );

    const perPerson: PerPersonEntry[] = await Promise.all(
      enabledUsers.map(async (u): Promise<PerPersonEntry> => {
        const s = submissionByUser.get(u.id);
        const jiraIssueKeys = s ? await this.dailyUpdates.listSubmissionItems(s.id) : [];
        return {
          userId: u.id,
          displayName: u.displayName,
          submissionStatus: s?.status === "submitted" ? "submitted" : s?.status === "skipped" ? "skipped" : "missing",
          completedToday: s?.completedToday ?? null,
          inProgress: s?.inProgress ?? null,
          blockers: s?.blockers ?? null,
          nextPlanned: s?.nextPlanned ?? null,
          jiraIssueKeys,
          reviewRequired: s?.reviewRequired ?? false,
        };
      })
    );

    const missingUsers = await this.dailyUpdates.listMissingSubmissions(
      cycle.id,
      enabledUsers.map((u) => u.id)
    );
    const missingNames = perPerson.filter((p) => missingUsers.includes(p.userId)).map((p) => p.displayName);
    const unmapped = await this.identity.listUsersMissingExternalIdentity(organizationId, "jira");

    const attentionRequired: AttentionRequired = {
      missingUpdates: missingNames,
      blockedTickets: perPerson.filter((p) => !!p.blockers).map((p) => `${p.displayName}: ${p.blockers}`),
      staleReviewRequests: [], // populated once review-workflow (later phase) is implemented
      failedCiChecks: [], // populated once git-integration (later phase) is implemented
      pendingApprovalOverThreshold: [], // populated once a threshold config + real Jira data exist
      unmappedIdentities: unmapped.map((u) => u.displayName),
    };

    return { cycleId: cycle.id, cycleDate: cycle.cycleDate, executiveSummary, perPerson, attentionRequired };
  }

  /** Publish-once: the digest_snapshots unique constraint on cycle_id means a second
   * call for the same cycle returns the already-published (immutable) content instead
   * of recomputing or re-inserting — safe to call from a retried scheduler tick or two
   * racing worker instances. */
  async getOrPublishSnapshot(
    organizationId: string,
    cycle: UpdateCycle,
    publishedBy = "scheduler"
  ): Promise<DigestContent> {
    const existing = await repo.getSnapshot(cycle.id);
    if (existing) return existing.content_json;
    const content = await this.render(organizationId, cycle);
    const row = await repo.insertSnapshotIfAbsent(cycle.id, content, publishedBy);
    return row.content_json;
  }

  async getSnapshot(cycleId: string): Promise<DigestContent | undefined> {
    const row = await repo.getSnapshot(cycleId);
    return row?.content_json;
  }

  renderChannelCard = renderDigestChannelCard;
}
