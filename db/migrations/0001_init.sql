-- 0001_init.sql
-- Full V1 data model (docs/05-data-model.md). Only the tables touched by the
-- vertical slice have application code against them today; the rest exist so
-- later phases are additive migrations, not schema surgery.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy, identity, roles
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  timezone              TEXT NOT NULL,                 -- IANA tz, e.g. 'America/New_York'
  default_reminder_time TIME NOT NULL,
  update_cutoff_time    TIME NOT NULL,
  digest_publish_time   TIME NOT NULL,
  weekends_disabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_holidays (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  holiday_date    DATE NOT NULL,
  UNIQUE (organization_id, holiday_date)
);

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  entra_object_id  TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  email            TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, entra_object_id)
);

CREATE TABLE roles (
  code TEXT PRIMARY KEY   -- 'developer' | 'lead' | 'qa' | 'administrator'
);
INSERT INTO roles(code) VALUES ('developer'), ('lead'), ('qa'), ('administrator');

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id),
  role    TEXT NOT NULL REFERENCES roles(code),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_preferences (
  user_id               UUID PRIMARY KEY REFERENCES users(id),
  timezone_override     TEXT,                 -- NULL => inherit organization timezone
  reminder_time_override TIME,                -- NULL => inherit organization default
  paused_until          DATE,                 -- per-user temporary pause
  follow_up_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE external_identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  user_id             UUID NOT NULL REFERENCES users(id),
  provider            TEXT NOT NULL,          -- 'jira' | 'git'
  external_account_id TEXT NOT NULL,          -- Jira accountId / Git provider user id, never email/display name
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_account_id)
);

-- ---------------------------------------------------------------------------
-- Teams installation / proactive messaging
-- ---------------------------------------------------------------------------

CREATE TABLE teams_installations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  scope           TEXT NOT NULL,              -- 'personal' | 'team'
  team_id         TEXT,                       -- Teams team id, when scope='team'
  channel_id      TEXT,                       -- configured standard channel, when this is the digest target
  installed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at  TIMESTAMPTZ
);

CREATE TABLE conversation_references (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  subject_type    TEXT NOT NULL,              -- 'user' | 'channel'
  subject_id      TEXT NOT NULL,              -- user_id (uuid as text) or channel_id
  service_url     TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_valid        BOOLEAN NOT NULL DEFAULT TRUE,  -- flipped false on 403/blocked/uninstalled
  UNIQUE (organization_id, subject_type, subject_id)
);

-- ---------------------------------------------------------------------------
-- Jira integration
-- ---------------------------------------------------------------------------

CREATE TABLE jira_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  deployment_type TEXT NOT NULL,              -- 'cloud' | 'data_center'
  base_url        TEXT NOT NULL,
  auth_mode       TEXT NOT NULL,              -- 'oauth2' | 'service_account'
  encrypted_credentials BYTEA,                -- envelope-encrypted token/secret material
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jira_projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  jira_project_key  TEXT NOT NULL,
  is_qa_project      BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (organization_id, jira_project_key)
);

CREATE TABLE jira_status_mappings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES jira_projects(id),
  raw_status   TEXT NOT NULL,
  bucket       TEXT NOT NULL,                 -- 'not_started' | 'active' | 'qa' | 'approval' | 'done'
  UNIQUE (project_id, raw_status)
);

CREATE TABLE jira_issues (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id),
  jira_issue_id      TEXT NOT NULL,           -- Jira's numeric/opaque id, stable across renames
  issue_key          TEXT NOT NULL,           -- e.g. 'SIM40-1234', can change; not the identity
  project_id         UUID NOT NULL REFERENCES jira_projects(id),
  current_status     TEXT NOT NULL,
  current_assignee_external_id TEXT,
  created_at_jira    TIMESTAMPTZ NOT NULL,
  updated_at_jira    TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, jira_issue_id)
);
CREATE INDEX idx_jira_issues_key ON jira_issues(issue_key);

CREATE TABLE jira_issue_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jira_issue_id   UUID NOT NULL REFERENCES jira_issues(id),
  event_type      TEXT NOT NULL,              -- 'created' | 'assigned' | 'status_changed' | 'updated'
  from_value      TEXT,
  to_value        TEXT,
  actor_external_id TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL,
  source          TEXT NOT NULL,              -- 'webhook' | 'reconciliation'
  UNIQUE (jira_issue_id, event_type, occurred_at, from_value, to_value)
);
CREATE INDEX idx_jira_issue_events_time ON jira_issue_events(occurred_at);

-- ---------------------------------------------------------------------------
-- Git integration
-- ---------------------------------------------------------------------------

CREATE TABLE git_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider        TEXT NOT NULL,              -- 'github' | 'gitlab' | 'bitbucket'
  encrypted_credentials BYTEA,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repositories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  git_connection_id UUID NOT NULL REFERENCES git_connections(id),
  provider_repo_id  TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  UNIQUE (git_connection_id, provider_repo_id)
);

