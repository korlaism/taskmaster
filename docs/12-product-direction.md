# 12 — Product direction (decided 2026-10-06)

This supersedes the "single internal tool" framing in [00](./00-assumptions-and-risks.md) and the
phase order in [09](./09-development-phases.md). Where those docs disagree with this one, this one wins.

## What Taskmaster is

An open-source engineering and QA process bot. It joins a team as a teammate that people can DM,
@mention in a group chat, or add to a channel. Its job is to remove process overhead: ticket hygiene,
triage, status updates, review routing, next-task allocation, leave, and release reporting.

| Decision | Choice |
|---|---|
| Licence | **AGPL-3.0-only** (see [`LICENSE`](../LICENSE)) |
| Repository | Public |
| Hosting | Each organisation self-hosts its own install (fork and run). A paid hosted version may come later. |
| First organisation | The author's own team, as the first test install |
| First chat channel | Microsoft Teams. Slack, Telegram and others follow behind the same adapter interface. |
| Issue tracker / Git host | Jira Cloud and GitHub first, behind interfaces |
| Metrics | Team-level only. **No per-person ranking, no lines-of-code metric.** |

Consequences:
- Nothing organisation-specific may live in code or committed defaults: Jira site, project keys,
  field ids, component ids, people and roles all live in config and `policy.yaml`. Today `src/config/env.ts`
  still defaults `JIRA_BASE_URL` to the first test org's site, and the docs name it. Removing that is part of Phase A.
- `org_id` stays on every row so a hosted multi-org version later is an extension, not a rewrite.
- AGPL plus a paid hosted version: the copyright holder can always offer a hosted service. To keep the
  option of other licences later, outside contributions need a CLA. Settle the details at the legal step.

## Roles (RBAC)

| Role | Can |
|---|---|
| **admin** | Everything a lead can do. Configure the install and policy, generate reports and send them to whoever needs them. Set up during first-run setup with a one-time setup token. |
| **lead** | Triage new tickets (fix version + priority, or reject). Receive review and approval requests routed to them. Get escalations. |
| **dev** | Ask for next task, request reviews, report leave, see their own summary |
| **qa** | Hand the bot tickets to clean up, answer its questions, get pinged on fixes ready to retest, report leave |

Roles are additive. Every action is authorised per role, the same in DMs, group chats and channels.
Reports are not broadcast: the admin generates a report and chooses who receives it.

## Workflows

### Triage (every new ticket)
1. A new ticket is detected (webhook, or the periodic re-sync).
2. The bot DMs the lead(s) for its component. Options: set **fix version** + **priority**, or **reject** with a reason.
3. No answer within the policy time: remind, then escalate to admin.
4. Untriaged tickets are never suggested as work.

### QA ticket clean-up
QA create tickets in the tracker as usual, then give the bot a list ("check PROJ-301, PROJ-302").
For each ticket the bot checks the policy's required fields: description, steps to reproduce, acceptance criteria,
**affects version**, **severity**, component. It DMs the QA one question per missing field,
writes each answer back, and confirms when the ticket is complete. It never sets fix version or priority,
because those are the lead's triage decision. Creating a ticket through the bot stays available, but is optional.

### Next task
1. A developer asks for their next task.
2. Gate: the bot checks the previous assigned ticket. Its PR must be merged and the ticket moved on. If not, it says what's missing and stops.
3. Candidates: triaged, unassigned, not blocked tickets.
4. Order (default, configurable in `policy.yaml`):
   1. **Release first:** only the earliest-dated unreleased fix version that still has candidates. If it has none, go to the next release.
   2. **Severity**, highest first.
   3. **Priority**, Highest first.
   4. Age, oldest first, as the final tie-break.
5. The bot shows the top suggestion and *why* (release, severity, priority). The developer accepts and the bot assigns it.
   Whether a lead must confirm is a policy switch.

Open question: tickets without a severity (stories and tasks) need a defined place in step 2.
They could sort as lowest severity, or by priority alone. Decide in `policy.yaml`.

### Reviews and approvals
Triggered by a dev ("review please" in a DM or group) or by a PR being opened. The reviewer comes
from policy routing (repo/component → people), skipping anyone on leave. Remind after N hours, escalate after M hours.
Approval stays human-only ([ADR-6](./01-architecture-decision-record.md)).

### Status automation
Branch created → In Progress, PR opened → In Review, merged → In QA (the transitions are mapped in policy).
When a fix merges, the QA who raised the bug is pinged with the build that contains it.

### Leave
"Off Thursday and Friday" in a DM. Used by reminders, review routing, next-task and the release forecast.
Only availability is stored, never the reason.

### Reports
- **Personal daily summary** on request: what I did, what's waiting on me.
- **Weekly release report** (admin generates, then sends):
  - progress against plan (burn-up), scope added mid-release
  - bugs found vs fixed by severity
  - PRs merged, PR cycle time, review wait time
  - reopened tickets, CI pass rate, test-count change per repo
  - stale PRs and tickets

### Policy
One versioned `policy.yaml` per install covers roles, review routing, required fields per issue type,
reminder and escalation hours, status-transition mapping, next-task ordering, and whether leads confirm.
It changes through a PR. The existing `PolicyEngine` seam is where it plugs in.

## Build order (replaces 09's phase list going forward)

| Phase | Scope | External dependency |
|---|---|---|
| **A. Productise the core** | Org config and first-run setup (admin via setup token), RBAC, `policy.yaml`, channel adapter interface + neutral card model, remove org-specific defaults | none |
| **B. Teams live** | App manifest with personal/groupChat/team scopes, @mention handling in groups, conversation layer (commands + buttons; free text maps to fixed actions, always confirmed). GitHub webhook receiver, Jira re-sync job. | Entra app registration + Azure Bot (test org IT), Jira service account, GitHub org webhook |
| **C. Triage + QA clean-up** | Both workflows above | B |
| **D. Dev flow** | Status automation, next task, review routing, leave | B |
| **E. Weekly release report** | Metrics above, admin generate-and-send | C, D |
| **F. Later** | Second channel (Slack), hosted multi-org version, optional AI wording (labelled, never a metric) | — |
