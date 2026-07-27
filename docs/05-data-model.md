# Data Model

Full DDL: [`db/migrations/0001_init.sql`](../db/migrations/0001_init.sql). This document explains *why* each table looks the way it does; treat the migration file as the authoritative schema.

Every tenant-owned table carries `organization_id`. Idempotency is enforced with unique constraints wherever the product spec calls for it, not application-level check-then-insert.

## Tenancy, identity, roles

- **organizations** — one row per org (V1: exactly one). Holds `timezone`, `default_reminder_time`, `update_cutoff_time`, `digest_publish_time`, `weekends_disabled`. Bootstrapped from `.env` on every startup (`bootstrapOrganizationFromEnv`) so a fresh deployment needs no manual DB edits.
- **users** — `entra_object_id` is the identity anchor (`UNIQUE (organization_id, entra_object_id)`); `enabled` gates all scheduling and authorization.
- **roles** / **user_roles** — a small static lookup table (`developer` | `lead` | `qa` | `administrator`) plus the join table. Roles are additive.
- **user_preferences** — one row per user; `reminder_time_override`/`timezone_override` are `NULL`-means-inherit-org-default (precedence resolved once, in `UserPreferencesService.getEffective`, so nothing else re-implements the fallback rule).
- **external_identities** — `UNIQUE (provider, external_account_id)` links a user to a Jira `accountId` or Git provider user id — deliberately not email/display name (see [03](./03-jira-authentication-plan.md)).

## Teams installation / proactive messaging

- **teams_installations** — records scope (`personal`/`team`) and, for team scope, which `channel_id` is the configured digest target.
- **conversation_references** — `UNIQUE (organization_id, subject_type, subject_id)`; the only source of truth for "can we proactively message this user/channel." `is_valid` flips to false on a detected block/uninstall rather than deleting the row, so admins retain visibility into who's disconnected.

## Jira integration

- **jira_connections** — one row per Jira instance connection; `encrypted_credentials` is envelope-encrypted, never logged.
- **jira_projects** / **jira_status_mappings** — per-project raw-status → bucket (`not_started`|`active`|`qa`|`approval`|`done`) mapping. This is what lets two projects with different workflow status names (e.g. "Done" vs "Closed") both roll up into the same metric correctly.
- **jira_issues** — current-state snapshot, keyed by Jira's stable `jira_issue_id` (not the renameable `issue_key`).
- **jira_issue_events** — append-only history (`created`|`assigned`|`status_changed`|`updated`) with `UNIQUE (jira_issue_id, event_type, occurred_at, from_value, to_value)`. **This is the deliberate design choice that makes metrics deterministic and historically stable**: metrics never compute "tickets picked/closed" from `jira_issues.current_status` alone, only from this event history within a bounded window — so a ticket that later moves to another status doesn't retroactively change last week's digest.

## Git integration

- **git_connections** / **repositories** — connection + repo registry.
- **commits** — `UNIQUE (repository_id, sha)` is the dedup mechanism described in [04](./04-git-provider-integration-plan.md); `is_merge` lets metrics exclude merge commits from the push count.
- **pull_requests** / **pull_request_reviews** — PR state and review history, keyed by `provider_pr_id`.

## Daily updates

- **update_cycles** — one row per `(organization_id, cycle_date)`; carries the *computed* `window_start`/`window_end`/`cutoff_at`/`digest_publish_at` instants (already resolved from org timezone + config, so nothing downstream re-does timezone math).
- **update_submissions** — `UNIQUE (cycle_id, user_id)` **and** `UNIQUE (idempotency_key)`. The `ON CONFLICT (cycle_id, user_id) DO UPDATE ... WHERE idempotency_key IS DISTINCT FROM EXCLUDED.idempotency_key` clause (see `src/modules/daily-updates/repository.ts`) is what makes "submit twice with the same key" a no-op and "submit again with a new key" a revision — both are database-constraint-backed, not app-level race-prone logic.
- **update_submission_items** — the selected/added Jira tickets for a submission.

## Review workflow

- **review_requests** — `idempotency_key UNIQUE` so a retried "Request review" action doesn't create a duplicate request. Carries `state` (`requested`|`acknowledged`|`approved`|`changes_requested`), never a boolean — the full lifecycle is a first-class column so "a lead requests changes after the digest was already published" is just a normal state transition after the fact.

## QA ticket workflow

- **qa_ticket_requests** — `idempotency_key UNIQUE`; `issue_key` stays `NULL` until Jira creation actually succeeds (`status`: `pending`|`created`|`failed`), so a retried card submission during a slow/failed Jira call doesn't create two tickets.

## Scheduling, outbox, notifications

- **notification_jobs** — `dedupe_key UNIQUE` (derived from org+job type+subject+scheduled instant) is what makes "generate today's jobs" idempotent across ticks and workers. Claimed via `FOR UPDATE SKIP LOCKED`; a stale `claimed` row past a lease window is reclaimed to `pending` (crash recovery).
- **outbox_events** — `dedupe_key UNIQUE`; `aggregate_id` is `TEXT` (not `UUID`) because aggregate identifiers are heterogeneous across event types (a user id, a cycle id, a Jira issue key). Same claim/retry/dead-letter/replay shape as `notification_jobs`, but for *delivery* rather than *scheduling*.

## Digest, audit, integration health

- **digest_snapshots** — `UNIQUE (cycle_id)`. `content_json` is written once and never updated — this is the literal mechanism behind "store every published digest as an immutable snapshot so historical reports don't change when Jira tickets later move to another status."
- **audit_events** — append-only by convention (no application code issues `UPDATE`/`DELETE` against it); `target_id` is `TEXT` for the same heterogeneity reason as `outbox_events.aggregate_id`.
- **integration_failures** — surfaced via `administration.listIntegrationFailures` for the "integration health and failed jobs" admin view.
