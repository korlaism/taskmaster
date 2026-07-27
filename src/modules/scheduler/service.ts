import type { Clock } from "../../shared/clock.js";
import { dedupeKey } from "../../shared/ids.js";
import { childLogger } from "../../shared/logger.js";
import { localDateString, zonedTimeToUtc } from "../../shared/timezone.js";
import type { NotificationJob, NotificationJobType } from "./domain.js";
import * as repo from "./repository.js";

const log = childLogger({ module: "scheduler" });
const CLAIM_LEASE_MS = 5 * 60_000; // a claimed job unfinished for 5 minutes is presumed crashed
const MAX_ATTEMPTS = 5;

export interface OrgScheduleConfig {
  id: string;
  timezone: string;
  defaultReminderTime: string;
  digestPublishTime: string;
  weekendsDisabled: boolean;
}

export interface SchedulableUser {
  userId: string;
  timezone: string;
  reminderTime: string;
  isPaused: boolean;
}

/** Injected by worker.ts so the scheduler stays decoupled from how a job is actually
 * delivered — it only decides *when* and *exactly-once*, never *how*. */
export type JobHandler = (job: NotificationJob) => Promise<void>;

export class SchedulerService {
  constructor(private readonly clock: Clock) {}

  async ensureDailyRemindersScheduled(org: OrgScheduleConfig, users: SchedulableUser[]): Promise<void> {
    const now = this.clock.now();
    for (const user of users) {
      if (user.isPaused) continue;
      const today = localDateString(now, user.timezone);
      if (org.weekendsDisabled) {
        const dtf = new Intl.DateTimeFormat("en-US", { timeZone: user.timezone, weekday: "short" });
        const weekday = dtf.format(now);
        if (weekday === "Sat" || weekday === "Sun") continue;
      }
      const scheduledFor = zonedTimeToUtc(today, user.reminderTime, user.timezone);
      await repo.ensureJobScheduled({
        organizationId: org.id,
        jobType: "daily_reminder",
        subjectUserId: user.userId,
        scheduledFor,
        dedupeKey: dedupeKey(org.id, "daily_reminder", user.userId, scheduledFor.toISOString()),
      });
    }
  }

  async ensureDigestPublishScheduled(org: OrgScheduleConfig): Promise<void> {
    const now = this.clock.now();
    const today = localDateString(now, org.timezone);
    const scheduledFor = zonedTimeToUtc(today, org.digestPublishTime, org.timezone);
    await repo.ensureJobScheduled({
      organizationId: org.id,
      jobType: "digest_publish",
      subjectUserId: null,
      scheduledFor,
      dedupeKey: dedupeKey(org.id, "digest_publish", scheduledFor.toISOString()),
    });
  }

  /** One tick: reclaim crashed leases, claim newly-due jobs, hand each to its handler. */
  async tick(workerId: string, handlers: Partial<Record<NotificationJobType, JobHandler>>, batchSize = 25): Promise<void> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const reclaimed = await repo.reclaimStaleClaims(staleBefore);
    if (reclaimed > 0) log.warn({ reclaimed }, "reclaimed stale claimed jobs");

    const jobs = await repo.claimDueJobs(now, workerId, batchSize);
    for (const job of jobs) {
      const handler = handlers[job.jobType];
      try {
        if (!handler) throw new Error(`no handler registered for job type ${job.jobType}`);
        await handler(job);
        await repo.markJobDone(job.id);
      } catch (err) {
        log.error({ jobId: job.id, jobType: job.jobType, err: (err as Error).message }, "job handling failed");
        await repo.markJobFailed(job.id, (err as Error).message, MAX_ATTEMPTS);
      }
    }
  }

  replayDeadLetter = repo.replayDeadLetter;
}
