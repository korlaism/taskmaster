import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { fixedClock, systemClock } from "../../src/shared/clock.js";
import { AdministrationService } from "../../src/modules/administration/index.js";
import { AuditService } from "../../src/modules/audit/index.js";
import { DailyUpdatesService } from "../../src/modules/daily-updates/index.js";
import { DigestService } from "../../src/modules/digest/index.js";
import { IdentityService } from "../../src/modules/identity/index.js";
import { FakeJiraAdapter } from "../../src/modules/jira-integration/index.js";
import { MetricsService } from "../../src/modules/metrics/index.js";
import { NotificationsService } from "../../src/modules/notifications/index.js";
import { QaTicketWorkflowService } from "../../src/modules/qa-ticket-workflow/index.js";
import { NoopPolicyEngine, ReviewWorkflowService } from "../../src/modules/review-workflow/index.js";
import { pool } from "../../src/shared/db.js";
import { resetDatabase } from "../support/reset-db.js";
import { seedOrganization, seedUser } from "../support/seed.js";

const ORG_CYCLE_CONFIG = {
  id: env.ORG_ID,
  timezone: "America/New_York",
  updateCutoffTime: "16:00",
  digestPublishTime: "17:00",
};

describe("review workflow: notification enqueue + staleness", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("requesting review enqueues exactly one outbox event, even if the request is retried with the same key", async () => {
    const identity = new IdentityService();
    const audit = new AuditService();
    const notifications = new NotificationsService(systemClock);
    const reviewWorkflow = new ReviewWorkflowService(identity, audit, new NoopPolicyEngine(), notifications);

    const developer = await seedUser("Dev", ["developer"]);
    const lead = await seedUser("Lead", ["lead"]);
    const key = randomUUID();

    await reviewWorkflow.requestReview({
      organizationId: env.ORG_ID,
      requesterId: developer.id,
      reviewerId: lead.id,
      jiraIssueKey: "SIM40-1",
      idempotencyKey: key,
    });
    await reviewWorkflow.requestReview({
      organizationId: env.ORG_ID,
      requesterId: developer.id,
      reviewerId: lead.id,
      jiraIssueKey: "SIM40-1",
      idempotencyKey: key, // retried card submission
    });

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM outbox_events WHERE event_type = 'send_review_request_card'`
    );
    expect(rows[0].count).toBe(1);
  });

  it("a review request older than the staleness threshold shows up in the digest's attention-required section", async () => {
    const identity = new IdentityService();
    const audit = new AuditService();
    const notifications = new NotificationsService(systemClock);
    const reviewWorkflow = new ReviewWorkflowService(identity, audit, new NoopPolicyEngine(), notifications);
    const dailyUpdates = new DailyUpdatesService(fixedClock("2026-01-15T15:00:00.000Z"), new FakeJiraAdapter());
    const digest = new DigestService(identity, dailyUpdates, new MetricsService(), reviewWorkflow);

    const developer = await seedUser("Dev2", ["developer"]);
    const lead = await seedUser("Lead2", ["lead"]);
    const request = await reviewWorkflow.requestReview({
      organizationId: env.ORG_ID,
      requesterId: developer.id,
      reviewerId: lead.id,
      jiraIssueKey: "SIM40-77",
      idempotencyKey: randomUUID(),
    });
    // Backdate it past the staleness threshold (real code only checks requested_at).
    await pool.query(`UPDATE review_requests SET requested_at = now() - interval '3 days' WHERE id = $1`, [
      request.id,
    ]);

    const cycle = await dailyUpdates.ensureCycleForToday(ORG_CYCLE_CONFIG);
    const content = await digest.getOrPublishSnapshot(env.ORG_ID, cycle);
    expect(content.attentionRequired.staleReviewRequests.some((s) => s.includes("SIM40-77"))).toBe(true);
  });
});

describe("QA ticket workflow: idempotent creation via a real (fake-Jira-backed) service", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("retrying the same ticket-creation submission does not create a second Jira issue", async () => {
    const identity = new IdentityService();
    const audit = new AuditService();
    const administration = new AdministrationService(identity, audit);
    const jira = new FakeJiraAdapter();
    const qaWorkflow = new QaTicketWorkflowService(identity, audit, jira);

    const qaUser = await seedUser("Quinn", ["qa"]);
    const project = await administration.configureJiraProject(
      (await seedUser("Admin", ["administrator"])).id,
      env.ORG_ID,
      "SIM40",
      true
    );

    const key = randomUUID();
    const params = {
      organizationId: env.ORG_ID,
      requesterId: qaUser.id,
      jiraProjectId: project.id,
      jiraProjectKey: project.projectKey,
      form: { jiraProjectId: project.id, issueType: "Bug", summary: "Login fails", description: "Steps..." },
      idempotencyKey: key,
    };

    const first = await qaWorkflow.createTicket(params);
    const second = await qaWorkflow.createTicket(params);

    expect(first.status).toBe("created");
    expect(first.issueKey).toBeTruthy();
    expect(second.issueKey).toBe(first.issueKey);

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM qa_ticket_requests WHERE idempotency_key = $1`, [
      key,
    ]);
    expect(rows[0].count).toBe(1);
  });

  it("rejects ticket creation from a user who does not hold the QA role", async () => {
    const identity = new IdentityService();
    const audit = new AuditService();
    const jira = new FakeJiraAdapter();
    const qaWorkflow = new QaTicketWorkflowService(identity, audit, jira);
    const developer = await seedUser("NotQa", ["developer"]);

    await expect(
      qaWorkflow.createTicket({
        organizationId: env.ORG_ID,
        requesterId: developer.id,
        jiraProjectId: randomUUID(),
        jiraProjectKey: "SIM40",
        form: { jiraProjectId: "x", issueType: "Bug", summary: "x", description: "x" },
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow();
  });
});
