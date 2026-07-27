# Architecture Decision Record

## ADR-1: Modular monolith, not microservices, for V1

**Decision.** One codebase, two runtime entrypoints (`src/api.ts`, `src/worker.ts`), fourteen modules under `src/modules/*` with enforced boundaries: a module's `repository.ts` is never imported by another module, only its `service.ts`/`index.ts` public surface is.

**Why.** The product surface (Teams, Jira, Git, scheduling, review, QA, digest) is wide but the team and data volume for V1 is small. Microservices would add network boundaries, deployment complexity, and distributed-transaction problems (e.g. "did the reminder both get scheduled and recorded?") that a single Postgres transaction solves for free. Module boundaries are kept strict specifically so this can be split later without a rewrite — each module already has its own domain types, its own repository, and never reaches into another module's tables directly.

**Consequence.** Cross-module calls are plain async function calls, not HTTP/queue hops, in V1. Splitting a module out later means giving it its own process and turning those calls into RPC/queue calls — the module's internal logic doesn't change.

## ADR-2: Outbox pattern for every durable side effect

**Decision.** Any action that must reliably trigger an external effect (send a Teams card, post to a channel, later: write to Jira/Git) writes an `outbox_events` row in the same transaction as the domain state change, and a separate dispatcher (`NotificationsService.dispatchDue`) delivers it with retry/backoff/dead-letter, claimed via `SELECT ... FOR UPDATE SKIP LOCKED`.

**Why.** The spec requires retries, idempotency, dead-letter, and manual replay for "all notification jobs" — and requires that a crash never produce a duplicate send. A naive "just call the Teams API inline" approach can't survive a process crash between "decided to send" and "actually sent." The outbox table makes that boundary durable and inspectable (`GET` a dead-letter list, `replayDeadLetter`).

**Consequence.** Every side effect has a stable `dedupe_key`. Callers derive it deterministically (e.g. `dedupeKey(orgId, 'send_reminder_card', jobId)`) rather than generating a fresh UUID per attempt, or retries would create duplicate rows instead of being no-ops.

## ADR-3: Two-tier scheduling — `notification_jobs` decides *when*, `outbox_events` decides *how reliably*

**Decision.** `SchedulerService` is responsible only for "is this due, and has exactly one worker claimed it" (`notification_jobs`). It never talks to Teams/Jira/Git directly — its job handlers only enqueue an outbox event. `NotificationsService` is responsible only for "keep retrying this side effect until it succeeds or dies."

**Why.** Conflating the two would mean a transient Teams 429 and "is this reminder due" share retry/backoff state, which is wrong: a due-reminder claim should never be retried (it either fires once or is abandoned for the day), while a Teams delivery failure should be retried with backoff. Separating them means a stuck 5-minute claim lease (crash recovery) and outbox backoff (external-API flakiness) are independently tunable.

**Consequence.** A `notification_jobs` row stuck in `claimed` past a lease window (default 5 minutes) is reclaimed to `pending` by the next tick — this is what makes "the service restarts during digest publication" safe (see `test/integration/scheduler-concurrency.test.ts`).

## ADR-4: Postgres advisory/row locking instead of a distributed lock service

**Decision.** Concurrency safety for the scheduler and outbox both come from `SELECT ... FOR UPDATE SKIP LOCKED` against Postgres, not Redis/Zookeeper/etc.

**Why.** V1 has one durable dependency already (Postgres) and the product spec explicitly allows "distributed locking or equivalent protection" — SKIP LOCKED is the standard equivalent for a job-queue-over-a-table pattern and avoids introducing a second stateful dependency before it's justified by real scale.

**Consequence.** Throughput is bounded by a single Postgres instance's row-lock contention, which is fine at the scale this product targets (per-organization daily reminders/digest, not a high-frequency queue). Revisit if a future phase needs cross-organization horizontal scale.

## ADR-5: `teams-adapter` and `jira-integration` isolate every unresolved external dependency

**Decision.** `TeamsClient` and `JiraClient` are interfaces first, concrete adapters second. V1 ships `LocalSimTeamsClient` and `FakeJiraAdapter`; `GitProvider` (in `git-integration`) has no implementation at all yet.

**Why.** Three integration decisions are explicitly unresolved (Teams SDK package, Jira Cloud vs Data Center, Git provider choice — see [00](./00-assumptions-and-risks.md)). Writing business logic against interfaces means those decisions can be made independently, on their own timeline, without blocking daily-updates/scheduler/digest development or requiring a rewrite once made.

**Consequence.** The vertical slice is honestly a *workflow-logic* proof, not a *Teams/Jira* integration proof. Anyone evaluating it should look at `test/integration/*` and the manual smoke test in [10-local-development.md](./10-local-development.md), not expect to open a real Teams client yet.

## ADR-6: The policy engine is a seam, not a feature, in V1

**Decision.** `PolicyEngine` (`evaluateAutoApproval`, `produceReviewRecommendation`, `executeApproval`) is defined in `review-workflow/domain.ts`; the only V1 implementation, `NoopPolicyEngine`, returns `false`/`null`/throws respectively.

**Why.** The product spec is explicit: an LLM or policy engine must never be the source of truth for workflow state or metrics, and V1 approval must always be a recorded human action. Defining the interface now — rather than skipping it until "the AI phase" — means the review-workflow's audit trail, state machine, and Teams card are already shaped correctly for a future engine to plug into without changing the request/response contract developers and leads see today.

**Consequence.** `evaluateAutoApproval` is called (and its result logged) on every decision today, purely so the call site already exists; its `false` return never short-circuits `recordDecision`'s requirement that a lead actually acted.
