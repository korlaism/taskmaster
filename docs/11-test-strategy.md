# Test Strategy

## Layers

- **Unit tests** (`test/unit/`) — pure functions with no I/O: timezone/DST arithmetic (`timezone.test.ts`), Adaptive Card submission parsing (`card.test.ts`). Fast, no database.
- **Integration tests** (`test/integration/`) — real Postgres (via PGlite + a real wire-protocol socket, see [10-local-development.md](./10-local-development.md)), real SQL, real transactions. This is where idempotency, concurrency, and metric-definition correctness are actually proven, not just asserted.
- **Contract tests** (planned, `test/contract/` scaffolded but empty until Phase 1/2 adapters exist) — for `JiraClient`/`GitProvider`/`TeamsClient` implementations: the same test suite runs against `FakeJiraAdapter` and, once built, the real adapter, asserting both satisfy the same interface behavior (e.g. "a duplicate webhook is a no-op," "an invalid signature is rejected"). Writing the fake adapter and the real adapter against one shared contract test suite is what keeps them from silently diverging.
- **End-to-end** — the manual curl walkthrough in [10-local-development.md](./10-local-development.md) exercises the full install → reminder → submit → digest → channel-post loop against the real HTTP surface; a scripted version of that walkthrough (rather than manual curl) is the natural next step once Microsoft's Teams local test tooling is in the loop (Phase 1).

## What's covered today (38 automated tests, all passing against real Postgres)

| Requirement | Test |
|---|---|
| Save Draft then Submit both apply (regression: a shared idempotency key across both card buttons made Submit look like a retry of Draft and silently drop it) | `daily-updates.test.ts` — builds a real card via `buildDailyUpdateCard`, submits both actions' `data` in sequence, asserts the final state reflects Submit |
| Requesting review enqueues exactly one notification, even retried | `review-and-qa-workflow.test.ts` — same idempotency key twice → one `send_review_request_card` outbox row |
| A stale (unanswered) review request surfaces in the digest | `review-and-qa-workflow.test.ts` — a backdated `review_requests` row appears in `attentionRequired.staleReviewRequests` |
| QA ticket creation is idempotent and role-gated | `review-and-qa-workflow.test.ts` — retried submission doesn't create a second ticket; a non-QA user is rejected |
| Metric definitions are deterministic and status-mapping-driven | `metrics.test.ts` — two projects with different workflow status names ("Done" vs "Closed") both roll up correctly |
| A ticket status change around the cutoff boundary | `metrics.test.ts` — an event exactly at `window_end` is excluded (next cycle), one 1ms before is included |
| A developer works in two Jira projects with different workflows | `metrics.test.ts` (same test as above — two `jira_projects` with independent `jira_status_mappings`) |
| A commit has multiple Jira keys / merge commits aren't double-counted | `metrics.test.ts` — merge-commit dedup via the `(repository_id, sha)` unique constraint |
| Timezone boundaries, including DST | `timezone.test.ts` — spring-forward and fall-back instants in `America/New_York`, plus a half-hour-offset zone |
| Idempotent card submissions | `daily-updates.test.ts` — same idempotency key twice → one row, no error; a new key → revision of the same row |
| A user submits twice | `daily-updates.test.ts` (same test) |
| A ticket changes status around the cutoff | `metrics.test.ts` (see above) |
| Duplicate webhook / outbox events | `notifications-outbox.test.ts` — same dedupe key enqueued twice → one row; a duplicated "webhook" delivery → handler runs once |
| Retry and dead-letter | `notifications-outbox.test.ts` — a handler that always fails is retried up to the max-attempts limit, then dead-lettered; a replayed dead-letter can succeed |
| Scheduler concurrency (two workers, same job) | `scheduler-concurrency.test.ts` — two concurrent `claimDueJobs` calls never claim the same row twice, proven against real `FOR UPDATE SKIP LOCKED` semantics |
| The service restarts during job processing | `scheduler-concurrency.test.ts` — a job stuck in `claimed` past its lease window is reclaimed and completed by a later tick |
| The service restarts during digest publication | `digest.test.ts` — a second `getOrPublishSnapshot` call for the same cycle (simulating a resumed process) returns the identical, already-published content and creates no second snapshot row |
| Digest snapshot immutability | `digest.test.ts` — a submission added after publication doesn't change the already-published snapshot's numbers |
| A lead requests changes after the digest was already published | Covered at the data-model level (`review_requests.state` transitions independently of `digest_snapshots`, which never re-renders) — dedicated test not yet written, flagged below |
| Authorization is server-side, not UI-trust | `authorization.test.ts` — a review request to a non-lead reviewer is rejected; a disabled user's action is rejected; `evaluateAutoApproval` always returns `false` |
| Auditability | `authorization.test.ts` — a review request creation produces a matching `audit_events` row |

## Explicitly not yet covered (tracked, not silently skipped)

- **Teams delivery returns 403 / Jira returns 429** — `LocalSimTeamsClient.forceNextFailure` exists specifically to enable this test (force a `blocked` or `throttled` outcome and assert the graceful-failure/retry split described in [02-teams-permissions-and-installation.md](./02-teams-permissions-and-installation.md)); a dedicated test using it hasn't been written yet.
- **A PR has multiple authors or reviewers** — `GitHubProvider` now exists and was manually verified live against a real single-author, single-reviewer PR (`docs/04`); a multi-reviewer scenario (`getPullRequestReviewState`'s "latest review per reviewer" aggregation) hasn't been exercised against real data, only reasoned through in the implementation.
- **Contract tests for Jira/Git/Teams adapters** — `JiraCloudAdapter`, `GitHubProvider`, and `TeamsAppClient` now exist alongside their fake/local-sim counterparts, but there's no shared contract-test suite running the same assertions against both yet (`test/contract/` is still empty) — the real adapters were validated ad hoc (GitHub live against a throwaway PR; Jira and Teams by careful reading of current API docs, no live credentials available). Writing that shared suite is the natural next step before trusting these adapters further.
- **A lead requests changes after the digest was already published** — the data model supports this cleanly (independent tables), but no test asserts the digest's per-person "review state" field stays stale by design until the next cycle's snapshot. Worth adding once the review-workflow Teams surface (Phase 3) makes this a real user-facing flow rather than a service-layer-only capability.
- **Microsoft Teams local test tooling (E2E)** — not available in this environment (see [10](./10-local-development.md)); revisit in Phase 1 once a real Teams SDK client and dev tenant are in the loop.

## Principles this suite follows

- **No metric test asserts against a mock's "invented" numbers.** Every metrics test seeds real rows (`jira_issues`, `jira_issue_events`, `commits`) and asserts against the same SQL the production code runs — a wrong status-mapping join would fail the test, not just look plausible.
- **Concurrency claims are proven, not assumed.** `Promise.all([claimA, claimB])` against a real Postgres instance is what actually exercises `SKIP LOCKED`, rather than trusting that the SQL is correct by inspection.
- **Idempotency is proven at the boundary that matters.** Tests call the same service method twice with the same key, the same way a retried Teams card submission or a replayed webhook would — not just unit-testing the SQL string in isolation.
