# Threat Model

Scope: the V1 modular monolith (`api`/`worker` processes), its Postgres store, and its three external integration surfaces (Teams, Jira, Git). Uses a lightweight STRIDE-style walk per trust boundary rather than a full formal model, sized to match V1's actual attack surface.

## Trust boundaries

```
[Teams client] --activity/invoke--> [api process] --SQL--> [Postgres]
[Jira] --webhook--> [api process]
[Git provider] --webhook--> [api process]
[worker process] --SQL--> [Postgres]
[worker process] --send--> [Teams] , [write--> Jira/Git (future)]
[admin] --HTTP--> [api process] (role-gated)
```

## Assets

- User submission content (daily updates, review notes) — sensitive to the org, not classified/regulated, but private.
- Jira/Git OAuth tokens and webhook secrets (`jira_connections.encrypted_credentials`, `git_connections.encrypted_credentials`) — high value, would grant read/write access to the org's Jira/Git if exfiltrated.
- Audit trail (`audit_events`) — integrity matters more than confidentiality; used to answer "who approved/configured what."
- Digest content — moderately sensitive (surfaces individual performance signals like missing submissions) but posted to an internal channel by design.

## Threats and mitigations

### Spoofing

- **Threat**: a forged Jira/Git webhook injects fake status transitions or commits, corrupting metrics or triggering unwanted actions.
  **Mitigation**: `JiraClient.verifyWebhookSignature` / `GitProvider.verifyWebhook` reject any payload without a valid signature *before* normalization runs — normalization never processes an unverified body. Contract tests must include a "wrong/missing signature is rejected" case for whichever adapter is built (see [03](./03-jira-authentication-plan.md), [04](./04-git-provider-integration-plan.md)).
- **Threat**: a Teams activity is spoofed to impersonate another user's identity.
  **Mitigation**: identity comes from the Teams SDK's validated activity/JWT, never a client-supplied field — the `entra_object_id` used for all authorization checks is what the (future real) Teams SDK middleware validates, not anything in a card's `data` payload.

### Tampering

- **Threat**: a user crafts a raw `Action.Submit` payload (bypassing whatever the Teams client rendered) to submit as a different user or with a forged role.
  **Mitigation**: every role-gated service method (`IdentityService.requireRole`/`requireEnabled`) re-checks the *server's* record of the acting user's roles — a hidden/removed button is a UX nicety, never the enforcement point (explicit product requirement).
- **Threat**: a compromised worker/admin credential rewrites `audit_events` to cover tracks.
  **Mitigation**: `audit_events` is append-only by convention (no `UPDATE`/`DELETE` statement exists in the codebase against it); a production hardening step is a database-level trigger or role permission that rejects `UPDATE`/`DELETE` on that table outright, not just "no code happens to do it."

### Repudiation

- **Threat**: a lead denies having approved/rejected a review, or an admin denies a config change.
  **Mitigation**: `audit_events` records every review decision and every administration action with `actor_user_id`, `action`, `target_id`, `occurred_at`. `evaluateAutoApproval` is always `false` in V1 specifically so a decision can never be attributed to "the system" instead of a human.

### Information disclosure

- **Threat**: access tokens, webhook secrets, or card-submission idempotency keys leak via logs.
  **Mitigation**: `src/shared/logger.ts` redacts `token`/`accessToken`/`refreshToken`/`encrypted_credentials`/`webhookSecret`/`authorization` paths at the logger level, not left to call-site discipline. This should be revisited whenever a new field name carrying a secret is introduced — redaction is a pattern list, not automatic.
- **Threat**: the bot's Teams permissions are broad enough to read unrelated channel conversations.
  **Mitigation**: no `ChannelMessage.Read.All` or equivalent is requested (see [02](./02-teams-permissions-and-installation.md)) — the bot's Teams footprint is send-only by design, which also limits blast radius if the bot's identity were ever compromised.
- **Threat**: cross-tenant data leakage (org A sees org B's data).
  **Mitigation**: every tenant-owned table carries `organization_id`; V1 runs one organization per deployment (see [00](./00-assumptions-and-risks.md)), so today this is enforced by "there is only one org," not yet by row-level security. **This is the single biggest gap to close before ever running multiple organizations against one deployment** — Postgres row-level security policies keyed on `organization_id`, or an application-layer tenant guard on every query, should be added before that happens.

### Denial of service

- **Threat**: a burst of reminder sends at the same instant throttles the Teams API for the whole org.
  **Mitigation**: outbox dispatcher backoff absorbs individual 429s; a production hardening step (not yet implemented) is jittering each user's scheduled send time by a few seconds so a large org doesn't generate a synchronized burst (flagged in [00](./00-assumptions-and-risks.md)).
- **Threat**: a malicious or buggy webhook sender floods the ingestion endpoint.
  **Mitigation**: signature verification rejects unauthenticated payloads cheaply before any DB work; rate-limiting at the ingress (reverse proxy / API gateway) is a deployment-layer concern outside this codebase's scope but should be part of the production rollout checklist.

### Elevation of privilege

- **Threat**: a developer grants themselves the `administrator` role by calling an admin endpoint directly.
  **Mitigation**: `AdministrationService.requireAdmin` gates every configuration mutation; role *assignment* itself (`identity.assignRole`) is only reachable through the admin-gated `/dev/users`-style bootstrap route in the vertical slice — production must replace that dev-only route with an admin-authenticated "manage roles" flow before shipping (explicitly called out as a V1-only bootstrap exception in [06](./06-api-and-event-contracts.md)).

## Explicitly out of scope for V1

- Formal penetration testing / red-team exercise.
- Row-level security / true multi-tenant isolation (single-org deployment only, see above).
- Data-retention automation (the spec calls for "configurable data-retention rules" — not yet implemented; flagged as a gap, not silently assumed away).
