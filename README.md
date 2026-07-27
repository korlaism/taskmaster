# Taskmaster

An internal Microsoft Teams workflow agent that collects daily engineering updates,
enriches them with Jira and Git activity, coordinates lead review requests, lets QA
create Jira tickets from Teams, and publishes a consolidated leadership digest.

Jira, the Git provider, and explicit user submissions are the source of truth for
workflow state and metrics — never an LLM. See [docs/](./docs) for the full design.

## Status

**V1 vertical slice.** The workflow engine — scheduling, idempotent submission,
retry-safe outbox delivery, deterministic metrics, immutable digest snapshots — is
implemented and tested end to end against a real Postgres. Teams and Jira are stood
in for with a local simulation and a fake adapter respectively, behind stable
interfaces (`TeamsClient`, `JiraClient`), pending two organizational decisions (which
Teams SDK package, Jira Cloud vs Data Center) documented in
[docs/00-assumptions-and-risks.md](./docs/00-assumptions-and-risks.md). Git-provider
integration, the review-workflow and QA-ticket Teams cards, and AI summarization are
later phases — see [docs/09-development-phases.md](./docs/09-development-phases.md).

## Documentation

| Doc | Covers |
|---|---|
| [00 — Assumptions & risks](./docs/00-assumptions-and-risks.md) | What's assumed, what's still an open decision, feasibility risks |
| [01 — Architecture decision record](./docs/01-architecture-decision-record.md) | Why a modular monolith, the outbox pattern, scheduler design, the policy-engine seam |
| [02 — Teams permissions & installation](./docs/02-teams-permissions-and-installation.md) | Scopes, least-privilege, conversation-reference lifecycle, graceful failure matrix |
| [03 — Jira authentication plan](./docs/03-jira-authentication-plan.md) | Cloud vs Data Center, webhook verification, normalization |
| [04 — Git-provider integration plan](./docs/04-git-provider-integration-plan.md) | The `GitProvider` interface, dedup/linking rules |
| [05 — Data model](./docs/05-data-model.md) | Every table, and *why* it's shaped the way it is |
| [06 — API & event contracts](./docs/06-api-and-event-contracts.md) | HTTP routes, Adaptive Card submission contract, outbox event types |
| [07 — Adaptive Card wireframes](./docs/07-adaptive-card-wireframes.md) | Daily update, review request, QA ticket, digest cards |
| [08 — Threat model](./docs/08-threat-model.md) | Trust boundaries, STRIDE-style walk, explicit gaps |
| [09 — Development phases](./docs/09-development-phases.md) | What's next, in order, and its exit criteria |
| [10 — Local development](./docs/10-local-development.md) | Setup, running, a full manual walkthrough, test harness explained |
| [11 — Test strategy](./docs/11-test-strategy.md) | What's covered, what isn't yet, and why the tests run against real Postgres |

## Quick start

```bash
npm install
cp .env.example .env
docker compose up -d
npm run migrate
npm run dev:api
npm test
```

See [docs/10-local-development.md](./docs/10-local-development.md) for the full walkthrough.

## Repository layout

```
src/
  api.ts              # HTTP surface: admin config, webhook/card receivers
  worker.ts            # scheduler tick + outbox dispatcher (standalone process shape)
  composition.ts        # wires every module's concrete dependencies together
  runtime-tick.ts        # the one scheduler+outbox pass, shared by api.ts (local-sim) and worker.ts
  modules/
    teams-adapter/       # TeamsClient interface + local-sim implementation
    identity/            # users, roles, server-side authorization
    user-preferences/    # per-user reminder-time/timezone overrides, pause
    scheduler/           # notification_jobs: exactly-once due-job claiming
    daily-updates/        # update cycles, Adaptive Card, idempotent submission
    jira-integration/      # JiraClient interface + fake adapter
    git-integration/       # GitProvider interface (no implementation yet)
    review-workflow/       # review requests + the policy-engine seam
    qa-ticket-workflow/    # QA-initiated Jira ticket creation
    metrics/              # deterministic metric computation from durable tables
    digest/                # digest render + immutable snapshot + publish-once
    notifications/         # outbox_events: retry/backoff/dead-letter/replay
    audit/                 # append-only audit log
    administration/        # org config, digest channel, enable/disable users
db/migrations/            # schema (see docs/05-data-model.md)
test/{unit,integration,contract}/
docs/                      # the design documents listed above
```
