import type { AuditService } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import * as repo from "./repository.js";

export class AdministrationService {
  constructor(
    private readonly identity: IdentityService,
    private readonly audit: AuditService
  ) {}

  getOrganization = repo.getOrganization;
  getDigestChannel = repo.getDigestChannel;
  listIntegrationFailures = repo.listIntegrationFailures;
  getJiraProjectByKey = repo.getJiraProjectByKey;
  listJiraProjects = repo.listJiraProjects;

  async configureJiraProject(actorUserId: string, organizationId: string, projectKey: string, isQaProject: boolean) {
    await this.requireAdmin(actorUserId);
    const project = await repo.upsertJiraProject(organizationId, projectKey, isQaProject);
    await this.audit.record({
      organizationId,
      actorUserId,
      action: "jira_project.configure",
      targetType: "jira_project",
      targetId: project.id,
      details: { projectKey, isQaProject },
    });
    return project;
  }

  async requireAdmin(actorUserId: string): Promise<void> {
    await this.identity.requireRole(actorUserId, "administrator");
  }

  async configureOrganization(
    actorUserId: string,
    org: Parameters<typeof repo.upsertOrganization>[0]
  ) {
    await this.requireAdmin(actorUserId);
    const result = await repo.upsertOrganization(org);
    await this.audit.record({
      organizationId: org.id,
      actorUserId,
      action: "organization.configure",
      targetType: "organization",
      targetId: org.id,
      details: org,
    });
    return result;
  }

  async setDigestChannel(actorUserId: string, organizationId: string, teamId: string, channelId: string) {
    await this.requireAdmin(actorUserId);
    await repo.setDigestChannel(organizationId, teamId, channelId);
    await this.audit.record({
      organizationId,
      actorUserId,
      action: "digest_channel.configure",
      targetType: "teams_installations",
      targetId: channelId,
      details: { teamId, channelId },
    });
  }

  async setUserEnabled(actorUserId: string, organizationId: string, targetUserId: string, enabled: boolean) {
    await this.requireAdmin(actorUserId);
    await this.identity.setUserEnabled(targetUserId, enabled);
    await this.audit.record({
      organizationId,
      actorUserId,
      action: enabled ? "user.enable" : "user.disable",
      targetType: "user",
      targetId: targetUserId,
    });
  }
}
