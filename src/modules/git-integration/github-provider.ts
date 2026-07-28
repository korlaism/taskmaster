import crypto from "node:crypto";
import { childLogger } from "../../shared/logger.js";
import type { CheckStatus, Commit, GitProvider, NormalizedWebhookEvent, PullRequest } from "./domain.js";
import { extractJiraKeys } from "./jira-key-extraction.js";

const log = childLogger({ module: "git-integration" });

export interface GitHubConfig {
  token: string;
  /** Repos this org has configured for tracking, as "owner/repo" — scopes
   * listUserCommits' search so it doesn't pull commits from unrelated repos the
   * token happens to have access to. */
  repos: string[];
  webhookSecret?: string;
}

function checkConclusionToState(conclusion: string | null, status: string): CheckStatus["state"] {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled") return "failure";
  return "pending";
}

/**
 * Real GitHub adapter (REST API v3, api.github.com) authenticated via a personal
 * access token from GITHUB_TOKEN — the POC auth choice, matching the Jira service-
 * account-token approach (docs/04-git-provider-integration-plan.md). A GitHub App
 * is the natural upgrade path once this moves past POC.
 */
export class GitHubProvider implements GitProvider {
  constructor(private readonly config: GitHubConfig) {}

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });

    if ((res.status === 429 || res.status === 403) && res.headers.get("retry-after") && attempt < 3) {
      const retryAfterSeconds = Number(res.headers.get("retry-after"));
      log.warn({ path, attempt, retryAfterSeconds }, "GitHub rate-limited; backing off");
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      return this.request<T>(path, init, attempt + 1);
    }

    if (res.status === 404) return undefined as T;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub request failed: ${init.method ?? "GET"} ${path} -> ${res.status} ${body.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  async listUserCommits(externalAccountId: string, since: Date, until: Date): Promise<Commit[]> {
    if (this.config.repos.length === 0) return [];
    const repoQualifiers = this.config.repos.map((r) => `repo:${r}`).join(" ");
    const q = `author:${externalAccountId} author-date:${since.toISOString()}..${until.toISOString()} ${repoQualifiers}`;
    const data = await this.request<{
      items: Array<{
        sha: string;
        commit: { author: { date: string }; message: string };
        parents: unknown[];
      }>;
    }>(`/search/commits?q=${encodeURIComponent(q)}&per_page=100`);

    return (data?.items ?? []).map((item) => ({
      sha: item.sha,
      authorExternalId: externalAccountId,
      authoredAt: new Date(item.commit.author.date),
      isMerge: item.parents.length > 1,
      linkedJiraIssueKeys: extractJiraKeys(item.commit.message),
    }));
  }

  async getCommit(repositoryProviderId: string, sha: string): Promise<Commit | undefined> {
    const data = await this.request<{
      sha: string;
      commit: { author: { date: string }; message: string };
      author: { login: string } | null;
      parents: unknown[];
    }>(`/repos/${repositoryProviderId}/commits/${sha}`);
    if (!data) return undefined;
    return {
      sha: data.sha,
      authorExternalId: data.author?.login ?? null,
      authoredAt: new Date(data.commit.author.date),
      isMerge: data.parents.length > 1,
      linkedJiraIssueKeys: extractJiraKeys(data.commit.message),
    };
  }

  async getPullRequest(repositoryProviderId: string, providerPrId: string): Promise<PullRequest | undefined> {
    const pr = await this.request<{
      number: number;
      title: string;
      body: string | null;
      user: { login: string } | null;
      head: { ref: string };
      state: "open" | "closed";
      merged_at: string | null;
      created_at: string;
      html_url: string;
    }>(`/repos/${repositoryProviderId}/pulls/${providerPrId}`);
    if (!pr) return undefined;

    return {
      providerPrId: String(pr.number),
      title: pr.title,
      authorExternalId: pr.user?.login ?? null,
      branchName: pr.head.ref,
      // Priority order (docs/04): PR metadata (title+body), then branch name, then
      // commit messages (handled separately via getCommit/listUserCommits) — all
      // three land in the same array column, so order here only affects nothing
      // functionally, just documents precedence for a future "pick one primary" need.
      linkedJiraIssueKeys: extractJiraKeys(pr.title, pr.body, pr.head.ref),
      state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
      openedAt: new Date(pr.created_at),
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      url: pr.html_url,
    };
  }

  /**
   * GitHub's search API indexes PR title/body text but not branch names, so this
   * covers priority levels 1 and 3 (PR metadata) but not level 2 (branch name) from
   * the linking priority order — a documented POC gap (docs/04) rather than a full
   * repo scan of every open PR's branch name, which doesn't scale as a search primitive.
   */
  async listPullRequestsForIssue(jiraIssueKey: string): Promise<PullRequest[]> {
    if (this.config.repos.length === 0) return [];
    const repoQualifiers = this.config.repos.map((r) => `repo:${r}`).join(" ");
    const q = `${jiraIssueKey} in:title,body type:pr ${repoQualifiers}`;
    const data = await this.request<{ items: Array<{ number: number; repository_url: string }> }>(
      `/search/issues?q=${encodeURIComponent(q)}&per_page=50`
    );
    const results: PullRequest[] = [];
    for (const item of data?.items ?? []) {
      const repoFullName = item.repository_url.replace("https://api.github.com/repos/", "");
      const pr = await this.getPullRequest(repoFullName, String(item.number));
      if (pr) results.push(pr);
    }
    return results;
  }

  async getPullRequestReviewState(repositoryProviderId: string, providerPrId: string): Promise<string> {
    const reviews = await this.request<Array<{ user: { login: string }; state: string; submitted_at: string }>>(
      `/repos/${repositoryProviderId}/pulls/${providerPrId}/reviews`
    );
    if (!reviews || reviews.length === 0) return "pending";

    // Only the latest review per reviewer counts — an earlier "changes requested"
    // that the same reviewer later approved shouldn't still count against the PR.
    const latestPerReviewer = new Map<string, { state: string; submittedAt: string }>();
    for (const r of reviews) {
      const existing = latestPerReviewer.get(r.user.login);
      if (!existing || r.submitted_at > existing.submittedAt) {
        latestPerReviewer.set(r.user.login, { state: r.state, submittedAt: r.submitted_at });
      }
    }
    const states = [...latestPerReviewer.values()].map((v) => v.state);
    if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
    if (states.includes("APPROVED")) return "approved";
    return "pending";
  }

  async requestReview(repositoryProviderId: string, providerPrId: string, reviewerExternalId: string): Promise<void> {
    await this.request(`/repos/${repositoryProviderId}/pulls/${providerPrId}/requested_reviewers`, {
      method: "POST",
      body: JSON.stringify({ reviewers: [reviewerExternalId] }),
    });
  }

  /**
   * V1 product requirement: never called automatically anywhere in this codebase.
   * Implemented only because the GitProvider interface requires it — wiring this to
   * an actual button is an explicit future decision (docs/08-threat-model.md), not
   * something this method being present implies is already safe to expose.
   */
  async approvePullRequest(repositoryProviderId: string, providerPrId: string): Promise<void> {
    await this.request(`/repos/${repositoryProviderId}/pulls/${providerPrId}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "APPROVE" }),
    });
  }

  async getChecks(repositoryProviderId: string, providerPrId: string): Promise<CheckStatus[]> {
    const pr = await this.request<{ head: { sha: string } }>(`/repos/${repositoryProviderId}/pulls/${providerPrId}`);
    if (!pr) return [];
    const data = await this.request<{
      check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }>;
    }>(`/repos/${repositoryProviderId}/commits/${pr.head.sha}/check-runs`);
    return (data?.check_runs ?? []).map((run) => ({
      name: run.name,
      state: checkConclusionToState(run.conclusion, run.status),
      url: run.html_url,
    }));
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!this.config.webhookSecret) {
      log.warn("no GitHub webhook secret configured; rejecting all webhook deliveries");
      return false;
    }
    if (!signatureHeader?.startsWith("sha256=")) return false;
    const expected =
      "sha256=" + crypto.createHmac("sha256", this.config.webhookSecret).update(rawBody, "utf8").digest("hex");
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signatureHeader);
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  }

  normalizeWebhookEvent(rawBody: unknown, eventTypeHeader?: string): NormalizedWebhookEvent[] {
    const payload = rawBody as Record<string, unknown>;
    const eventType = eventTypeHeader ?? this.inferEventType(payload);
    const repo = payload.repository as { full_name?: string } | undefined;
    if (!eventType || !repo?.full_name) return [];

    const typeMap: Record<string, NormalizedWebhookEvent["type"] | undefined> = {
      push: "push",
      pull_request: "pull_request",
      pull_request_review: "pull_request_review",
      check_run: "check_run",
    };
    const type = typeMap[eventType];
    if (!type) return [];

    return [{ type, repositoryProviderId: repo.full_name, payload }];
  }

  private inferEventType(payload: Record<string, unknown>): string | undefined {
    if (Array.isArray(payload.commits) && "ref" in payload) return "push";
    if (payload.pull_request && payload.review) return "pull_request_review";
    if (payload.pull_request && payload.action) return "pull_request";
    if (payload.check_run) return "check_run";
    return undefined;
  }
}
