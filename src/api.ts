import { randomUUID } from "node:crypto";
import express from "express";
import { env } from "./config/env.js";
import { bootstrapOrganizationFromEnv, createAppContext } from "./composition.js";
import { runOneTick } from "./runtime-tick.js";
import { AppError } from "./shared/errors.js";
import { childLogger } from "./shared/logger.js";
import { startTelemetry } from "./shared/telemetry.js";
import { createLocalSimRouter } from "./modules/teams-adapter/index.js";

const log = childLogger({ module: "api" });

async function main() {
  startTelemetry();
  await bootstrapOrganizationFromEnv();
  const ctx = createAppContext();

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // --- Dev-only bootstrap: creates the very first user(s) so admin/config routes
  // below have someone with the 'administrator' role to authenticate as. Everything
  // after this point goes through normal server-side role checks — this endpoint is
  // the one deliberate exception, and it exists only to solve the chicken-and-egg
  // problem of configuring an app that has zero users yet.
  app.post("/dev/users", async (req, res, next) => {
    try {
      const { entraObjectId, displayName, email, roles } = req.body as {
        entraObjectId: string;
        displayName: string;
        email?: string;
        roles?: string[];
      };
      const user = await ctx.identity.ensureUser({
        organizationId: env.ORG_ID,
        entraObjectId,
        displayName,
        email: email ?? null,
      });
      for (const role of roles ?? ["developer"]) {
        await ctx.identity.assignRole(user.id, role as any);
      }
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  // --- Simulated Teams install events (stand-ins for the real activity handler that
  // fires when a user adds the personal app, or the app is added to a team/channel).
  app.post("/teams/install/personal", async (req, res, next) => {
    try {
      const { userId, serviceUrl, conversationId, tenantId } = req.body as {
        userId: string;
        serviceUrl: string;
        conversationId: string;
        tenantId: string;
      };
      await ctx.teamsAdapter.captureConversationReference({
        organizationId: env.ORG_ID,
        subjectType: "user",
        subjectId: userId,
        serviceUrl,
        conversationId,
        tenantId,
      });
      res.status(201).json({ captured: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/teams/install/channel", async (req, res, next) => {
    try {
      const { actorUserId, teamId, channelId, serviceUrl, conversationId, tenantId } = req.body as {
        actorUserId: string;
        teamId: string;
        channelId: string;
        serviceUrl: string;
        conversationId: string;
        tenantId: string;
      };
      await ctx.teamsAdapter.captureConversationReference({
        organizationId: env.ORG_ID,
        subjectType: "channel",
        subjectId: channelId,
        serviceUrl,
        conversationId,
        tenantId,
      });
      await ctx.administration.setDigestChannel(actorUserId, env.ORG_ID, teamId, channelId);
      res.status(201).json({ captured: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Administration ---
  app.post("/admin/organization", async (req, res, next) => {
    try {
      const { actorUserId, ...rest } = req.body as { actorUserId: string } & Record<string, unknown>;
      const org = await ctx.administration.configureOrganization(actorUserId, { id: env.ORG_ID, ...rest } as any);
      res.json(org);
    } catch (err) {
      next(err);
    }
  });

  app.post("/users/:userId/preferences/reminder-time", async (req, res, next) => {
    try {
      await ctx.identity.requireEnabled(req.params.userId);
      const prefs = await ctx.userPreferences.setReminderTimeOverride(req.params.userId, req.body.time ?? null);
      res.json(prefs);
    } catch (err) {
      next(err);
    }
  });

  // --- Adaptive Card submission endpoint (what a real Teams `invoke`/Action.Submit
  // handler forwards into once the real teams-adapter replaces local-sim). ---
  app.post("/cards/daily-update/submit", async (req, res, next) => {
    try {
      const raw = req.body as Record<string, unknown>;
      const cycle = await ctx.dailyUpdates.getCycleById(String(raw.cycleId));
      if (!cycle) throw new AppError("Unknown cycle", "not_found");
      const { submission, isNewRevision } = await ctx.dailyUpdates.submitFromCard(cycle, raw);
      res.json({ submission, isNewRevision });
    } catch (err) {
      next(err);
    }
  });

  app.get("/digest/:cycleId", async (req, res, next) => {
    try {
      const content = await ctx.digest.getSnapshot(req.params.cycleId);
      if (!content) {
        res.status(404).json({ error: "no digest published yet for this cycle" });
        return;
      }
      res.json(content);
    } catch (err) {
      next(err);
    }
  });

  app.use(createLocalSimRouter(ctx.teamsClient));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appErr = err as AppError;
    log.warn({ err: appErr.message, code: appErr.code }, "request failed");
    const status = appErr.code === "authorization_denied" ? 403 : appErr.code === "not_found" ? 404 : 400;
    res.status(status).json({ error: appErr.message ?? "unexpected error" });
  });

  app.listen(env.API_PORT, () => log.info({ port: env.API_PORT }, "api listening"));

  // Local-sim convenience only: the real deployment shape is api.ts (HTTP surface) +
  // worker.ts (scheduler/outbox loop) as two processes. That split only works once a
  // real Teams client replaces LocalSimTeamsClient, because two OS processes can't
  // share the in-memory "last card sent" inbox local-sim relies on for inspection.
  if (env.TEAMS_ADAPTER_MODE === "local-sim") {
    log.info("local-sim mode: running the scheduler/outbox tick loop inline in the api process");
    const workerId = `api-inline-${process.pid}-${randomUUID().slice(0, 8)}`;
    setInterval(async () => {
      try {
        await runOneTick(ctx, workerId);
      } catch (err) {
        log.error({ err: (err as Error).message }, "scheduler tick failed");
      }
    }, env.SCHEDULER_TICK_INTERVAL_MS);
  }
}

main().catch((err) => {
  log.error({ err: err.message }, "api failed to start");
  process.exit(1);
});
