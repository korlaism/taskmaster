import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { fixedClock } from "../../src/shared/clock.js";
import { ConflictError } from "../../src/shared/errors.js";
import { DailyUpdatesService } from "../../src/modules/daily-updates/index.js";
import { FakeJiraAdapter } from "../../src/modules/jira-integration/index.js";
import { pool } from "../../src/shared/db.js";
import { resetDatabase } from "../support/reset-db.js";
import { seedOrganization, seedUser } from "../support/seed.js";

const ORG_CYCLE_CONFIG = {
  id: env.ORG_ID,
  timezone: "America/New_York",
  updateCutoffTime: "16:00",
  digestPublishTime: "17:00",
};

describe("daily-updates: idempotent + revisable submissions", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("a duplicate submission with the same idempotency key creates exactly one row and does not error", async () => {
    const user = await seedUser("Ada");
    const service = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const cycle = await service.ensureCycleForToday(ORG_CYCLE_CONFIG);

    const key = randomUUID();
    const first = await service.submit({
      cycleId: cycle.id,
      userId: user.id,
      status: "submitted",
      completedToday: "Wrote the parser",
      idempotencyKey: key,
    });
    const second = await service.submit({
      cycleId: cycle.id,
      userId: user.id,
      status: "submitted",
      completedToday: "Wrote the parser",
      idempotencyKey: key,
    });

    expect(first.isNewRevision).toBe(true);
    expect(second.isNewRevision).toBe(false);
    expect(second.submission.id).toBe(first.submission.id);

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM update_submissions WHERE cycle_id = $1`, [
      cycle.id,
    ]);
    expect(rows[0].count).toBe(1);
  });

  it("a revision (new idempotency key) updates the same row rather than inserting a second one", async () => {
    const user = await seedUser("Grace");
    const service = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const cycle = await service.ensureCycleForToday(ORG_CYCLE_CONFIG);

    const first = await service.submit({
      cycleId: cycle.id,
      userId: user.id,
      status: "submitted",
      completedToday: "First draft of the summary",
      idempotencyKey: randomUUID(),
    });
    const revised = await service.submit({
      cycleId: cycle.id,
      userId: user.id,
      status: "submitted",
      completedToday: "Revised summary with more detail",
      idempotencyKey: randomUUID(),
    });

    expect(revised.isNewRevision).toBe(true);
    expect(revised.submission.id).toBe(first.submission.id);
    expect(revised.submission.completedToday).toBe("Revised summary with more detail");

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM update_submissions WHERE cycle_id = $1`, [
      cycle.id,
    ]);
    expect(rows[0].count).toBe(1);
  });

  it("rejects a submission made after the cycle's cutoff", async () => {
    const user = await seedUser("Linus");
    const beforeCutoff = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const cycle = await beforeCutoff.ensureCycleForToday(ORG_CYCLE_CONFIG);

    const afterCutoff = new DailyUpdatesService(fixedClock("2026-01-15T22:00:00.000Z"), new FakeJiraAdapter());
    await expect(
      afterCutoff.submitFromCard(cycle, {
        cycleId: cycle.id,
        userId: user.id,
        idempotencyKey: randomUUID(),
        intent: "submit",
        completedToday: "too late",
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("two users on the same cycle each get their own submission row", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const service = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const cycle = await service.ensureCycleForToday(ORG_CYCLE_CONFIG);

    await service.submit({ cycleId: cycle.id, userId: alice.id, status: "submitted", idempotencyKey: randomUUID() });
    await service.submit({ cycleId: cycle.id, userId: bob.id, status: "skipped", skipReason: "PTO", idempotencyKey: randomUUID() });

    const submissions = await service.listSubmissionsForCycle(cycle.id);
    expect(submissions).toHaveLength(2);
    const missing = await service.listMissingSubmissions(cycle.id, [alice.id, bob.id]);
    expect(missing).toHaveLength(0);
  });
});
