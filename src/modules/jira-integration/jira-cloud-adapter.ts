import { childLogger } from "../../shared/logger.js";
import type {
  CreateIssueInput,
  CreateMetaField,
  JiraClient,
  JiraIssueEventInput,
  JiraIssueSuggestion,
} from "./domain.js";

const log = childLogger({ module: "jira-integration" });

export interface JiraCloudConfig {
  baseUrl: string; // e.g. https://simnovus.atlassian.net
  email: string; // service-account email
  apiToken: string;
  /** Shared secret compared against the webhook receiver's `?token=` query param.
   * Classic Jira Cloud outgoing webhooks don't sign payloads the way GitHub does —
   * see verifyWebhookSignature below for why this is the pragmatic POC approach. */
  webhookSharedSecret?: string;
}

interface JqlSearchResponse {
  issues: Array<{
    key: string;
    fields: { summary: string; status: { name: string } };
  }>;
  nextPageToken?: string;
}

interface CreateMetaIssueTypesResponse {
  issueTypes: Array<{ id: string; name: string }>;
}

interface CreateMetaFieldsResponse {
  fields: Array<{
    fieldId: string;
    name: string;
    required: boolean;
    allowedValues?: Array<{ value?: string; name?: string }>;
  }>;
}

function toAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
  };
}

/** yyyy-MM-dd HH:mm — the JQL date-literal format. JQL date comparisons are evaluated
 * in the Jira SITE's configured timezone, not necessarily this app's organization
 * timezone; for a POC this formats the window bound in UTC, which can skew the
 * suggestion window by a few hours if the Jira site's timezone differs from UTC.
 * Acceptable for a POC — align via GET /rest/api/3/myself's `timeZone` before
 * production use if the two diverge meaningfully. */
