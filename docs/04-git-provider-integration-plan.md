# Git-Provider Integration Plan

**Status: implemented for GitHub** (`GitHubProvider`, `src/modules/git-integration/github-provider.ts`,
`GIT_PROVIDER_MODE=github`, auth via a personal access token in `GITHUB_TOKEN` — the
POC choice, matching Jira's service-account-token approach). GitLab/Bitbucket remain
unimplemented; the interface notes below still apply to whichever gets picked later.

**This adapter is the one piece of the three new integrations (Teams/Jira/GitHub)
that was actually validated live** — `getPullRequest`, `getPullRequestReviewState`,
`getChecks`, `getCommit`, and `listPullRequestsForIssue` were all exercised against a
real throwaway PR on `gauravsimnovus/taskmaster` while building it, confirming the
Jira-key extraction (branch name + title + body), review-state aggregation, and
checks mapping all work against real GitHub API responses. `listUserCommits`'s
search-index-backed lookup showed the one caveat worth knowing: GitHub's commit
search index has a lag of at least a couple of minutes on very recent commits — a
direct `getCommit` by SHA is instant, but `listUserCommits`/`listPullRequestsForIssue`
(both search-API-backed) can miss something pushed moments ago. Not a bug in this
adapter, just GitHub's own eventual consistency — don't be surprised by it in a demo.

## Interface (already defined, stable regardless of provider choice)

```ts
interface GitProvider {
  listUserCommits(externalAccountId: string, since: Date, until: Date): Promise<Commit[]>;
  getCommit(repositoryProviderId: string, sha: string): Promise<Commit | undefined>;
  getPullRequest(repositoryProviderId: string, providerPrId: string): Promise<PullRequest | undefined>;
  listPullRequestsForIssue(jiraIssueKey: string): Promise<PullRequest[]>;
  getPullRequestReviewState(repositoryProviderId: string, providerPrId: string): Promise<string>;
  requestReview(repositoryProviderId: string, providerPrId: string, reviewerExternalId: string): Promise<void>;
  approvePullRequest(repositoryProviderId: string, providerPrId: string): Promise<void>; // never called automatically in V1
  getChecks(repositoryProviderId: string, providerPrId: string): Promise<CheckStatus[]>;
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean;
  normalizeWebhookEvent(rawBody: unknown): NormalizedWebhookEvent[];
}
```

## Per-provider auth notes (for whichever gets chosen)

- **GitHub** (assumed default): a GitHub App (not a PAT) scoped to `contents:read`, `pull_requests:read` (+`write` only if `requestReview` posting is enabled), `checks:read`, `metadata:read`. Webhook signature verification via the App's shared secret (HMAC-SHA256 over the raw body).
- **GitLab**: a Project/Group Access Token or GitLab App, scoped to `read_repository`, `read_api` (+`api` only if posting review requests). Webhook verification via the `X-Gitlab-Token` shared-secret header.
- **Bitbucket**: an OAuth consumer or App Password scoped equivalently. Webhook verification via Bitbucket's HMAC signature header (Bitbucket Cloud) or IP-allowlisting (Server/Data Center).

Whichever is chosen, `git_connections.encrypted_credentials` stores the provider credential the same way `jira_connections` does — envelope-encrypted, never logged (see [08-threat-model.md](./08-threat-model.md)).

## Normalization and linking (provider-agnostic, already schema-backed)

- `normalizeWebhookEvent` turns a raw provider payload into `commits`/`pull_requests`/`pull_request_reviews` rows. `commits` has a `UNIQUE (repository_id, sha)` constraint — this is what makes commit ingestion idempotent regardless of whether the same commit surfaces via a push event and a PR-merge event.
- **Merge commits are not double-counted.** `commits.is_merge` is excluded from `metrics.countCommitsPushed`; the unique `(repository_id, sha)` constraint means even if both a push webhook and a PR-merge webhook report the same SHA, only one row (and one count) results. Verified in `test/integration/metrics.test.ts`.
- **Jira linkage priority**, applied when normalizing a commit or PR (`linked_jira_issue_keys: TEXT[]` columns on `commits`/`pull_requests`):
  1. Jira issue keys found in PR title/description/metadata.
  2. Jira issue keys found in the branch name.
  3. Jira issue keys found in commit messages.
  4. Explicit user association (e.g. the user tagged a ticket when requesting review — this is exactly what `review_requests.jira_issue_key` captures today, ahead of any Git integration existing).
  5. Manual association (an admin/lead corrects a mislinked or unlinked item) — not yet exposed as a UI action in V1; the `review_requests` and future PR-linking tables have room for it (a nullable override column) when built.
- A commit or PR with **multiple** Jira keys is stored as an array (`linked_jira_issue_keys TEXT[]`), not forced into a single key — metrics that roll up "tickets touched by this PR" should unnest that array rather than assuming one key per item.

## What a real adapter needs to prove before it's trusted

1. `verifyWebhook` rejects a payload with a missing/incorrect signature — this is a security-critical unit/contract test, not just a happy-path one.
2. `normalizeWebhookEvent` is idempotent: replaying the same webhook payload twice must not create a second `commits`/`pull_requests` row (same pattern already proven for Jira/notification events in `test/integration/notifications-outbox.test.ts`).
3. `getPullRequestReviewState` and `getChecks` are read-only and safe to poll on a schedule for the "stale review requests" / "failed CI checks" digest sections — these are reconciliation-style calls, not the primary event path.
4. `approvePullRequest` is wired into `review-workflow` only behind an explicit, human-triggered, authorized action — and only once this specific provider's approval API has been confirmed safe to call server-side (some provider configurations don't allow a bot identity to approve its own team's PRs, which needs to be checked before this is ever exposed as a button).

## Sequencing

Same shape as the Jira plan: confirm provider → auth flow proof-of-concept → webhook ingestion (`normalizeWebhookEvent`/`verifyWebhook`, since this feeds `commits`/`pull_requests` which review-workflow and metrics both depend on) → read APIs (`getPullRequest`, `getChecks`) → write APIs (`requestReview`, and only much later, if ever, `approvePullRequest`). This is a later development phase — see [09-development-phases.md](./09-development-phases.md).
