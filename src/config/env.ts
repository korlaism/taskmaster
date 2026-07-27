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
  TEAMS_ADAPTER_MODE: z.enum(["local-sim"]).default("local-sim"),
  JIRA_ADAPTER_MODE: z.enum(["fake"]).default("fake"),
  SCHEDULER_TICK_INTERVAL_MS: z.coerce.number().default(15000),
  LOG_LEVEL: z.string().default("info"),
  OTEL_SERVICE_NAME: z.string().default("taskmaster"),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
