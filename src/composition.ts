import { App } from "@microsoft/teams.apps";
import { env, githubRepos } from "./config/env.js";
import { systemClock } from "./shared/clock.js";
import { AdministrationService } from "./modules/administration/index.js";
import * as administrationRepo from "./modules/administration/repository.js";
import { AuditService } from "./modules/audit/index.js";
import { DailyUpdatesService } from "./modules/daily-updates/index.js";
import { DigestService } from "./modules/digest/index.js";
import { GitHubProvider, type GitProvider } from "./modules/git-integration/index.js";
import { IdentityService } from "./modules/identity/index.js";
import { FakeJiraAdapter, JiraCloudAdapter, type JiraClient } from "./modules/jira-integration/index.js";
import { MetricsService } from "./modules/metrics/index.js";
import { NotificationsService } from "./modules/notifications/index.js";
import { QaTicketWorkflowService } from "./modules/qa-ticket-workflow/index.js";
import { NoopPolicyEngine, ReviewWorkflowService } from "./modules/review-workflow/index.js";
import { SchedulerService } from "./modules/scheduler/index.js";
import { LocalSimTeamsClient, TeamsAdapterService, TeamsAppClient, type TeamsClient } from "./modules/teams-adapter/index.js";
import { UserPreferencesService } from "./modules/user-preferences/index.js";

export interface CreateAppContextOptions {
  /**
   * Only relevant in TEAMS_ADAPTER_MODE=live. api.ts constructs its own App bound to
   * an ExpressAdapter (so it can both receive activities and send proactively) and
   * passes it in here; worker.ts (no HTTP surface of its own) omits this and gets a
   * send-only App built from CLIENT_ID/CLIENT_SECRET/TENANT_ID instead.
   */
  teamsApp?: App;
}

export function createAppContext(opts: CreateAppContextOptions = {}) {
  const clock = systemClock;

  const audit = new AuditService();
  const identity = new IdentityService();
  const userPreferences = new UserPreferencesService();
  const administration = new AdministrationService(identity, audit);

  const teamsClient: TeamsClient = createTeamsClient(opts.teamsApp);
  const teamsAdapter = new TeamsAdapterService(teamsClient);

  const jira: JiraClient = createJiraClient();
  const gitProvider: GitProvider | null = createGitProvider();

  const dailyUpdates = new DailyUpdatesService(clock, jira);
  const metrics = new MetricsService();
  const scheduler = new SchedulerService(clock);
  const notifications = new NotificationsService(clock);
  const reviewWorkflow = new ReviewWorkflowService(identity, audit, new NoopPolicyEngine(), notifications);
  const digest = new DigestService(identity, dailyUpdates, metrics, reviewWorkflow);
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
    gitProvider,
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

function createTeamsClient(teamsApp: App | undefined): TeamsClient {
  if (env.TEAMS_ADAPTER_MODE !== "live") {
    return new LocalSimTeamsClient();
  }
  if (teamsApp) {
    return new TeamsAppClient(teamsApp);
  }
  // worker.ts: no HTTP surface of its own, so a send-only App (no httpServerAdapter).
  const app = new App({ clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, tenantId: env.TENANT_ID });
  return new TeamsAppClient(app);
}

function createJiraClient(): JiraClient {
  if (env.JIRA_ADAPTER_MODE !== "live") {
    return new FakeJiraAdapter();
  }
  if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
    throw new Error("JIRA_ADAPTER_MODE=live requires JIRA_EMAIL and JIRA_API_TOKEN to be set");
  }
  return new JiraCloudAdapter({
    baseUrl: env.JIRA_BASE_URL,
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
    webhookSharedSecret: env.JIRA_WEBHOOK_SECRET,
  });
}

function createGitProvider(): GitProvider | null {
  if (env.GIT_PROVIDER_MODE !== "github") return null;
  if (!env.GITHUB_TOKEN) {
    throw new Error("GIT_PROVIDER_MODE=github requires GITHUB_TOKEN to be set");
  }
  return new GitHubProvider({ token: env.GITHUB_TOKEN, repos: githubRepos, webhookSecret: env.GITHUB_WEBHOOK_SECRET });
}

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