CREATE TABLE commits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id        UUID NOT NULL REFERENCES repositories(id),
  sha                  TEXT NOT NULL,
  author_external_id   TEXT,
  message              TEXT,
  authored_at          TIMESTAMPTZ NOT NULL,
  is_merge             BOOLEAN NOT NULL DEFAULT FALSE,
  linked_jira_issue_keys TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (repository_id, sha)
);
CREATE INDEX idx_commits_authored_at ON commits(authored_at);

CREATE TABLE pull_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id     UUID NOT NULL REFERENCES repositories(id),
  provider_pr_id    TEXT NOT NULL,
  title             TEXT,
  author_external_id TEXT,
  branch_name       TEXT,
  linked_jira_issue_keys TEXT[] NOT NULL DEFAULT '{}',
  state             TEXT NOT NULL,            -- 'open' | 'merged' | 'closed'
  opened_at         TIMESTAMPTZ,
  merged_at         TIMESTAMPTZ,
  UNIQUE (repository_id, provider_pr_id)
);

CREATE TABLE pull_request_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id   UUID NOT NULL REFERENCES pull_requests(id),
  reviewer_external_id TEXT NOT NULL,
  state             TEXT NOT NULL,            -- provider review state, normalized
  submitted_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (pull_request_id, reviewer_external_id, submitted_at)
);

-- ---------------------------------------------------------------------------
-- Daily updates
-- ---------------------------------------------------------------------------

CREATE TABLE update_cycles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  cycle_date          DATE NOT NULL,
  window_start        TIMESTAMPTZ NOT NULL,
  window_end          TIMESTAMPTZ NOT NULL,
  cutoff_at           TIMESTAMPTZ NOT NULL,
  digest_publish_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, cycle_date)
);

CREATE TABLE update_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id         UUID NOT NULL REFERENCES update_cycles(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL,             -- 'draft' | 'submitted' | 'skipped'
  skip_reason      TEXT,
  completed_today  TEXT,
  in_progress      TEXT,
  blockers         TEXT,
  next_planned     TEXT,
  review_required  BOOLEAN NOT NULL DEFAULT FALSE,
  additional_notes TEXT,
  idempotency_key  TEXT NOT NULL,
  submitted_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, user_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE update_submission_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID NOT NULL REFERENCES update_submissions(id),
  jira_issue_key TEXT NOT NULL,
  selected       BOOLEAN NOT NULL DEFAULT TRUE,
  source         TEXT NOT NULL,               -- 'suggested' | 'manual'
  UNIQUE (submission_id, jira_issue_key)
);

-- ---------------------------------------------------------------------------
-- Review workflow
-- ---------------------------------------------------------------------------

CREATE TABLE review_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  requester_id      UUID NOT NULL REFERENCES users(id),
  reviewer_id       UUID NOT NULL REFERENCES users(id),
  jira_issue_key    TEXT NOT NULL,
  pull_request_id   UUID REFERENCES pull_requests(id),
  branch_name       TEXT,
  commit_sha        TEXT,
  requester_note    TEXT,
  state             TEXT NOT NULL DEFAULT 'requested', -- 'requested'|'acknowledged'|'approved'|'changes_requested'
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at      TIMESTAMPTZ,
  idempotency_key   TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------------
-- QA ticket workflow
-- ---------------------------------------------------------------------------

CREATE TABLE qa_ticket_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  requester_id     UUID NOT NULL REFERENCES users(id),
  jira_project_id  UUID NOT NULL REFERENCES jira_projects(id),
  issue_key        TEXT,                      -- NULL until Jira creation succeeds
  form_payload     JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'created'|'failed'
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Scheduling, outbox, notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notification_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  job_type         TEXT NOT NULL,             -- 'daily_reminder' | 'follow_up_reminder' | 'digest_publish'
  subject_user_id  UUID REFERENCES users(id), -- NULL for org-level jobs like digest_publish
  scheduled_for    TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'claimed'|'done'|'dead_letter'
  claimed_at       TIMESTAMPTZ,
  claimed_by       TEXT,
  attempt_count    INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  dedupe_key       TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, scheduled_for);

CREATE TABLE outbox_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type  TEXT NOT NULL,              -- 'reminder' | 'digest' | 'jira_action' | 'git_action'
  aggregate_id    TEXT,                       -- heterogeneous across aggregate types (user id, cycle id, Jira issue key, ...) — not always a UUID
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'processing'|'done'|'dead_letter'
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_events_due ON outbox_events(status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Digest, audit, integration health
-- ---------------------------------------------------------------------------

CREATE TABLE digest_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id     UUID NOT NULL REFERENCES update_cycles(id) UNIQUE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_json JSONB NOT NULL,               -- immutable rendered digest, never recomputed in place
  published_by TEXT NOT NULL DEFAULT 'scheduler' -- 'scheduler' | user_id text for manual republish
);

CREATE TABLE audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id   UUID REFERENCES users(id),  -- NULL for system-initiated actions
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  details_json    JSONB
);
-- append-only by convention: no application code issues UPDATE/DELETE against this table.

CREATE TABLE integration_failures (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  source      TEXT NOT NULL,                  -- 'jira' | 'git' | 'teams'
  error_class TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload_ref TEXT,
  resolved    BOOLEAN NOT NULL DEFAULT FALSE
);
