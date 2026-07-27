import { env } from "./config/env.js";
import type { AppContext } from "./composition.js";
import { dedupeKey } from "./shared/ids.js";
import { childLogger } from "./shared/logger.js";

const log = childLogger({ module: "runtime-tick" });

/**
 * One full scheduler+outbox pass: (1) make sure today's per-user reminder jobs and the
 * org's digest-publish job exist (idempotent — safe to call every tick), (2) claim and
 * hand off whatever is now due, (3) drain the outbox with retry/backoff. Shared by
 * worker.ts (the intended standalone process) and, in local-sim dev mode only, by
 * api.ts (so a single `npm run dev:api` process can demonstrate the whole loop without
 * needing a live Teams tenant to bridge state between two processes).
 */
export async function runOneTick(ctx: AppContext, workerId: string): Promise<void> {
  const org = await ctx.administration.getOrganization(env.ORG_ID);
  if (!org) {
    log.warn("organization not bootstrapped yet; skipping tick");
    return;
  }

  const cycle = await ctx.dailyUpdates.ensureCycleForToday({
    id: org.id,
    timezone: org.timezone,
    updateCutoffTime: org.updateCutoffTime,
    digestPublishTime: org.digestPublishTime,
  });

  const enabledUsers = await ctx.identity.listEnabledUsers(org.id);
  const schedulableUsers = await Promise.all(
    enabledUsers.map(async (u) => {
      const effective = await ctx.userPreferences.getEffective(
        u.id,
        { timezone: org.timezone, reminderTime: org.defaultReminderTime },
        cycle.cycleDate
      );
      return {
        userId: u.id,
        timezone: effective.timezone,
        reminderTime: effective.reminderTime,
        isPaused: effective.isPaused,
      };
    })
  );

  await ctx.scheduler.ensureDailyRemindersScheduled(
    {
      id: org.id,
      timezone: org.timezone,
      defaultReminderTime: org.defaultReminderTime,
      digestPublishTime: org.digestPublishTime,
      weekendsDisabled: org.weekendsDisabled,
    },
    schedulableUsers
  );
  await ctx.scheduler.ensureDigestPublishScheduled({
    id: org.id,
    timezone: org.timezone,
    defaultReminderTime: org.defaultReminderTime,
    digestPublishTime: org.digestPublishTime,
    weekendsDisabled: org.weekendsDisabled,
  });

  await ctx.scheduler.tick(workerId, {
    daily_reminder: async (job) => {
      if (!job.subjectUserId) return;
      const externalJiraId = (await ctx.identity.getExternalAccountId(job.subjectUserId, "jira")) ?? null;
      const card = await ctx.dailyUpdates.buildReminderCard(cycle, job.subjectUserId, externalJiraId);
      await ctx.notifications.enqueue({
        aggregateType: "reminder",
        aggregateId: job.subjectUserId,
        eventType: "send_reminder_card",
        payload: { organizationId: org.id, userId: job.subjectUserId, card },
        dedupeKey: dedupeKey(org.id, "send_reminder_card", job.id),
      });
    },
    digest_publish: async () => {
      await ctx.digest.getOrPublishSnapshot(org.id, cycle);
      await ctx.notifications.enqueue({
        aggregateType: "digest",
        aggregateId: cycle.id,
        eventType: "publish_digest_channel_post",
        payload: { organizationId: org.id, cycleId: cycle.id },
        dedupeKey: dedupeKey(org.id, "digest_publish_channel_post", cycle.id),
      });
    },
  });

  await ctx.notifications.dispatchDue({
    send_reminder_card: async (event) => {
      const { organizationId, userId, card } = event.payload as {
        organizationId: string;
        userId: string;
        card: Record<string, unknown>;
      };
      const outcome = await ctx.teamsAdapter.sendPersonalCard(organizationId, userId, card);
      if (!outcome.delivered && outcome.retryable) {
        throw new Error(outcome.reason ?? "delivery failed");
      }
      if (!outcome.delivered) {
        log.warn({ userId, reason: outcome.reason }, "reminder delivery gracefully abandoned (non-retryable)");
      }
    },
    publish_digest_channel_post: async (event) => {
      const { organizationId, cycleId } = event.payload as { organizationId: string; cycleId: string };
      const channel = await ctx.administration.getDigestChannel(organizationId);
      if (!channel?.channelId) throw new Error("no digest channel configured yet");
      const content = await ctx.digest.getSnapshot(cycleId);
      if (!content) throw new Error("digest snapshot missing for cycle");
      const card = ctx.digest.renderChannelCard(content);
      const outcome = await ctx.teamsAdapter.sendChannelCard(organizationId, channel.channelId, card);
      if (!outcome.delivered && outcome.retryable) {
        throw new Error(outcome.reason ?? "delivery failed");
      }
      if (!outcome.delivered) {
        log.warn({ cycleId, reason: outcome.reason }, "digest publish gracefully abandoned (non-retryable)");
      }
    },
  });
}
