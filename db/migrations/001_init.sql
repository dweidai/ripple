-- Ripple v1 Postgres Schema (Runs with Gates)
-- Single-writer transactional model with epoch fencing, CAS pins, and append-only event log.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  sponsor_human TEXT,
  parent_agent_id TEXT,
  roles TEXT[] NOT NULL DEFAULT '{}',
  avatar_color TEXT,
  bio TEXT,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  status_text TEXT,
  activity_state TEXT,
  error_detail TEXT,
  online BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'P1',
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'done', 'dropped')),
  created_by TEXT NOT NULL DEFAULT 'you',
  assignee_id TEXT,
  parent_item_id TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  linked_run_id TEXT,
  result_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flow_templates (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'webhook', 'manual')),
  trigger_spec TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  sponsor_human TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]',
  gates JSONB NOT NULL DEFAULT '[]',
  retry_max INT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  flow_template_id TEXT REFERENCES flow_templates(id) ON DELETE SET NULL,
  owner_agent TEXT NOT NULL,
  sponsor_human TEXT NOT NULL,
  parent_run_id TEXT,
  parent_step_idx INT,
  title TEXT,
  goal TEXT,
  report_summary TEXT,
  report_data JSONB,
  depth INT NOT NULL DEFAULT 0,
  epoch INT NOT NULL DEFAULT 1,
  plan_version INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'planning', 'running', 'checkpoint', 'gated', 'stalled', 'overridden', 'cancelled', 'failed', 'done')),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checkpoint_step INT NOT NULL DEFAULT 0,
  touches TEXT[] NOT NULL DEFAULT '{}',
  subject_pin_kind TEXT,
  subject_pin_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- At most one non-terminal primary run per backlog item (single-writer claim mutex)
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_item
  ON runs (item_id)
  WHERE item_id IS NOT NULL AND parent_run_id IS NULL AND status NOT IN ('done', 'failed', 'cancelled', 'overridden');

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plan_version INT NOT NULL,
  idx INT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'gate')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'done', 'failed', 'skipped')),
  note TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  UNIQUE (run_id, plan_version, idx)
);

CREATE TABLE IF NOT EXISTS steers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  pin_plan_version INT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'now')),
  op TEXT NOT NULL CHECK (op IN ('edit', 'insert', 'reorder', 'annotate', 'freeform')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'acked', 'rejected')),
  ack_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_idx INT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('commit', 'pr', 'file', 'url', 'drive', 'gdoc')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  url TEXT,
  meta JSONB,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  asker TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('approve', 'choose', 'provide', 'review')),
  prompt TEXT NOT NULL,
  options TEXT[] NOT NULL DEFAULT '{}',
  diff_preview TEXT NOT NULL DEFAULT '',
  pin_kind TEXT NOT NULL,
  pin_value TEXT NOT NULL,
  assignee_kind TEXT NOT NULL CHECK (assignee_kind IN ('user', 'role', 'agent')),
  assignee_id TEXT NOT NULL,
  blocking BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'stale', 'expired', 'withdrawn')),
  answer_option TEXT,
  answer_note TEXT,
  answered_by TEXT,
  decided_on_pin TEXT,
  replaced_by TEXT,
  expires_at TIMESTAMPTZ,
  on_expire TEXT NOT NULL DEFAULT 'escalate' CHECK (on_expire IN ('hold', 'default_option', 'escalate')),
  default_option TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'run', 'step', 'card')),
  scope_id TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT 'you',
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  body TEXT NOT NULL,
  mentions TEXT[] NOT NULL DEFAULT '{}',
  reply_to_id TEXT,
  run_id TEXT,
  item_id TEXT,
  hop_count INT NOT NULL DEFAULT 0,
  steer_id TEXT REFERENCES steers(id) ON DELETE SET NULL,
  read_by JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  epoch INT,
  payload JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_ws_seq ON events (ws_id, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  response JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_accounts (
  google_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  github_id TEXT,
  github_login TEXT,
  actor_id TEXT NOT NULL,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_github_id ON user_accounts (github_id) WHERE github_id IS NOT NULL;

