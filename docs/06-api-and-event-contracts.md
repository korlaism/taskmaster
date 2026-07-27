# API and Event Contracts

## HTTP surface (`src/api.ts`)

All routes are JSON in/out. Routes other than `/dev/users` enforce roles server-side via `IdentityService.requireRole`/`requireEnabled` inside the relevant service method — the route handler itself does no authorization logic.

| Method & path | Purpose | Auth | Idempotency |
|---|---|---|---|
| `GET /health` | Liveness probe | none | n/a |
| `POST /dev/users` | **Dev-only.** Create/ensure a user + roles. Exists solely to solve the bootstrap chicken-and-egg problem (no admin exists yet on a fresh org). Not part of the production role-enforced surface. | none (dev-only) | upsert on `(organization_id, entra_object_id)` |
| `POST /teams/install/personal` | Simulates the Teams personal-app-install activity; captures a conversation reference | none (a real handler would derive identity from the Teams activity itself) | upsert on `(organization_id, subject_type, subject_id)` |
| `POST /teams/install/channel` | Simulates the team/channel install; captures the channel's conversation reference and sets it as the digest target | `actorUserId` must hold `administrator` (enforced in `AdministrationService.setDigestChannel`) | insert (channel history is append-only; "current" is the latest `installed_at`) |
| `POST /admin/organization` | Configure org timezone/reminder/cutoff/digest-publish time | `actorUserId` must hold `administrator` | upsert on `organizations.id` |
| `POST /users/:userId/preferences/reminder-time` | Set a user's reminder-time override | user must be enabled (self-service) | upsert on `user_preferences.user_id` |
| `POST /cards/daily-update/submit` | Adaptive Card `Action.Submit` handler — what a real Teams `invoke` activity forwards into once `teams-adapter` is replaced with a real client | cycle cutoff check (`ConflictError` if past cutoff) | `update_submissions.idempotency_key` |
| `GET /digest/:cycleId` | Fetch the published digest snapshot for a cycle | none in V1 (read-only dev inspection route; production should gate to enabled users) | n/a (read-only) |
| `GET /local-sim/cards/:subjectId` | **Dev-only.** Inspect the last card local-sim "delivered" to a user/channel — the stand-in for opening Teams | none (dev-only, mounted only in local-sim mode) | n/a |

## Adaptive Card submission contract (`daily-updates/card.ts`)

Teams merges an `Action.Submit` action's `data` block with every `Input.*` field's current value into one flat object on submit. The daily-update card's contract:

**Outbound (server → card)** — `buildDailyUpdateCard` produces a body with field ids: `ticket_<ISSUE_KEY>` (one `Input.Toggle` per suggested ticket), `additionalTicket`, `completedToday`, `inProgress`, `blockers`, `nextPlanned`, `reviewRequired`, `reviewerName`, `additionalNotes`, `skipReason`. Two actions ("Save draft" / "Submit update") both carry `{ cycleId, userId, idempotencyKey, intent }` in their `data` block — `idempotencyKey` is generated fresh **per card sent**, so the two actions on the *same* card share one key (a user re-clicking either button after a network hiccup is a safe retry), while a *newly re-sent* card (e.g. a follow-up reminder) gets a new key (that's a revision, not a retry).

**Inbound (card → server)** — `parseCardSubmission` is the exact inverse: it reconstructs `SubmissionInput` from the flat merged object, including deriving `status` (`draft`|`submitted`|`skipped`) from `intent` and `skipReason`, and collecting every `ticket_*` field whose value is `"true"` plus a normalized `additionalTicket` into `jiraIssueKeys`.

## Outbox event contracts (`notifications` module)

Every entry is an `outbox_events` row: `{ aggregateType, aggregateId, eventType, payload, dedupeKey }`. `eventType` is the dispatch key a handler map (`src/runtime-tick.ts`) is registered against.

| `eventType` | `aggregateType` | `payload` shape | Handler behavior |
|---|---|---|---|
| `send_reminder_card` | `reminder` | `{ organizationId, userId, card }` | `teamsAdapter.sendPersonalCard`; throws (→ retried) only on a *retryable* delivery outcome (throttled/transient); a non-retryable outcome (blocked/no conversation reference) is logged and treated as done |
| `publish_digest_channel_post` | `digest` | `{ organizationId, cycleId }` | Looks up the configured digest channel and the cycle's (already-computed, immutable) snapshot, renders the channel card, sends via `teamsAdapter.sendChannelCard`; same retryable/non-retryable split as above |

Future phases add `jira_action`/`git_action` aggregate types (e.g. `create_qa_ticket`, `post_review_comment`) through the same table and dispatcher — no new infrastructure needed, just new handler entries.

## Scheduler job contracts (`scheduler` module)

`notification_jobs.job_type`: `daily_reminder` (per-user, `subject_user_id` set) | `follow_up_reminder` (reserved for the optional single follow-up — not yet wired to a handler) | `digest_publish` (org-level, `subject_user_id` null). A job's `dedupe_key` is `dedupeKey(organizationId, jobType, [subjectUserId,] scheduledFor.toISOString())` — deterministic, so re-running "ensure today's jobs exist" every tick never double-schedules.

## Domain interfaces future integrations implement against

These are contracts, not HTTP endpoints — they're the seams a real adapter (or a future AI agent) is written against without touching any calling module:

- `TeamsClient` (`teams-adapter/domain.ts`) — `sendPersonalMessage`, `sendChannelMessage`.
- `JiraClient` (`jira-integration/domain.ts`) — see [03](./03-jira-authentication-plan.md).
- `GitProvider` (`git-integration/domain.ts`) — see [04](./04-git-provider-integration-plan.md).
- `PolicyEngine` (`review-workflow/domain.ts`) — `evaluateAutoApproval`, `produceReviewRecommendation`, `executeApproval` (see [ADR-6](./01-architecture-decision-record.md)).
