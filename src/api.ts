import { randomUUID } from "node:crypto";
import express from "express";
import { env } from "./config/env.js";
import { bootstrapOrganizationFromEnv, createAppContext, type AppContext } from "./composition.js";
import { runOneTick } from "./runtime-tick.js";
import { AppError } from "./shared/errors.js";
import { childLogger } from "./shared/logger.js";
import { startTelemetry } from "./shared/telemetry.js";
import { createLocalSimRouter, type LocalSimTeamsClient } from "./modules/teams-adapter/index.js";
import { parseQaTicketSubmission } from "./modules/qa-ticket-workflow/index.js";

const log = childLogger({ module: "api" });

async function main() {
  startTelemetry();
  await bootstrapOrganizationFromEnv();

  const app = express();
  app.use(express.json());

  // In live mode, the Teams App needs to be built against THIS express instance
  // (ExpressAdapter registers the /api/messages route on it) before the rest of the
  // app context is constructed, since teamsAdapter/teamsClient depend on it.
  const teamsApp = env.TEAMS_ADAPTER_MODE === "live" ? await setupLiveTeamsApp(app) : undefined;
  const ctx = createAppContext({ teamsApp });
  if (teamsApp) registerTeamsHandlers(teamsApp, ctx);

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
  // Only meaningful in local-sim mode — in live mode, install.add (registered below)
  // does this for real.
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

  app.post("/admin/jira-projects", async (req, res, next) => {
    try {
      const { actorUserId, projectKey, isQaProject } = req.body as {
        actorUserId: string;
        projectKey: string;
        isQaProject?: boolean;
      };
      const project = await ctx.administration.configureJiraProject(actorUserId, env.ORG_ID, projectKey, !!isQaProject);
      res.json(project);
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

  // --- Review workflow: "Request review for SIM40-1234 from Lead Name" and the
  // reviewer's Acknowledge/Approve/Needs-changes response, both reachable over HTTP
  // for local-sim/dev testing; the real Teams card wires into the same service calls
  // (see registerTeamsHandlers below). ---
  app.post("/reviews/request", async (req, res, next) => {
    try {
      const body = req.body as {
        requesterId: string;
        reviewerId: string;
        jiraIssueKey: string;
        pullRequestUrl?: string;
        branchName?: string;
        commitSha?: string;
        requesterNote?: string;
        idempotencyKey: string;
      };
      const request = await ctx.reviewWorkflow.requestReview({ organizationId: env.ORG_ID, ...body });
      res.status(201).json(request);
    } catch (err) {
      next(err);
    }
  });

  app.post("/reviews/:id/decision", async (req, res, next) => {
    try {
      const { actorUserId, decision } = req.body as { actorUserId: string; decision: string };
      await ctx.reviewWorkflow.recordDecision({
        organizationId: env.ORG_ID,
        reviewId: req.params.id,
        actingUserId: actorUserId,
        decision: decision as any,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- QA ticket workflow ---
  app.post("/qa-tickets", async (req, res, next) => {
    try {
      const body = req.body as { requesterId: string; projectKey: string } & Record<string, unknown>;
      const project = await ctx.administration.getJiraProjectByKey(env.ORG_ID, body.projectKey);
      if (!project) throw new AppError(`Unknown Jira project key: ${body.projectKey}`, "not_found");
      const { form, idempotencyKey } = parseQaTicketSubmission(body);
      const result = await ctx.qaTicketWorkflow.createTicket({
        organizationId: env.ORG_ID,
        requesterId: body.requesterId,
        jiraProjectId: project.id,
        jiraProjectKey: project.projectKey,
        form,
        idempotencyKey,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  if (env.TEAMS_ADAPTER_MODE === "local-sim") {
    app.use(createLocalSimRouter(ctx.teamsClient as LocalSimTeamsClient));
  }

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

/**
 * Builds the live Teams App bound to this process's Express server. UNVERIFIED
 * against a real tenant (see docs/00, docs/02) — written against @microsoft/teams.apps'
 * published types and Microsoft Learn's documented quickstart pattern.
 */
async function setupLiveTeamsApp(expressApp: express.Express) {
  const { App, ExpressAdapter } = await import("@microsoft/teams.apps");
  const adapter = new ExpressAdapter(expressApp);
  const teamsApp = new App({
    httpServerAdapter: adapter,
    clientId: env.CLIENT_ID,
    clientSecret: env.CLIENT_SECRET,
    tenantId: env.TENANT_ID,
  });
  await teamsApp.initialize();
  return teamsApp;
}

/**
 * Wires the real Teams activity handlers to the SAME service methods the HTTP routes
 * above call — the card payload shapes are the single contract both entry points
 * parse, so there's only one place that logic can drift.
 */
function registerTeamsHandlers(teamsApp: import("@microsoft/teams.apps").App, ctx: AppContext) {
  teamsApp.on("install.add", async ({ activity }) => {
    const isPersonal = activity.conversation.conversationType === "personal";
    if (isPersonal) {
      const user = await ctx.identity.ensureUser({
        organizationId: env.ORG_ID,
        entraObjectId: activity.from.aadObjectId ?? activity.from.id,
        displayName: activity.from.name ?? "Unknown",
        email: null,
      });
      await ctx.teamsAdapter.captureConversationReference({
        organizationId: env.ORG_ID,
        subjectType: "user",
        subjectId: user.id,
        serviceUrl: activity.serviceUrl ?? "",
        conversationId: activity.conversation.id,
        tenantId: activity.conversation.tenantId ?? "",
      });
    } else {
      // Team/channel install — channelId extraction from channelData is best-effort
      // and unverified against a real payload; see docs/02.
      const channelId = ((activity as any).channelData?.channel?.id as string | undefined) ?? activity.conversation.id;
      const teamId = ((activity as any).channelData?.team?.id as string | undefined) ?? activity.conversation.id;
      await ctx.teamsAdapter.captureConversationReference({
        organizationId: env.ORG_ID,
        subjectType: "channel",
        subjectId: channelId,
        serviceUrl: activity.serviceUrl ?? "",
        conversationId: activity.conversation.id,
        tenantId: activity.conversation.tenantId ?? "",
      });
      // Registering this as THE digest channel on every install event is a POC
      // simplification — production should require an explicit admin confirmation
      // step rather than auto-adopting whichever channel the app was added to last.
      log.info({ teamId, channelId }, "team/channel install captured — admin must still confirm via setDigestChannel");
    }
  });

  teamsApp.on("message", async ({ activity }) => {
    const value = activity.value as Record<string, unknown> | undefined;
    if (!value) return; // plain text message, no card action in this app

    try {
      if (value.cycleId && value.userId && value.idempotencyKey) {
        const cycle = await ctx.dailyUpdates.getCycleById(String(value.cycleId));
        if (cycle) await ctx.dailyUpdates.submitFromCard(cycle, value);
        return;
      }
      if (value.reviewId && value.decision) {
        const actingUser = await ctx.identity.ensureUser({
          organizationId: env.ORG_ID,
          entraObjectId: activity.from.aadObjectId ?? activity.from.id,
          displayName: activity.from.name ?? "Unknown",
          email: null,
        });
        await ctx.reviewWorkflow.recordDecision({
          organizationId: env.ORG_ID,
          reviewId: String(value.reviewId),
          actingUserId: actingUser.id,
          decision: value.decision as any,
        });
        return;
      }
      if (value.projectKey && value.idempotencyKey) {
        const requester = await ctx.identity.ensureUser({
          organizationId: env.ORG_ID,
          entraObjectId: activity.from.aadObjectId ?? activity.from.id,
          displayName: activity.from.name ?? "Unknown",
          email: null,
        });
        const project = await ctx.administration.getJiraProjectByKey(env.ORG_ID, String(value.projectKey));
        if (!project) return;
        const { form, idempotencyKey } = parseQaTicketSubmission(value);
        await ctx.qaTicketWorkflow.createTicket({
          organizationId: env.ORG_ID,
          requesterId: requester.id,
          jiraProjectId: project.id,
          jiraProjectKey: project.projectKey,
          form,
          idempotencyKey,
        });
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, "failed to process card action from Teams");
    }
  });
}

main().catch((err) => {
  log.error({ err: err.message }, "api failed to start");
  process.exit(1);
});
