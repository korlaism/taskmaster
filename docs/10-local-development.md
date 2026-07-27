# Local Development

## Prerequisites

- Node.js 20+
- Docker (for Postgres) — or any Postgres 14+ instance you already have running locally
- No Microsoft 365 tenant or Azure subscription is required for this vertical slice — `TEAMS_ADAPTER_MODE=local-sim` and `JIRA_ADAPTER_MODE=fake` are the defaults in `.env.example`, standing in for the real Teams client and Jira until Phases 1–2 (see [09-development-phases.md](./09-development-phases.md)).

## Setup

```bash
npm install
cp .env.example .env      # defaults work as-is for local dev
docker compose up -d      # starts Postgres on localhost:5432
npm run migrate           # applies db/migrations/*.sql
```

## Running

Local-sim mode runs the whole loop (HTTP API + scheduler tick + outbox dispatcher) in a single process, since local-sim's in-memory "last card sent" inbox only makes sense shared within one process:

```bash
npm run dev:api
```

Once a real Teams client replaces local-sim (Phase 1), the intended shape is two processes:

```bash
npm run dev:api      # HTTP surface: admin config, webhooks, card actions
npm run dev:worker   # scheduler tick + outbox dispatcher, no HTTP surface
```

## Driving the vertical slice by hand

With `npm run dev:api` running (default port 3978):

```bash
# 1. Bootstrap the first user (dev-only route — see docs/06 for why this one route
#    isn't role-gated: there's no admin to gate it against yet).
curl -s -X POST localhost:3978/dev/users -H 'Content-Type: application/json' \
  -d '{"entraObjectId":"entra-1","displayName":"Ada Admin","roles":["administrator","developer"]}'
# → { "id": "<userId>", ... }

# 2. Simulate the Teams personal-app-install event (captures a conversation reference).
curl -s -X POST localhost:3978/teams/install/personal -H 'Content-Type: application/json' \
  -d '{"userId":"<userId>","serviceUrl":"https://example.invalid/","conversationId":"c1","tenantId":"t1"}'

# 3. Simulate installing the app into the target team/channel (also sets it as the digest target).
curl -s -X POST localhost:3978/teams/install/channel -H 'Content-Type: application/json' \
  -d '{"actorUserId":"<userId>","teamId":"team-1","channelId":"channel-1","serviceUrl":"https://example.invalid/","conversationId":"c2","tenantId":"t1"}'

# 4. Wait a tick (SCHEDULER_TICK_INTERVAL_MS, default 15s), then inspect the delivered card:
curl -s localhost:3978/local-sim/cards/<userId>
# → the Adaptive Card JSON, including cycleId + idempotencyKey in each action's `data`

# 5. Submit the update (the daily-update card's Action.Submit contract — see docs/06):
curl -s -X POST localhost:3978/cards/daily-update/submit -H 'Content-Type: application/json' \
  -d '{"cycleId":"<cycleId>","userId":"<userId>","idempotencyKey":"<key>","intent":"submit","completedToday":"Shipped X"}'
# Submitting again with the SAME idempotencyKey is a safe no-op (isNewRevision:false).

# 6. After the cycle's digestPublishTime passes, inspect the published digest and channel post:
curl -s localhost:3978/digest/<cycleId>
curl -s localhost:3978/local-sim/cards/channel-1
```

By default the org's reminder/cutoff/digest-publish times come from `.env` (`ORG_DEFAULT_*`); to see the loop fire quickly in a manual test, set a reminder time a couple of minutes in the past and a digest-publish time a couple of minutes in the future (in `ORG_TIMEZONE`) via `.env` before starting, or `POST /admin/organization` with `actorUserId` set to an administrator.

## Running the automated tests

```bash
npm test
```

Tests run against a **real Postgres** — but not the `docker compose` one. `test/support/global-setup.ts` boots `@electric-sql/pglite` (Postgres compiled to WASM) behind a real wire-protocol TCP socket (`@electric-sql/pglite-socket`) on `127.0.0.1:28632`, applies `db/migrations/*.sql` to it, and tears it down after the run. This means:

- `npm test` needs no Docker, no running `docker compose` service, and no network access.
- Every query in the test suite — including `FOR UPDATE SKIP LOCKED` concurrency claims and JSONB digest snapshots — runs against genuine Postgres semantics, not a hand-rolled mock.
- Tests run with `fileParallelism: false` (one shared instance for the whole run; `test/support/reset-db.ts` truncates all tables between test files).

## Type-checking

```bash
npm run lint   # tsc --noEmit
```

## What "running the Teams app locally" does and doesn't mean today

This vertical slice proves the workflow logic — scheduling, idempotent submission, retry-safe outbox delivery, immutable digest snapshots — end to end, using a local simulation in place of the real Teams client and Jira. It does **not** yet demonstrate opening the actual Microsoft Teams client and interacting with a real Adaptive Card there; that requires a Microsoft 365 developer tenant, the Microsoft 365 Agents Toolkit CLI/VS Code extension, and the Phase 1 work in [09-development-phases.md](./09-development-phases.md). The interfaces (`TeamsClient`, `JiraClient`) are shaped so that work is additive, not a rewrite.
