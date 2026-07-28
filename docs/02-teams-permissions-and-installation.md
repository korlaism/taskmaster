# Teams Permission and Installation Plan

**Status: `TeamsAppClient` (`src/modules/teams-adapter/real-client.ts`) is implemented
against `@microsoft/teams.apps` v2.0.14's published types and Microsoft Learn's
documented quickstart, but has never run against a live tenant — no Entra app
registration existed while building this. The registration steps below are what's
needed to actually turn `TEAMS_ADAPTER_MODE=live` on; do that, then verify the
`install.add` capture and card-decision routing in `src/api.ts` still match what the
real activities look like (they were written from documentation, not observation).**

## Registering the app (do this to get CLIENT_ID / CLIENT_SECRET / TENANT_ID)

The fastest path is the Teams Developer CLI, which provisions the Entra app, the
Azure Bot resource, and the Teams channel in one command:

```bash
npm install -g @microsoft/teams.cli
teams app create --azure --subscription <subscription-id> --resource-group <resource-group>
```

This writes `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` — copy those into `.env`. If you
don't have Azure CLI access or your tenant policy requires manual resource creation,
the equivalent manual steps (Azure Portal or `az` CLI) are:

1. **Entra App Registration** — Azure Portal → Entra ID → App Registrations → New. Note
   the `Application (client) ID` and `Tenant ID`; create a client secret under
   *Certificates & secrets*.
2. **Azure Bot resource** — Azure Portal → Create → search "Bot" → Azure Bot. Choose
   **Single Tenant**, **Use existing app registration**, and supply the Application ID
   from step 1.
3. **Messaging endpoint** — under the Bot resource's *Configuration*, set the messaging
   endpoint to `https://<your-host>/api/messages` (for local dev, tunnel via
   [DevTunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/overview) or
   ngrok and use the tunnel's HTTPS URL).
4. **Enable the Teams channel** — under the Bot resource's *Channels*, add
   **Microsoft Teams**.
5. Set `TEAMS_ADAPTER_MODE=live`, `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` in `.env`
   and start `npm run dev:api` — it builds the `App` bound to this process's Express
   server (`setupLiveTeamsApp` in `src/api.ts`) and registers `/api/messages`.
6. Sideload the app package (manifest + icons) into Teams — via Teams Developer
   Portal, or `teams app package` if using the CLI-scaffolded project shape — pointing
   its bot `id` at the Application ID from step 1.

## Scopes

- **Personal scope**: private reminders, daily-update card, review-request cards, QA ticket creation card.
- **Team scope**: the standard channel the digest is published into. V1 targets exactly one configured team + one configured channel (`administration.setDigestChannel`).

## App registration (Microsoft 365 Agents Toolkit / Entra ID)

- Single-tenant Entra ID app registration.
- Bot capability declared in the app manifest with `personal` and `team` scopes only — no `groupChat`, no messaging extension in V1.
- Admin consent granted once at install for whatever minimal Bot/Graph scopes the manifest declares.

## Least-privilege principle

- **No `ChannelMessage.Read.All`, no broad channel-read consent.** The bot only ever *sends* (personal reminders, the digest channel post) — it never reads channel conversations. This is a hard requirement from the security section of the spec ("avoid granting the bot broad channel-message read access unless the feature explicitly requires it" / "do not ingest unrelated Teams conversations").
- User identity for authorization comes from the Teams activity's AAD object id (`entra_object_id` in the `users` table) — no extra Graph `User.Read` consent is needed for basic identity in V1.
- Sending a channel post requires the bot to already be installed in that team/channel (captured as a `teams_installations` row) — no organization-wide channel access is requested.

## Proactive messaging: conversation reference lifecycle

Teams cannot be proactively messaged until a conversation reference exists for that subject (user or channel). The `conversation_references` table (module: `teams-adapter`) is the source of truth, one row per `(organization_id, subject_type, subject_id)`:

1. **Personal install** — when a user adds the personal app (or first messages it), the activity handler captures `service_url`, `conversation_id`, `tenant_id` and calls `teamsAdapter.captureConversationReference`. In the vertical slice this is simulated via `POST /teams/install/personal`.
2. **Team/channel install** — when an admin adds the app to the target team, the same capture happens for the channel subject, and `administration.setDigestChannel` records which channel is the digest target. Simulated via `POST /teams/install/channel`.
3. **Invalidation** — a send that comes back "blocked" or "not installed" (see below) flips `conversation_references.is_valid = FALSE` for that subject. It is not deleted (so admins can see who's disconnected), and no further sends are attempted until the subject reinstalls and a fresh capture occurs.

## Graceful failure matrix

| Condition | Detection | Behavior |
|---|---|---|
| User uninstalled/blocked the app | `TeamsClient` send returns `kind: 'blocked'` or `'not_installed'` | `conversation_references.is_valid` set false; job marked done (not retried) — logged, not thrown |
| App not installed in the configured team | No `conversation_references` row for the channel subject | `sendChannelCard` returns `delivered:false, reason:'no_conversation_reference'`; outbox handler logs and does not retry |
| Configured channel no longer exists | Send returns `not_installed`/`blocked` equivalent from the provider | Same as above; admin's integration-health view (`administration.listIntegrationFailures`) is where this should surface once wired to `integration_failures` |
| User left the organization | `users.enabled` should be set false via the org's offboarding process feeding `administration.setUserEnabled`; disabled users are excluded from scheduling entirely | No reminder is generated in the first place |
| Teams throttling / transient error | Send returns `kind: 'throttled'` or `'transient_error'` | Retryable — the outbox dispatcher's exponential backoff (base 2s, cap 10min, jittered) retries up to 8 attempts before dead-lettering |

This matrix is implemented in `TeamsAdapterService.send` (`src/modules/teams-adapter/service.ts`) and exercised for the personal-reminder and digest-publish paths in `src/runtime-tick.ts`.

## Command/button surfaces (server-enforced, never client-trusted)

Every role-gated action (review request, review decision, QA ticket creation, admin configuration) calls `IdentityService.requireRole`/`requireEnabled` at the top of its service method — a hidden Teams button or a hand-crafted `Action.Submit` payload cannot bypass this, because the check happens server-side regardless of what the Teams client rendered.
