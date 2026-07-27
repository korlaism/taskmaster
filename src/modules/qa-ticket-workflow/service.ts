import type { AuditService } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { JiraClient } from "../jira-integration/index.js";
import type { QaTicketFormPayload, QaTicketRequest } from "./domain.js";
import * as repo from "./repository.js";

export class QaTicketWorkflowService {
  constructor(
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
    private readonly jira: JiraClient
  ) {}

  async createTicket(params: {
    organizationId: string;
    requesterId: string;
    jiraProjectId: string;
    jiraProjectKey: string;
    form: QaTicketFormPayload;
    idempotencyKey: string;
  }): Promise<QaTicketRequest> {
    await this.identity.requireRole(params.requesterId, "qa");

    const { request, isNew } = await repo.createPending({
      organizationId: params.organizationId,
      requesterId: params.requesterId,
      jiraProjectId: params.jiraProjectId,
      formPayload: params.form,
      idempotencyKey: params.idempotencyKey,
    });
    if (!isNew) return request; // retried card action; ticket already created or in flight

    // Screens differ per project/issue type — validate against live createmeta rather
    // than a hardcoded field list.
    const requiredFields = (await this.jira.getCreateMeta(params.jiraProjectKey, params.form.issueType)).filter(
      (f) => f.required
    );
    const missing = requiredFields.filter((f) => !(f.fieldId in params.form) && !["summary", "description"].includes(f.fieldId));
    if (missing.length > 0) {
      await repo.markFailed(request.id);
      throw new Error(`Missing required Jira fields for this project/issue type: ${missing.map((f) => f.name).join(", ")}`);
    }

    try {
      const created = await this.jira.createIssue({
        projectKey: params.jiraProjectKey,
        issueType: params.form.issueType,
        summary: params.form.summary,
        description: params.form.description,
        fields: {
          severity: params.form.severity,
          component: params.form.component,
          environment: params.form.environment,
          stepsToReproduce: params.form.stepsToReproduce,
          expectedResult: params.form.expectedResult,
          actualResult: params.form.actualResult,
          evidenceLinks: params.form.evidenceLinks,
          relatedIssueKey: params.form.relatedIssueKey,
          suggestedAssigneeExternalId: params.form.suggestedAssigneeExternalId,
        },
      });
      await repo.markCreated(request.id, created.issueKey);
      await this.audit.record({
        organizationId: params.organizationId,
        actorUserId: params.requesterId,
        action: "qa_ticket.create",
        targetType: "jira_issue",
        targetId: created.issueKey,
        details: { source: "teams_qa_workflow" },
      });
      return { ...request, status: "created", issueKey: created.issueKey };
    } catch (err) {
      await repo.markFailed(request.id);
      throw err;
    }
  }
}
