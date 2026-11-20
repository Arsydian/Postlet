-- ============================================================================
-- Postlet Initial D1 Schema (v0.1.0)
-- Optimized for Cloudflare D1 Free Tier with targeted composite indexes and
-- FTS5 full-text search maintained via SQLite triggers.
-- ============================================================================

-- 1. Key-value operational settings (domain, catch-all, Workers AI agent toggles)
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed safe operational defaults.
-- IMPORTANT: Built-in Cloudflare Workers AI is wired as the default agent but
-- DISABLED by default (`ai_enabled = 'false'`) until toggled on in Settings.
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('mail_domain', '', '2026-01-01T00:00:00.000Z'),
  ('catch_all_enabled', 'true', '2026-01-01T00:00:00.000Z'),
  ('ai_enabled', 'false', '2026-01-01T00:00:00.000Z'),
  ('ai_model', '@cf/meta/llama-3.2-3b-instruct', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_cap', '50', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_count', '0', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_date', '', '2026-01-01T00:00:00.000Z'),
  ('ai_auto_triage_enabled', 'false', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_summary_enabled', 'false', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_summary_hour', '8', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_summary_timezone', 'UTC', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_summary_email_copy', 'false', '2026-01-01T00:00:00.000Z'),
  ('ai_daily_summary_last_run_date', '', '2026-01-01T00:00:00.000Z'),
  ('ai_important_auto_reply_enabled', 'false', '2026-01-01T00:00:00.000Z'),
  ('ai_important_auto_reply_mode', 'approval', '2026-01-01T00:00:00.000Z'),
  ('ai_important_auto_reply_instructions', 'Acknowledge receipt politely, confirm their message was received, and let them know I will follow up personally soon.', '2026-01-01T00:00:00.000Z'),
  ('ai_important_auto_reply_cooldown_hours', '24', '2026-01-01T00:00:00.000Z');

-- 2. Configured owner addresses / aliases for sending and filtering
CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Conversation threads grouping inbound and outbound messages
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  participants_json TEXT NOT NULL DEFAULT '[]',
  recipient_address TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'inbox',
  last_message_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT,
  ai_category TEXT,
  ai_priority TEXT,
  ai_updated_at TEXT,
  auto_replied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Individual email messages (inbound, outbound, drafts, pending approval)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  resend_email_id TEXT UNIQUE,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL CHECK(status IN (
    'received',
    'draft',
    'pending_approval',
    'sent',
    'delivered',
    'delayed',
    'bounced',
    'complained',
    'failed',
    'rejected'
  )),
  from_address TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  to_addresses_json TEXT NOT NULL,
  cc_addresses_json TEXT NOT NULL DEFAULT '[]',
  bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '{}',
  is_read INTEGER NOT NULL DEFAULT 0,
  folder TEXT NOT NULL DEFAULT 'inbox',
  created_by_agent_key_id TEXT,
  created_by_actor TEXT NOT NULL DEFAULT 'owner',
  delivery_error TEXT,
  delivery_events_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 5. Attachment metadata backed by binary objects in Cloudflare R2
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  resend_attachment_id TEXT,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_disposition TEXT NOT NULL DEFAULT 'attachment',
  content_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 6. Scoped AI agent API keys (stored strictly as SHA-256 hashes)
CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK(scope IN ('read_only', 'read_draft', 'read_write')),
  allowed_address_id TEXT REFERENCES addresses(id) ON DELETE SET NULL,
  allowed_recipient_domains_json TEXT,
  allowed_functions_json TEXT NOT NULL DEFAULT '["daily_summary","important_auto_reply","triage"]',
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 60,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

-- 7. Unified audit trail for external AI agents, built-in Postlet AI, and owner approvals
CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('agent_key', 'postlet_ai', 'owner')),
  agent_key_id TEXT,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('allowed', 'denied', 'error')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- 8. Persisted Daily Inbox Summaries (overview, To-Dos, reminders, FYI rollup)
CREATE TABLE IF NOT EXISTS ai_digests (
  id TEXT PRIMARY KEY,
  digest_date TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  overview TEXT NOT NULL,
  todos_json TEXT NOT NULL DEFAULT '[]',
  reminders_json TEXT NOT NULL DEFAULT '[]',
  fyi_json TEXT NOT NULL DEFAULT '[]',
  source_thread_count INTEGER NOT NULL DEFAULT 0,
  emailed_to TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'cron',
  created_at TEXT NOT NULL
);

-- 9. FTS5 Full-Text Search index over messages and sync triggers
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  thread_id UNINDEXED,
  subject,
  from_address,
  to_addresses,
  text_body
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, thread_id, subject, from_address, to_addresses, text_body)
  VALUES (new.id, new.thread_id, new.subject, new.from_address, new.to_addresses_json, new.text_body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, thread_id, subject, from_address, to_addresses, text_body)
  VALUES (new.id, new.thread_id, new.subject, new.from_address, new.to_addresses_json, new.text_body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

-- 10. Composite indexes for low-row-read Free-Tier queries
CREATE INDEX IF NOT EXISTS idx_threads_folder_last ON threads(folder, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_recipient ON threads(recipient_address, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_rfc_id ON messages(rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON agent_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_key_created ON agent_audit_logs(agent_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_digests_date ON ai_digests(digest_date DESC, created_at DESC);
