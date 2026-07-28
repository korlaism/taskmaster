# Development Phases

## Phase 0 — Vertical slice (done)

Personal-scope install capture → scheduled reminder → Adaptive Card → idempotent submission → deterministic (if data-thin) metrics → immutable digest snapshot → channel post, all retry-safe. See [10-local-development.md](./10-local-development.md) for how to run it and `test/` for the automated proof of the idempotency/concurrency/DST properties.

## Phase 1 — Real Teams integration (code complete, live-untested)

- ~~Confirm and pin the actual Teams SDK package~~ — done: `@microsoft/teams.apps`/`@microsoft/teams.api` v2.0.14, confirmed current via npm + Microsoft Learn before writing any code against it.
- ~~Replace `LocalSimTeamsClient` with a real `TeamsClient` implementation~~ — done: `TeamsAppClient` (`src/modules/teams-adapter/real-client.ts`), selected via `TEAMS_ADAPTER_MODE=live`.
- ~~Wire the real activity handler~~ — done: `install.add` → `captureConversationReference`, `message` (carrying `activity.value` from a plain `Action.Submit`) → routed to daily-update/review-decision/QA-ticket handling, all in `src/api.ts`.
- **Remaining**: no Entra app registration / Azure Bot resource existed while building this (see [02](./02-teams-permissions-and-installation.md) for the exact registration steps) — the whole activity-shape assumption (`activity.from.aadObjectId`, `activity.conversation.tenantId`, `channelData.team.id` for team installs) is written against SDK type declarations and docs, not observed from a real payload. Exit criteria: register a real app, set `CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID`, and confirm a real reminder card round-trips before trusting this in production.

## Phase 2 — Real Jira integration (code complete, live-untested)

- ~~Confirm Cloud vs Data Center~~ — Cloud confirmed (`simnovus.atlassian.net`).
- ~~Implement webhook ingestion~~ — `JiraCloudAdapter.normalizeWebhookEvent` done (issue_created/issue_updated → `jira_issue_events`); the reconciliation *job* (periodic JQL re-sync for missed webhooks) is not yet scheduled anywhere — still open.
- ~~Implement `suggestIssuesForReportingWindow`~~ — done, via `/rest/api/3/search/jql` (confirmed current; the older `/rest/api/3/search` was fully removed by Atlassian in August 2025).
- **Remaining**: no live service-account credentials existed while building this — validate against real `simnovus.atlassian.net` data once `JIRA_EMAIL`/`JIRA_API_TOKEN` are set, and stand up the reconciliation job.

## Phase 3 — Review workflow Teams surface (done)

- `ReviewWorkflowService` now sends the reviewer's card via the outbox (`send_review_request_card`, handled in `src/runtime-tick.ts`) after `requestReview` — see [wireframe #2](./07-adaptive-card-wireframes.md).
- ~~Add "stale review requests" to the digest's Attention Required section~~ — done: `ReviewWorkflowService.listStale` feeds `DigestService`.
- Reachable both over HTTP (`POST /reviews/request`, `POST /reviews/:id/decision`, for local-sim/dev testing) and via the real Teams `message` handler once Phase 1's registration is complete.

## Phase 4 — QA ticket workflow Teams surface (done)

- `QaTicketWorkflowService` (dynamic `createmeta` validation, idempotent creation, audit) is now reachable via `POST /qa-tickets` and the Teams card ([wireframe #3](./07-adaptive-card-wireframes.md)), resolving the project key to `jira_projects` via the new `administration.getJiraProjectByKey`/`configureJiraProject`.
- Exit criteria (still open): a QA user creates a **real** Jira issue through Teams once Phase 1 + Phase 2 credentials both exist — the plumbing is done, the live round-trip isn't.

## Phase 5 — Real Git integration (GitHub done and live-validated; other providers not started)

- ~~Confirm provider~~ — GitHub.
- ~~Implement read APIs~~ — done and **live-validated** against a real PR on `gauravsimnovus/taskmaster` (`getPullRequest`, `getPullRequestReviewState`, `getChecks`, `getCommit`, `listPullRequestsForIssue`) — see [04](./04-git-provider-integration-plan.md) for what was specifically confirmed.
- ~~`requestReview`~~ — implemented, not yet exercised live (no review-workflow flow currently triggers a Git-side review request — it only sends the Teams card today).
- **Remaining**: webhook ingestion (ingesting real `push`/`pull_request`/`check_run` events into `commits`/`pull_requests`) is implemented in `GitHubProvider.normalizeWebhookEvent` but nothing calls it yet — there's no webhook receiver route wired up in `src/api.ts`. Until that exists, `commits`/`pull_requests` stay empty in a real deployment and metrics depending on them stay at zero. This is the actual next piece of work for Phase 5, not the read APIs (those are done).
- `approvePullRequest` is implemented but never called from anywhere — wiring it to a UI action requires an explicit organizational decision first (see [ADR-6](./01-architecture-decision-record.md), [08-threat-model.md](./08-threat-model.md)).
- GitLab/Bitbucket: not started.

## Phase 6 — AI summarization / PR-review agent (explicitly deferred, seams already exist)

- The outbox pattern (`aggregate_type: 'jira_action' | 'git_action'`) and the `PolicyEngine` interface are the two seams this phase plugs into.
- Any AI-generated text (e.g. a suggested digest summary sentence) must be clearly labeled as generated and must never replace a metric — metrics stay computed from Jira/Git/submission data per the product's non-negotiable requirement.
- `produceReviewRecommendation` gets a real implementation here; `evaluateAutoApproval` may get a real (non-`false`) implementation only after the organization explicitly opts into it, and even then `executeApproval` should require a human-in-the-loop confirmation step, not silent execution.

## Phase 7 — Multi-tenant / scale hardening (only if needed)

- Row-level security or an application-layer tenant guard (flagged as the biggest gap in [08-threat-model.md](./08-threat-model.md)).
- Reminder-send jitter to avoid synchronized Teams throttling at scale.
- Splitting a module into its own service, if a specific module's load genuinely outgrows the modular monolith — the module boundaries were kept strict from Phase 0 specifically to make this possible without a rewrite.

## What's left before an actual end-to-end demo with real services

1. Register the Teams app (Phase 1's one remaining step) and confirm the activity shapes.
2. Add `JIRA_EMAIL`/`JIRA_API_TOKEN` and confirm `JiraCloudAdapter` against real `simnovus.atlassian.net` data.
3. Add a `/webhooks/github` route calling `GitHubProvider.normalizeWebhookEvent`/`verifyWebhook`, so `commits`/`pull_requests` actually populate from real repo activity (currently only the read-path methods are wired to anything).
4. Then run the full demo script in [10-local-development.md](./10-local-development.md) against real credentials instead of local-sim/fake.
