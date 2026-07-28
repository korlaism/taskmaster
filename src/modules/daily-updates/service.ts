import { randomUUID } from "node:crypto";
import type { Clock } from "../../shared/clock.js";
import { ConflictError } from "../../shared/errors.js";
import { localDateString, zonedTimeToUtc } from "../../shared/timezone.js";
import type { JiraClient } from "../jira-integration/index.js";
import { buildDailyUpdateCard, parseCardSubmission } from "./card.js";
import type { SubmissionInput, UpdateCycle, UpdateSubmission } from "./domain.js";
import * as repo from "./repository.js";

export interface OrgCycleConfig {
  id: string;
  timezone: string;
  updateCutoffTime: string; // 'HH:MM'
  digestPublishTime: string; // 'HH:MM'
}

export class DailyUpdatesService {
  constructor(
    private readonly clock: Clock,
    private readonly jira: JiraClient
  ) {}

  /** Reporting window = previous cutoff -> today's cutoff, in org-local time, not the
   * server's calendar day (per the metrics-definitions requirement). */
  async ensureCycleForToday(org: OrgCycleConfig): Promise<UpdateCycle> {
    const now = this.clock.now();
    const today = localDateString(now, org.timezone);
    const cutoffAt = zonedTimeToUtc(today, org.updateCutoffTime, org.timezone);
    const digestPublishAt = zonedTimeToUtc(today, org.digestPublishTime, org.timezone);
    const windowEnd = cutoffAt;
    const priorDay = localDateString(new Date(cutoffAt.getTime() - 24 * 60 * 60 * 1000), org.timezone);
    const windowStart = zonedTimeToUtc(priorDay, org.updateCutoffTime, org.timezone);

    return repo.ensureCycle({
      organizationId: org.id,
      cycleDate: today,
      windowStart,
      windowEnd,
      cutoffAt,
      digestPublishAt,
    });
  }

  async buildReminderCard(cycle: UpdateCycle, userId: string, userExternalJiraAccountId: string | null) {
    const suggestions = userExternalJiraAccountId
      ? await this.jira.suggestIssuesForReportingWindow({
          userExternalAccountId: userExternalJiraAccountId,
          windowStart: cycle.windowStart,
          windowEnd: cycle.windowEnd,
        })
      : [];
    return buildDailyUpdateCard({
      cycleId: cycle.id,
      cycleDate: cycle.cycleDate,
      userId,
      draftIdempotencyKey: randomUUID(),
      submitIdempotencyKey: randomUUID(),
      suggestions,
    });
  }

  parseCardSubmission = parseCardSubmission;

  async submitFromCard(
    cycle: UpdateCycle,
    raw: Record<string, unknown>
  ): Promise<{ submission: UpdateSubmission; isNewRevision: boolean }> {
    const now = this.clock.now();
    if (now > cycle.cutoffAt) {
      throw new ConflictError("Update cutoff has passed for this cycle; submission rejected");
    }
    const input: SubmissionInput = parseCardSubmission(raw);
    return this.submit(input);
  }

  async submit(input: SubmissionInput): Promise<{ submission: UpdateSubmission; isNewRevision: boolean }> {
    return repo.upsertSubmission(input);
  }

  getCycleById = repo.getCycleById;
  getSubmission = repo.getSubmission;
  listSubmissionsForCycle = repo.listSubmissionsForCycle;
  listSubmissionItems = repo.listSubmissionItems;

  async listMissingSubmissions(cycleId: string, enabledUserIds: string[]): Promise<string[]> {
    const submissions = await repo.listSubmissionsForCycle(cycleId);
    const accountedFor = new Set(submissions.filter((s) => s.status !== "draft").map((s) => s.userId));
    return enabledUserIds.filter((id) => !accountedFor.has(id));
  }
}
