# Development Phases

## Phase 0 — Vertical slice (this repository, done)

Personal-scope install capture → scheduled reminder → Adaptive Card → idempotent submission → deterministic (if data-thin) metrics → immutable digest snapshot → channel post, all retry-safe. Fake Jira adapter, local-sim Teams client, no Git integration. See [10-local-development.md](./10-local-development.md) for how to run it and `test/` for the automated proof of the idempotency/concurrency/DST properties.

## Phase 1 — Real Teams integration

- Confirm and pin the actual Teams SDK package (see [00](./00-assumptions-and-risks.md), [ADR-5](./01-architecture-decision-record.md)).
- Replace `LocalSimTeamsClient` with a real `TeamsClient` implementation behind the same interface.
- Wire the real activity handler: personal/team install events → `captureConversationReference`; `Action.Submit` invokes → `daily-updates.submitFromCard`.
- Exit criteria: a real Teams tenant receives the reminder card and a real submission persists, with the existing idempotency/cutoff tests passing unchanged against the real client.

## Phase 2 — Real Jira integration

- Confirm Cloud vs Data Center ([03](./03-jira-authentication-plan.md)).
- Implement webhook ingestion + reconciliation first (populates `jira_issue_events`, which metrics and suggestions both depend on).
- Implement `suggestIssuesForReportingWindow` (JQL) next — replaces `FakeJiraAdapter`'s seeded fixtures in the reminder card.
- Exit criteria: `test/integration/metrics.test.ts`'s status-mapping logic now runs against real ingested events instead of directly-inserted fixture rows; a real digest shows non-zero Jira-derived numbers.

## Phase 3 — Review workflow Teams surface

- `ReviewWorkflowService` already exists (request, decision recording, audit, `NoopPolicyEngine`). This phase wires the Teams command/card: "Request review for X from Y" and the reviewer's Acknowledge/Approve/Needs-changes card ([wireframe #2](./07-adaptive-card-wireframes.md)).
- Add "stale review requests" to the digest's Attention Required section (currently always empty — the data model supports it, the query doesn't exist yet).
- Exit criteria: a lead receives and responds to a review request through Teams; the decision appears in `audit_events` and the next digest.

## Phase 4 — QA ticket workflow Teams surface

- `QaTicketWorkflowService` already exists (dynamic `createmeta` validation, idempotent creation, audit). This phase wires the Teams card ([wireframe #3](./07-adaptive-card-wireframes.md)) and a `/create-ticket`-style command.
- Exit criteria: a QA user creates a real Jira issue through Teams; it appears in the next digest's "QA tickets created" count.

## Phase 5 — Real Git integration

- Confirm provider ([04](./04-git-provider-integration-plan.md)).
- Implement webhook ingestion first (populates `commits`/`pull_requests`), then read APIs (`getPullRequest`, `getChecks`) for the digest's "failed CI checks" section, then `requestReview` if the org wants Git-side review requests mirrored.
- `approvePullRequest` is implemented last, if ever, and only wired to a UI action after an explicit organizational decision that it's safe for this specific provider config (see [ADR-6](./01-architecture-decision-record.md), [08-threat-model.md](./08-threat-model.md)).
- Exit criteria: commits/PRs attributed to users via the Jira-key-linking priority order ([04](./04-git-provider-integration-plan.md)); digest's PR/commit metrics reflect real activity.

## Phase 6 — AI summarization / PR-review agent (explicitly deferred, seams already exist)

- The outbox pattern (`aggregate_type: 'jira_action' | 'git_action'`) and the `PolicyEngine` interface are the two seams this phase plugs into.
- Any AI-generated text (e.g. a suggested digest summary sentence) must be clearly labeled as generated and must never replace a metric — metrics stay computed from Jira/Git/submission data per the product's non-negotiable requirement.
- `produceReviewRecommendation` gets a real implementation here; `evaluateAutoApproval` may get a real (non-`false`) implementation only after the organization explicitly opts into it, and even then `executeApproval` should require a human-in-the-loop confirmation step, not silent execution.

## Phase 7 — Multi-tenant / scale hardening (only if needed)

- Row-level security or an application-layer tenant guard (flagged as the biggest gap in [08-threat-model.md](./08-threat-model.md)).
- Reminder-send jitter to avoid synchronized Teams throttling at scale.
- Splitting a module into its own service, if a specific module's load genuinely outgrows the modular monolith — the module boundaries were kept strict from Phase 0 specifically to make this possible without a rewrite.
