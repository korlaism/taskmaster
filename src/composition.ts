import { env } from "./config/env.js";
import { systemClock } from "./shared/clock.js";
import { AdministrationService } from "./modules/administration/index.js";
import * as administrationRepo from "./modules/administration/repository.js";
import { AuditService } from "./modules/audit/index.js";
import { DailyUpdatesService } from "./modules/daily-updates/index.js";
import { DigestService } from "./modules/digest/index.js";
import { IdentityService } from "./modules/identity/index.js";
import { FakeJiraAdapter } from "./modules/jira-integration/index.js";
import { MetricsService } from "./modules/metrics/index.js";
import { NotificationsService } from "./modules/notifications/index.js";
import { QaTicketWorkflowService } from "./modules/qa-ticket-workflow/index.js";
import { NoopPolicyEngine } from "./modules/review-workflow/index.js";
import { ReviewWorkflowService } from "./modules/review-workflow/index.js";
import { SchedulerService } from "./modules/scheduler/index.js";
import { LocalSimTeamsClient, TeamsAdapterService } from "./modules/teams-adapter/index.js";
import { UserPreferencesService } from "./modules/user-preferences/index.js";

export function createAppContext() {
  const clock = systemClock;

  const audit = new AuditService();
  const identity = new IdentityService();
  const userPreferences = new UserPreferencesService();
  const administration = new AdministrationService(identity, audit);

  const teamsClient = new LocalSimTeamsClient(); // swap point for a real Teams SDK client
  const teamsAdapter = new TeamsAdapterService(teamsClient);

  const jira = new FakeJiraAdapter(); // swap point for a real Jira Cloud/Data Center adapter

  const dailyUpdates = new DailyUpdatesService(clock, jira);
  const metrics = new MetricsService();
  const digest = new DigestService(identity, dailyUpdates, metrics);
  const scheduler = new SchedulerService(clock);
  const notifications = new NotificationsService(clock);
  const reviewWorkflow = new ReviewWorkflowService(identity, audit, new NoopPolicyEngine());
  const qaTicketWorkflow = new QaTicketWorkflowService(identity, audit, jira);

  return {
    clock,
    audit,
    identity,
    userPreferences,
    administration,
    teamsClient,
    teamsAdapter,
    jira,
    dailyUpdates,
    metrics,
    digest,
    scheduler,
    notifications,
    reviewWorkflow,
    qaTicketWorkflow,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;

/**
 * Env-driven bootstrap so a fresh deployment needs no manual database edits: the
 * organization row is upserted from .env on every startup (idempotent). Everything
 * past this — users, roles, channel target — is configured through the
 * administration module's normal (role-checked) API, not by editing the database.
 */
export async function bootstrapOrganizationFromEnv() {
  return administrationRepo.upsertOrganization({
    id: env.ORG_ID,
    name: "Default Organization",
    timezone: env.ORG_TIMEZONE,
    defaultReminderTime: env.ORG_DEFAULT_REMINDER_TIME,
    updateCutoffTime: env.ORG_DEFAULT_CUTOFF_TIME,
    digestPublishTime: env.ORG_DEFAULT_DIGEST_PUBLISH_TIME,
    weekendsDisabled: true,
  });
}
