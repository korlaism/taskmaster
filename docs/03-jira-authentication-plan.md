# Jira Authentication Plan

**Status: blocked on one organizational decision — Jira Cloud vs Jira Data Center.** Everything below is written so the answer only changes which adapter file gets written; `JiraClient` (the interface `daily-updates`, `qa-ticket-workflow`, and `metrics` code against) does not change either way.

## Step 0 — confirm deployment target

Before writing a real adapter: ask the Jira admin whether the instance is **Jira Cloud** (`*.atlassian.net`) or **Jira Data Center** (self-hosted). This determines everything below and cannot be inferred from the product spec alone.

## If Jira Cloud

- **Auth**: OAuth 2.0 (3LO) app via the Atlassian Developer Console. Scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`, `offline_access` (for refresh tokens). Store `jira_connections.encrypted_credentials` as an envelope-encrypted refresh token; access tokens are minted per-request and never persisted.
- **Alternative**: an org-approved scoped service account (API token) restricted to the admin-configured `jira_projects` list, if the organization prefers a single service identity over per-user OAuth. This is the "or an approved organization service account" option the spec allows — the decision belongs to the org's Jira admin, not this codebase.
- **Webhooks**: register `issue_created` and `issue_updated` webhooks pointing at this app's webhook receiver. Validate authenticity via Atlassian's documented webhook signing/JWT mechanism (Cloud webhooks include a verifiable identity) — never trust an unverified payload.
- **Reconciliation**: webhooks can be missed during app downtime. A periodic reconciliation job re-queries JQL for issues updated since the last successfully-processed event timestamp and replays any missed transitions into `jira_issue_events`, using the same normalization path as live webhooks so there's only one code path to test.
- **Search**: JQL-based search (`GET /rest/api/3/search`) for the "prepopulate suggested tickets" feature — bounded by project + user + time window, never an unscoped org-wide query.
- **Rate limits**: respect `Retry-After` on 429s; the outbox dispatcher's existing backoff mechanism is the natural place to route Jira write-retries through (aggregate_type `'jira_action'` in `outbox_events`).
- **Identity**: store Jira's `accountId` (opaque, stable) in `external_identities.external_account_id`, never display name or email — Atlassian's own GDPR changes made email/display-name an unreliable, non-stable identifier.

## If Jira Data Center

- **Auth**: no OAuth 3LO equivalent in the same form. Options are a Personal Access Token (PAT) scoped to a dedicated service account, or Jira's Application Links (OAuth 1.0a) if the organization already has that configured for other tools. A PAT tied to a purpose-built service account (not a real person's account) is the simpler, more auditable default.
- **Webhooks**: Data Center webhooks lack Cloud's signed-JWT verification; validate authenticity via a shared-secret header (a custom webhook filter/plugin may be required) or fall back to IP-allowlisting the Jira server plus a shared secret in the payload.
- **Reconciliation**: same idea as Cloud — periodic JQL polling as the safety net for missed webhooks — but Data Center JQL search syntax/endpoint versioning should be re-verified against the specific instance's version.
- **Rate limits**: Data Center doesn't have Cloud's platform-wide rate limiting, but the target instance's own capacity still applies — treat it the same way defensively (backoff on 5xx/timeout).

## What doesn't change either way

- `JiraClient` interface (`src/modules/jira-integration/domain.ts`): `suggestIssuesForReportingWindow`, `searchIssuesByJql`, `getCreateMeta`, `createIssue`, `addComment`, `transitionIssue`, `verifyWebhookSignature`, `normalizeWebhookEvent`.
- Normalization target: every webhook or reconciliation-discovered change becomes one or more `jira_issue_events` rows (`created` | `assigned` | `status_changed` | `updated`), never a direct overwrite of `jira_issues.current_status` alone — metrics are computed from the event history, not current state, so historical digests stay correct even after tickets move again.
- Status-bucket mapping (`jira_status_mappings`: `not_started` | `active` | `qa` | `approval` | `done`) is per-project, configured by an administrator — the metrics SQL in `src/modules/metrics/repository.ts` already joins against this table rather than hardcoding status strings, specifically so two projects with different workflows (e.g. "Done" vs "Closed") both roll up correctly. Verified in `test/integration/metrics.test.ts`.
- `FakeJiraAdapter` (`src/modules/jira-integration/fake-adapter.ts`) implements the same interface with seeded fixture data, so replacing it is a one-file change in `src/composition.ts` — no other module changes.

## Sequencing

1. Confirm Cloud vs Data Center (blocking).
2. Stand up the auth flow in a throwaway script against a real (sandbox) Jira instance; confirm token storage/refresh works before wiring it into the app.
3. Implement `normalizeWebhookEvent`/`verifyWebhookSignature` first (this is what populates `jira_issue_events`, which everything else — suggestions, metrics, digest — depends on).
4. Implement `suggestIssuesForReportingWindow` (JQL-based) next — this is what the daily-update card needs.
5. Implement `createIssue`/`getCreateMeta` last — needed only for the QA ticket workflow, which is a later phase (see [09-development-phases.md](./09-development-phases.md)).
