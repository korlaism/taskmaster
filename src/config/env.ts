import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ORG_ID: z.string().uuid(),
  ORG_TIMEZONE: z.string().min(1),
  ORG_DEFAULT_REMINDER_TIME: z.string().regex(/^\d{2}:\d{2}$/),
  ORG_DEFAULT_CUTOFF_TIME: z.string().regex(/^\d{2}:\d{2}$/),
  ORG_DEFAULT_DIGEST_PUBLISH_TIME: z.string().regex(/^\d{2}:\d{2}$/),
  API_PORT: z.coerce.number().default(3978),
  ADMIN_PORT: z.coerce.number().default(3979),
  SCHEDULER_TICK_INTERVAL_MS: z.coerce.number().default(15000),
  LOG_LEVEL: z.string().default("info"),
  OTEL_SERVICE_NAME: z.string().default("taskmaster"),

  // --- teams-adapter ---
  // 'live' requires a real Entra app registration + Azure Bot resource — see
  // docs/02-teams-permissions-and-installation.md. Never live-tested (see docs/00).
  TEAMS_ADAPTER_MODE: z.enum(["local-sim", "live"]).default("local-sim"),
  CLIENT_ID: z.string().optional(),
  CLIENT_SECRET: z.string().optional(),
  TENANT_ID: z.string().optional(),

  // --- jira-integration ---
  JIRA_ADAPTER_MODE: z.enum(["fake", "live"]).default("fake"),
  JIRA_BASE_URL: z.string().default("https://simnovus.atlassian.net"),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_WEBHOOK_SECRET: z.string().optional(),

  // --- git-integration ---
  GIT_PROVIDER_MODE: z.enum(["none", "github"]).default("none"),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  // comma-separated "owner/repo" list this org tracks, e.g. "gauravsimnovus/taskmaster"
  GITHUB_REPOS: z.string().default(""),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;

export const githubRepos: string[] = env.GITHUB_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
