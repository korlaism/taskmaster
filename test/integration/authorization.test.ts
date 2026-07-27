import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { AuditService } from "../../src/modules/audit/index.js";
import { IdentityService } from "../../src/modules/identity/index.js";
import { NoopPolicyEngine, ReviewWorkflowService } from "../../src/modules/review-workflow/index.js";
import { AuthorizationError } from "../../src/shared/errors.js";
import { resetDatabase } from "../support/reset-db.js";
import { seedOrganization, seedUser } from "../support/seed.js";

describe("authorization: server-side role enforcement", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedOrganization();
  });

  it("rejects a review request whose target reviewer does not hold the lead role", async () => {
    const identity = new IdentityService();
    const reviewWorkflow = new ReviewWorkflowService(identity, new AuditService(), new NoopPolicyEngine());

    const developer = await seedUser("Dev", ["developer"]);
    const notALead = await seedUser("NotLead", ["developer"]);

    await expect(
      reviewWorkflow.requestReview({
        organizationId: env.ORG_ID,
        requesterId: developer.id,
        reviewerId: notALead.id,
        jiraIssueKey: "SIM40-1234",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("allows a review request when the reviewer does hold the lead role, and is auditable", async () => {
    const identity = new IdentityService();
    const audit = new AuditService();
    const reviewWorkflow = new ReviewWorkflowService(identity, audit, new NoopPolicyEngine());

    const developer = await seedUser("Dev2", ["developer"]);
    const lead = await seedUser("Lead1", ["lead"]);

    const request = await reviewWorkflow.requestReview({
      organizationId: env.ORG_ID,
      requesterId: developer.id,
      reviewerId: lead.id,
      jiraIssueKey: "SIM40-1234",
      requesterNote: "please check the edge case",
      idempotencyKey: randomUUID(),
    });
    expect(request.state).toBe("requested");

    const recent = await audit.listRecent(env.ORG_ID);
    expect(recent.some((e: any) => e.action === "review_request.create" && e.target_id === request.id)).toBe(true);
  });

  it("a disabled user cannot perform any role-gated action", async () => {
    const identity = new IdentityService();
    const reviewWorkflow = new ReviewWorkflowService(identity, new AuditService(), new NoopPolicyEngine());

    const developer = await seedUser("SoonDisabled", ["developer"]);
    const lead = await seedUser("Lead2", ["lead"]);
    await identity.setUserEnabled(developer.id, false);

    await expect(
      reviewWorkflow.requestReview({
        organizationId: env.ORG_ID,
        requesterId: developer.id,
        reviewerId: lead.id,
        jiraIssueKey: "SIM40-1",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("evaluateAutoApproval always returns false in V1 (never a source of truth for approval)", async () => {
    const engine = new NoopPolicyEngine();
    const result = await engine.evaluateAutoApproval();
    expect(result).toBe(false);
  });
});
