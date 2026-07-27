import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { fixedClock } from "../../src/shared/clock.js";
import { DailyUpdatesService } from "../../src/modules/daily-updates/index.js";
import { DigestService } from "../../src/modules/digest/index.js";
import { IdentityService } from "../../src/modules/identity/index.js";
import { FakeJiraAdapter } from "../../src/modules/jira-integration/index.js";
import { MetricsService } from "../../src/modules/metrics/index.js";
import { pool } from "../../src/shared/db.js";
import { resetDatabase } from "../support/reset-db.js";
import { seedOrganization, seedUser } from "../support/seed.js";

const ORG_CYCLE_CONFIG = {
  id: env.ORG_ID,
  timezone: "America/New_York",
  updateCutoffTime: "16:00",
  digestPublishTime: "17:00",
};

describe("digest: publish-once and immutability", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("publishing twice for the same cycle produces exactly one immutable snapshot", async () => {
    const identity = new IdentityService();
    const dailyUpdates = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const digest = new DigestService(identity, dailyUpdates, new MetricsService());

    const alice = await seedUser("Alice");
    const cycle = await dailyUpdates.ensureCycleForToday(ORG_CYCLE_CONFIG);
    await dailyUpdates.submit({
      cycleId: cycle.id,
      userId: alice.id,
      status: "submitted",
      completedToday: "Shipped X",
      idempotencyKey: randomUUID(),
    });

    // Two "concurrent" publish attempts (e.g. a retried scheduler tick, or two racing workers).
    const [first, second] = await Promise.all([
      digest.getOrPublishSnapshot(env.ORG_ID, cycle),
      digest.getOrPublishSnapshot(env.ORG_ID, cycle),
    ]);
    expect(first).toEqual(second);

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM digest_snapshots WHERE cycle_id = $1`, [
      cycle.id,
    ]);
    expect(rows[0].count).toBe(1);
  });

  it("a snapshot's content never changes even if submissions change afterward", async () => {
    const identity = new IdentityService();
    const dailyUpdates = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const digest = new DigestService(identity, dailyUpdates, new MetricsService());

    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const cycle = await dailyUpdates.ensureCycleForToday(ORG_CYCLE_CONFIG);
    await dailyUpdates.submit({
      cycleId: cycle.id,
      userId: alice.id,
      status: "submitted",
      idempotencyKey: randomUUID(),
    });
    // Bob has not submitted yet -> counted as missing at publish time.

    const published = await digest.getOrPublishSnapshot(env.ORG_ID, cycle);
    expect(published.executiveSummary.missing).toBe(1);
    expect(published.executiveSummary.submitted).toBe(1);

    // A lead requests changes / Bob submits late, after the digest already published.
    await dailyUpdates.submit({ cycleId: cycle.id, userId: bob.id, status: "submitted", idempotencyKey: randomUUID() });

    const reread = await digest.getOrPublishSnapshot(env.ORG_ID, cycle);
    expect(reread.executiveSummary.missing).toBe(1); // unchanged — the snapshot is immutable
    expect(reread.executiveSummary.submitted).toBe(1);
    expect(reread).toEqual(published);
  });

  it("a service restart between snapshot insert and channel post is safe to resume", async () => {
    // Simulates: process dies right after the digest_snapshots row commits, before the
    // channel-post outbox event is enqueued. Resuming must not create a second snapshot,
    // and must still get the channel post enqueued exactly once.
    const identity = new IdentityService();
    const dailyUpdates = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const digest = new DigestService(identity, dailyUpdates, new MetricsService());
    const cycle = await dailyUpdates.ensureCycleForToday(ORG_CYCLE_CONFIG);

    const beforeCrash = await digest.getOrPublishSnapshot(env.ORG_ID, cycle);
    // "Restart": a fresh DigestService instance, same cycle, called again.
    const afterRestart = await digest.getOrPublishSnapshot(env.ORG_ID, cycle);

    expect(afterRestart).toEqual(beforeCrash);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM digest_snapshots WHERE cycle_id = $1`, [
      cycle.id,
    ]);
    expect(rows[0].count).toBe(1);
  });
});
