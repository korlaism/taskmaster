# Adaptive Card Wireframes

Two of these are implemented and exercised by the vertical slice (`daily-updates/card.ts`, `digest/card.ts`); the review-request and QA-ticket cards describe the intended design for the corresponding (already-implemented-at-the-service-layer) workflows, whose Teams card is a later phase — see [09](./09-development-phases.md).

## 1. Daily update card (implemented) — personal scope

```
┌─────────────────────────────────────────────┐
│ Daily update — 2026-07-28                    │
│ Suggested Jira tickets for this window:      │
│  [x] SIM40-101 — Fix auth timeout (In Prog.) │
│  [ ] SIM40-98  — Flaky test cleanup (Done)   │
│  [x] SIM40-112 — New assignment (To Do)      │
│                                               │
│ Add another Jira ticket by key: [___________]│
│                                               │
│ Completed today                              │
│ [_____________________________________]      │
│ In progress                                   │
│ [_____________________________________]      │
│ Blockers                                      │
│ [_____________________________________]      │
│ Next planned work                             │
│ [_____________________________________]      │
│ Review required?      ( ) Yes  (•) No         │
│ Reviewer or lead        [___________]         │
│ Additional notes       [___________]          │
│ No update needed — reason (leave blank        │
│ otherwise)              [___________]         │
│                                               │
│        [ Save draft ]   [ Submit update ]     │
└─────────────────────────────────────────────┘
```

Notes: toggles are prepopulated from `JiraClient.suggestIssuesForReportingWindow` (assigned during window, status-changed during window, created by user, currently assigned + active — see [00](./00-assumptions-and-risks.md) for the fake-adapter caveat in V1). Both buttons carry the same per-send `idempotencyKey`; re-sending a *new* reminder (a revision opportunity before cutoff) gets a new key. If the suggestion list would exceed Teams' practical card-action limits, this needs a "show top N, `+K more — search in app`" treatment — not yet built, flagged in [00](./00-assumptions-and-risks.md).

## 2. Review request card (service implemented; card not yet wired) — personal scope, sent to the reviewer

```
┌─────────────────────────────────────────────┐
│ Review requested — SIM40-1234                │
│ "Fix auth timeout on retry"           [Jira ↗]│
│                                               │
│ PR #482: auth-service                 [PR ↗] │
│ Branch: fix/auth-timeout                     │
│ CI: ✓ build   ✓ tests   ⧗ lint (pending)     │
│                                               │
│ From: Priya Sharma                            │
│ "Mind double-checking the retry backoff       │
│  math? Edge case around the 3rd attempt."     │
│                                               │
│  [Acknowledge] [Approve] [Needs changes]      │
│                          [ Open PR ]          │
└─────────────────────────────────────────────┘
```

Notes: maps directly to `review_requests` columns (`jira_issue_key`, `pull_request_id`, `branch_name`, `requester_note`, `state`). "Approve" here **records a decision in this application only** — it never calls a Git provider's approval API automatically (see [ADR-6](./01-architecture-decision-record.md)); "Open PR" is a deep link, not an action. CI status comes from `GitProvider.getChecks` once a real Git adapter exists.

## 3. QA ticket creation card (service implemented; card not yet wired) — personal scope, QA role only

```
┌─────────────────────────────────────────────┐
│ Create Jira ticket (QA)                      │
│ Project        [ SIM40            ▾]         │
│ Issue type     [ Bug               ▾]         │
│ Summary        [_____________________]       │
│ Description    [_____________________]       │
│ Severity       [ High              ▾]         │
│ Component      [ auth-service      ▾]         │
│ Environment    [ staging           ▾]         │
│ Steps to reproduce                            │
│ [_____________________________________]      │
│ Expected result [_____________________]       │
│ Actual result   [_____________________]       │
│ Evidence / log links [__________________]    │
│ Related issue (epic/story)   [SIM40-100  ]    │
│ Suggested assignee            [__________]    │
│                                               │
│               [ Create ticket ]               │
└─────────────────────────────────────────────┘
```

Notes: the project/issue-type/severity/component dropdowns are populated dynamically from `JiraClient.getCreateMeta(projectKey, issueType)` — required-field validation happens server-side against live `createmeta`, not a hardcoded field list, because Jira projects can use different screens (see `qa-ticket-workflow/service.ts`). Submission is idempotent on `qa_ticket_requests.idempotency_key`; a retried "Create ticket" click does not create a second Jira issue.

## 4. Digest channel post (implemented) — team scope, standard channel

```
┌─────────────────────────────────────────────┐
│ Daily engineering digest — 2026-07-28        │
│ ───────────────────────────────────────────  │
│ Submitted: 8/10      Missing: 2               │
│ Tickets picked: 5    Tickets closed: 3        │
│ Tickets created: 2   QA tickets created: 1    │
│ In QA: 4             Pending approval: 2       │
│ Commits pushed: 22   PRs opened: 4  merged: 3  │
│ Active blockers: 1                            │
│ ───────────────────────────────────────────  │
│ Per-person updates                            │
│  Ada Admin — submitted                        │
│    "Wired up the vertical slice"              │
│  Priya Sharma — submitted                     │
│    "Fixed the auth timeout retry bug"         │
│  ... (+5 more — see full report in app)       │
│ ───────────────────────────────────────────  │
│ Attention required                            │
│  Missing updates: Sam Lee, Jordan Kim         │
│  Unmapped identities: Sam Lee                 │
│  Stale review requests: None                  │
│  Failed CI checks: None                       │
└─────────────────────────────────────────────┘
```

Notes: truncates to the top 15 per-person rows with a "+K more — see full report in app" line rather than exceeding Teams' message size limits (`MAX_PER_PERSON_ROWS` in `digest/card.ts`). Every number here comes from `MetricsService`/`digest/repository.ts`'s immutable snapshot — never recomputed or re-rendered differently after publication.
