import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { fixedClock } from "../../src/shared/clock.js";
import { dedupeKey } from "../../src/shared/ids.js";
import { SchedulerService } from "../../src/modules/scheduler/index.js";
import * as schedulerRepo from "../../src/modules/scheduler/repository.js";
import { resetDatabase } from "../support/reset-db.js";
import { seedOrganization, seedUser } from "../support/seed.js";

const NOW = new Date("2026-01-15T14:05:00.000Z");

describe("scheduler: exactly-once claiming under concurrency", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("two workers claiming the same due jobs at once never claim the same job twice", async () => {
    const users = await Promise.all([seedUser("U1"), seedUser("U2"), seedUser("U3"), seedUser("U4"), seedUser("U5")]);

    for (const u of users) {
      await schedulerRepo.ensureJobScheduled({
        organizationId: env.ORG_ID,
        jobType: "daily_reminder",
        subjectUserId: u.id,
        scheduledFor: new Date(NOW.getTime() - 60_000), // already due
        dedupeKey: dedupeKey(env.ORG_ID, "daily_reminder", u.id, "test-run"),
      });
    }

    const [claimedByA, claimedByB] = await Promise.all([
      schedulerRepo.claimDueJobs(NOW, "worker-a", 10),
      schedulerRepo.claimDueJobs(NOW, "worker-b", 10),
    ]);

    const allIds = [...claimedByA, ...claimedByB].map((j) => j.id);
    const uniqueIds = new Set(allIds);
    expect(allIds).toHaveLength(5); // every seeded job claimed exactly once, combined
    expect(uniqueIds.size).toBe(5); // no job appears in both workers' results

    // A third claim attempt right after finds nothing left pending.
    const claimedByC = await schedulerRepo.claimDueJobs(NOW, "worker-c", 10);
    expect(claimedByC).toHaveLength(0);
  });

  it("ensureJobScheduled is idempotent — re-running job generation for the same instant does not duplicate rows", async () => {
    const user = await seedUser("Solo");
    const scheduledFor = new Date(NOW.getTime() - 60_000);
    const key = dedupeKey(env.ORG_ID, "daily_reminder", user.id, "same-instant");

    for (let i = 0; i < 3; i++) {
      await schedulerRepo.ensureJobScheduled({
        organizationId: env.ORG_ID,
        jobType: "daily_reminder",
        subjectUserId: user.id,
        scheduledFor,
        dedupeKey: key,
      });
    }

    const claimed = await schedulerRepo.claimDueJobs(NOW, "worker-a", 10);
    expect(claimed).toHaveLength(1);
  });

  it("a job stuck in 'claimed' past the lease window is reclaimed (simulated worker crash)", async () => {
    const user = await seedUser("Crashy");
    await schedulerRepo.ensureJobScheduled({
      organizationId: env.ORG_ID,
      jobType: "daily_reminder",
      subjectUserId: user.id,
      scheduledFor: new Date(NOW.getTime() - 60_000),
      dedupeKey: dedupeKey(env.ORG_ID, "daily_reminder", user.id, "crash-test"),
    });

    const claimed = await schedulerRepo.claimDueJobs(NOW, "worker-that-crashes", 10);
    expect(claimed).toHaveLength(1);

    // Worker died before calling markDone/markFailed. A tick 10 minutes later reclaims it.
    const scheduler = new SchedulerService(fixedClock(new Date(NOW.getTime() + 10 * 60_000).toISOString()));
    await scheduler.tick("worker-recovery", { daily_reminder: async () => {} });

    const { rows } = await import("../../src/shared/db.js").then((m) =>
      m.pool.query(`SELECT status FROM notification_jobs WHERE id = $1`, [claimed[0]!.id])
    );
    expect(rows[0].status).toBe("done"); // reclaimed, re-claimed by the tick, and this time handled to completion
  });
});
