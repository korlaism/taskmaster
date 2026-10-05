# Assumptions, Unresolved Decisions, Feasibility Risks

> **Superseded in part (2026-10-06):** product direction and build order are now in [12 — Product direction](./12-product-direction.md). Where this doc disagrees, 12 wins.

## Assumptions

- Single organization, single Teams tenant for V1. Multi-tenant SaaS packaging is out of scope.
- Jira Cloud is assumed until confirmed otherwise (see [03-jira-authentication-plan.md](./03-jira-authentication-plan.md)).
- GitHub is assumed as the first real Git provider adapter, behind a `GitProvider` interface (see [04-git-provider-integration-plan.md](./04-git-provider-integration-plan.md)). Not implemented for real in V1 — the vertical slice ships with no Git adapter at all.
- One target team + one standard channel for the digest in V1.
- Node.js 20 LTS, PostgreSQL 16 (PGlite/Postgres 16-alpine in dev; any supported Postgres 14+ in production).
- Teams SDK: Microsoft's current-generation TypeScript SDK family (successor to Bot Framework SDK / TeamsFx). Exact package pins are isolated behind the `teams-adapter` module (see [02](./02-teams-permissions-and-installation.md)).
- Reporting window = rolling org-timezone window from previous cutoff to current cutoff, not server calendar day.
- Single global org calendar (one timezone, one holiday/weekend policy) in V1.
- Roles are additive — a user can be Developer + Lead + QA simultaneously; authorization is checked per action, never per persona.
- Secrets stored via environment/managed secret store (Azure Key Vault assumed in production) — never hardcoded, never committed.
- No production Teams tenant or Azure subscription was available while building this V1 slice, so "run locally" means: full business logic + a real Postgres running for real, with a **local simulation harness** standing in for the live Teams client. Wiring the real Teams SDK against a live M365 dev tenant is a documented next step (see [10-local-development.md](./10-local-development.md)).

## Unresolved integration decisions

These need an organizational answer before the corresponding *real* adapter is built. Everything downstream is written against a stable interface so answering these later never becomes a rewrite.

| Decision | Why it matters | V1 handling |
|---|---|---|
| Jira Cloud vs Data Center | OAuth 2.0 3LO vs PAT/service account; different REST/webhook shapes | `FakeJiraAdapter` implements `JiraClient`; ask before real build |
| Git provider (GitHub/GitLab/Bitbucket) | Different webhook payloads, review APIs, App vs PAT auth | `GitProvider` interface only, no implementation yet |
| Final Teams SDK package pin | Microsoft's naming is actively in transition | Isolated behind `teams-adapter`; local-sim used for the slice |
| Identity-linking bootstrap | How do Entra↔Jira↔Git accounts get associated initially (email match, admin CSV import, self-service `/link` flow)? | `external_identities` table + manual admin linking for now |
| Hosting target (Azure App Service / AKS / on-prem) | Affects secrets, scaling, distributed-lock story | Assume Postgres-only distributed locking (`SELECT ... FOR UPDATE SKIP LOCKED`), no Redis dependency |
| Are "leads" global or per-team/per-project reviewer routing? | Changes review-request UI (single list vs scoped list) | Assume a single flat lead list for V1 |
| Should "Approve" ever call the Git provider's native review API? | Spec requires this OFF unless explicit + safe | Hard-coded off in V1; `executeApproval` throws — human-only, recorded, never executed automatically |
| Are QA-issue dynamic fields needed for all Jira projects or only the QA-designated project(s)? | Per-project `createmeta` discovery is nontrivial | Scoped to admin-configured QA project(s) only |

## Feasibility risks

- **Proactive messaging bootstrap.** Teams can't be proactively messaged until a conversation reference exists, which requires the user to have triggered app install/personal chat at least once. Needs a "first contact" flow (welcome message on personal-app-install event, plus admin visibility into who's never connected) — a user who never opens the app can silently never get reminders. Confirmed in the vertical slice: a reminder attempted before install fails gracefully and is *not* retried later that day (see the design note in [09](./09-development-phases.md) about job dedupe keys being date-scoped).
- **Adaptive Card limits.** Dynamic Jira ticket lists and per-person digest sections can exceed card body/action-count limits. The digest card already truncates to the top 15 people with a "see full report in app" note; the daily-update card's suggestion list needs the same treatment once real Jira data can produce more than a handful of suggestions.
- **Dynamic Jira field validation** (QA ticket creation) adds real complexity — different projects/issue types have different required-field screens; the QA workflow validates against `getCreateMeta` and fails closed rather than submitting a malformed issue.
- **Timezone/DST correctness.** Reminder and cutoff scheduling is tested explicitly across DST boundaries (`test/unit/timezone.test.ts`), not just "same wall-clock time daily."
- **Multi-instance scheduler.** Two workers must never send the same reminder or publish the same digest twice. `SELECT ... FOR UPDATE SKIP LOCKED` avoids adding Redis; `test/integration/scheduler-concurrency.test.ts` proves two concurrent claimers never claim the same job.
- **Provider rate limits.** Jira 429/Retry-After and Git provider secondary rate limits need backoff baked into the adapter layer from day one — the outbox dispatcher's exponential backoff is the mechanism any real adapter's transient failures flow through.
- **Digest publish-once under restart.** The process can die mid-publish; `digest_snapshots` has a unique constraint on `cycle_id`, and the channel-post outbox event is dedupe-keyed by cycle — `test/integration/digest.test.ts` proves resuming after a simulated crash doesn't duplicate either.
- **Thundering herd.** If many developers share the same default reminder time, sending all their proactive cards at once risks Teams throttling. The outbox dispatcher's per-event retry/backoff absorbs individual 429s; a production rollout should also consider jittering `ensureDailyRemindersScheduled`'s per-user scheduled time by a few seconds — not yet implemented, flagged here for the next phase.