function toJqlDateTime(date: Date): string {
  const iso = date.toISOString(); // 2026-01-15T14:00:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Real Jira Cloud adapter (REST API v3) for https://simnovus.atlassian.net, authenticated
 * as a dedicated service account via email + API token (Basic auth), per the POC's
 * documented auth choice (docs/03-jira-authentication-plan.md).
 *
 * Deliberately uses /rest/api/3/search/jql (NOT the removed /rest/api/3/search) and the
 * granular /issue/createmeta/{project}/issuetypes[/​{issueTypeId}] endpoints — both
 * confirmed current against Atlassian's 2025 API deprecations before writing this file.
 */
export class JiraCloudAdapter implements JiraClient {
  constructor(private readonly config: JiraCloudConfig) {}

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64");
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (res.status === 429 && attempt < 3) {
      const retryAfterSeconds = Number(res.headers.get("retry-after") ?? "1");
      log.warn({ path, attempt, retryAfterSeconds }, "Jira rate-limited; backing off");
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      return this.request<T>(path, init, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jira request failed: ${init.method ?? "GET"} ${path} -> ${res.status} ${body.slice(0, 500)}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async jql(jql: string, reason: JiraIssueSuggestion["reason"]): Promise<JiraIssueSuggestion[]> {
    const data = await this.request<JqlSearchResponse>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql, maxResults: 50, fields: ["summary", "status"] }),
    });
    return data.issues.map((issue) => ({
      issueKey: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      reason,
    }));
  }

  /**
   * Runs the five suggestion categories from the product spec as separate JQL queries
   * (rather than one OR'd query) specifically so each result can be tagged with *why*
   * it's suggested — that provenance is part of JiraIssueSuggestion and would be lost
   * if a single combined query were used. "Updated by the user" is approximated as
   * "status changed AND user is assignee/reporter" since classic JQL has no direct
   * "last updated by" clause.
   */
  async suggestIssuesForReportingWindow(params: {
    userExternalAccountId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<JiraIssueSuggestion[]> {
    const { userExternalAccountId: acct } = params;
    const start = toJqlDateTime(params.windowStart);
    const end = toJqlDateTime(params.windowEnd);

    const queries: Array<{ jql: string; reason: JiraIssueSuggestion["reason"] }> = [
      { jql: `assignee changed to "${acct}" during ("${start}", "${end}")`, reason: "assigned_during_window" },
      {
        jql: `status changed during ("${start}", "${end}") AND (assignee = "${acct}" OR reporter = "${acct}")`,
        reason: "status_changed_during_window",
      },
      { jql: `reporter = "${acct}" AND created >= "${start}" AND created <= "${end}"`, reason: "created_by_user" },
      { jql: `assignee = "${acct}" AND statusCategory = "In Progress"`, reason: "currently_assigned_active" },
    ];

    const seen = new Map<string, JiraIssueSuggestion>();
    for (const q of queries) {
      try {
        const results = await this.jql(q.jql, q.reason);
        for (const r of results) if (!seen.has(r.issueKey)) seen.set(r.issueKey, r);
      } catch (err) {
        // One suggestion category failing (bad JQL for this site's config, transient
        // error) shouldn't block the whole reminder card — log and continue with
        // whatever other categories succeeded.
        log.warn({ reason: q.reason, err: (err as Error).message }, "suggestion query failed, skipping");
      }
    }
    return [...seen.values()];
  }

  async searchIssuesByJql(jql: string): Promise<JiraIssueSuggestion[]> {
    return this.jql(jql, "status_changed_during_window");
  }

  async getCreateMeta(projectKey: string, issueType: string): Promise<CreateMetaField[]> {
    const types = await this.request<CreateMetaIssueTypesResponse>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`
    );
    const match = types.issueTypes.find((t) => t.name.toLowerCase() === issueType.toLowerCase());
    if (!match) {
      throw new Error(`Issue type "${issueType}" not found for project ${projectKey}`);
    }
    const fields = await this.request<CreateMetaFieldsResponse>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${match.id}`
    );
    return fields.fields.map((f) => ({
      fieldId: f.fieldId,
      name: f.name,
      required: f.required,
      allowedValues: f.allowedValues?.map((v) => v.value ?? v.name ?? "").filter(Boolean),
    }));
  }

  async createIssue(input: CreateIssueInput): Promise<{ issueKey: string; url: string }> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      description: toAdf(input.description),
    };
    // Only pass through fields that were actually provided — createmeta validation
    // in qa-ticket-workflow/service.ts already rejected the request if something
    // required is missing, so this stays a direct passthrough, not a second validation pass.
    for (const [key, value] of Object.entries(input.fields)) {
      if (value !== undefined && value !== null && value !== "") fields[key] = value;
    }

    const created = await this.request<{ key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    return { issueKey: created.key, url: `${this.config.baseUrl}/browse/${created.key}` };
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: toAdf(body) }),
    });
  }

  async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
    const available = await this.request<{ transitions: Array<{ id: string; name: string }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
    );
    const match = available.transitions.find((t) => t.name.toLowerCase() === transitionName.toLowerCase());
    if (!match) {
      throw new Error(`Transition "${transitionName}" not available for issue ${issueKey}`);
    }
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }

  /**
   * Classic Jira Cloud outgoing webhooks (Project settings > Webhooks) have no native
   * request-signing mechanism (unlike GitHub's HMAC signature or Connect/Forge apps'
   * JWT). The pragmatic POC substitute: register the webhook URL with a `?token=`
   * query parameter and compare it here. `signatureHeader` carries that query value —
   * the route handler passes it in, not an actual HTTP header. Revisit if this
   * integration moves to a Connect/Forge app, which does support verifiable JWTs.
   */
  verifyWebhookSignature(_rawBody: string, signatureHeader: string | undefined): boolean {
    if (!this.config.webhookSharedSecret) {
      log.warn("no JIRA webhook shared secret configured; rejecting all webhook deliveries");
      return false;
    }
    return signatureHeader === this.config.webhookSharedSecret;
  }

  normalizeWebhookEvent(rawBody: unknown): JiraIssueEventInput[] {
    const payload = rawBody as {
      webhookEvent?: string;
      timestamp?: number;
      user?: { accountId?: string };
      issue?: { id: string; key: string; fields: { project: { key: string }; status: { name: string } } };
      changelog?: { items: Array<{ field: string; from: string | null; fromString: string | null; to: string | null; toString: string | null }> };
    };
    if (!payload.issue) return [];

    const occurredAt = payload.timestamp ? new Date(payload.timestamp) : new Date();
    const actorExternalId = payload.user?.accountId ?? null;
    const base = {
      jiraIssueId: payload.issue.id,
      issueKey: payload.issue.key,
      projectKey: payload.issue.fields.project.key,
      actorExternalId,
      occurredAt,
      source: "webhook" as const,
    };

    if (payload.webhookEvent === "jira:issue_created") {
      return [{ ...base, eventType: "created", fromValue: null, toValue: payload.issue.fields.status.name }];
    }

    if (payload.webhookEvent === "jira:issue_updated" && payload.changelog) {
      return payload.changelog.items.map((item) => {
        if (item.field === "status") {
          return { ...base, eventType: "status_changed" as const, fromValue: item.fromString, toValue: item.toString };
        }
        if (item.field === "assignee") {
          return { ...base, eventType: "assigned" as const, fromValue: item.from, toValue: item.to };
        }
        return { ...base, eventType: "updated" as const, fromValue: null, toValue: item.field };
      });
    }

    return [];
  }
}
