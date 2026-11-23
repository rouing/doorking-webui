-- DoorKing Gate Manager: PostgreSQL schema (tables and indexes).
--
-- The single source of the schema: the server applies this file every time it opens the database (src/db.ts
-- openStore), and `node cli.ts db-setup` uses it to set up a new database. Every statement is idempotent
-- (IF NOT EXISTS), so running it again on an existing database only adds what is missing and never removes data.
--
-- By hand, as the app's login, on a database it owns:
--   psql -h 127.0.0.1 -U doorking -d doorking -v ON_ERROR_STOP=1 -f sql/schema.sql
--
-- No rows are seeded: accounts (hashed passwords), gates (encrypted master codes, filled by a DKS pull) and the
-- encryption key are created by the app and the CLI. Table and column meanings: docs/DB.md.
-- Changing the schema: add tables/columns here with IF NOT EXISTS; for a new column on an existing table put it in
-- the CREATE TABLE (new databases) and add an ALTER TABLE ... ADD COLUMN IF NOT EXISTS at the end (older ones).

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- gates, credentials: from before local accounts (2026-11-13); read once by the migration to managed gates and
-- kept so older databases upgrade cleanly. (Older databases also have an unused sign_ins table, never dropped.)
CREATE TABLE IF NOT EXISTS gates (username TEXT NOT NULL, phone TEXT NOT NULL, master_code TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL, verified_at TIMESTAMPTZ, PRIMARY KEY (username, phone));
CREATE INDEX IF NOT EXISTS gates_phone ON gates (phone);
CREATE TABLE IF NOT EXISTS prefs (phone TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS history (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS history_phone ON history (phone, seq);
CREATE TABLE IF NOT EXISTS credentials (username TEXT PRIMARY KEY, login TEXT NOT NULL, password TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, phone TEXT NOT NULL, username TEXT NOT NULL,
  data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, last_due TIMESTAMPTZ, last_run TIMESTAMPTZ, last_result TEXT,
  last_error TEXT);
CREATE INDEX IF NOT EXISTS schedules_phone ON schedules (phone);
CREATE TABLE IF NOT EXISTS cameras (phone TEXT PRIMARY KEY, data JSONB NOT NULL, password TEXT NOT NULL,
  saved_by TEXT NOT NULL, saved_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (phone TEXT NOT NULL, minute TEXT NOT NULL, status TEXT NOT NULL,
  files JSONB NOT NULL, error TEXT, attempts INTEGER NOT NULL, at TIMESTAMPTZ NOT NULL, shifts JSONB,
  video_attempts INTEGER NOT NULL DEFAULT 0, short JSONB, PRIMARY KEY (phone, minute));
CREATE TABLE IF NOT EXISTS notes (phone TEXT NOT NULL, code TEXT NOT NULL, note TEXT NOT NULL,
  saved_by TEXT NOT NULL, saved_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, code));
CREATE TABLE IF NOT EXISTS tx_history (phone TEXT NOT NULL, seq INTEGER NOT NULL, raw TEXT NOT NULL,
  year INTEGER NOT NULL, added_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, seq));
CREATE TABLE IF NOT EXISTS tx_pulls (phone TEXT PRIMARY KEY, pulled_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS gate_files (phone TEXT NOT NULL, copy TEXT NOT NULL CHECK (copy IN ('pulled', 'base', 'working')),
  name TEXT NOT NULL, data BYTEA NOT NULL, saved_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, copy, name));
CREATE TABLE IF NOT EXISTS gate_residents (phone TEXT NOT NULL, seq INTEGER NOT NULL, directory_code TEXT NOT NULL,
  type TEXT NOT NULL, name TEXT NOT NULL, hidden BOOLEAN NOT NULL, area_code TEXT NOT NULL, phone_number TEXT NOT NULL,
  entry_code TEXT NOT NULL, security_level INTEGER, floor INTEGER, elevator_ref INTEGER, entry_offset INTEGER,
  record_offset INTEGER, PRIMARY KEY (phone, seq));
CREATE TABLE IF NOT EXISTS gate_cards (phone TEXT NOT NULL, slot INTEGER NOT NULL, card_number TEXT NOT NULL,
  directory_code TEXT, raw_code TEXT, PRIMARY KEY (phone, slot));
CREATE TABLE IF NOT EXISTS gate_settings (phone TEXT NOT NULL, key TEXT NOT NULL, grp TEXT NOT NULL, name TEXT NOT NULL,
  value TEXT NOT NULL, PRIMARY KEY (phone, key));
CREATE TABLE IF NOT EXISTS gate_state (phone TEXT PRIMARY KEY, pulled_at TIMESTAMPTZ NOT NULL, checked_at TIMESTAMPTZ NOT NULL,
  round_trip_ok BOOLEAN NOT NULL, problems JSONB NOT NULL, rebuild_ok BOOLEAN, rebuild_problems JSONB);
CREATE TABLE IF NOT EXISTS gate_working (phone TEXT PRIMARY KEY, dir_digits INTEGER NOT NULL, area_code_mode INTEGER NOT NULL,
  area_codes JSONB NOT NULL, middle_pointer TEXT NOT NULL, base_ok BOOLEAN NOT NULL, saved_at TIMESTAMPTZ NOT NULL, extra JSONB,
  sizes JSONB, conflicts JSONB NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, email TEXT UNIQUE,
  dark BOOLEAN NOT NULL, must_change BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by TEXT NOT NULL,
  last_sign_in TIMESTAMPTZ, sign_ins INTEGER NOT NULL, webauthn_id TEXT, pending_email TEXT, phone TEXT,
  notify_access BOOLEAN NOT NULL DEFAULT true, notify_alerts BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL, gate TEXT, strong_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS sessions_username ON sessions (username);
CREATE TABLE IF NOT EXISTS managed_gates (phone TEXT PRIMARY KEY, master_code TEXT NOT NULL, dks_user TEXT NOT NULL,
  dks_password TEXT NOT NULL, added_by TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS gate_access (phone TEXT NOT NULL REFERENCES managed_gates ON DELETE CASCADE,
  username TEXT NOT NULL REFERENCES users ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'readonly', 'resident')),
  granted_by TEXT NOT NULL, granted_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, username));
CREATE INDEX IF NOT EXISTS gate_access_username ON gate_access (username);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, phone TEXT NOT NULL REFERENCES managed_gates ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'readonly')), secret_hash TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS api_keys_phone ON api_keys (phone);
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  rp_id TEXT NOT NULL, public_key BYTEA NOT NULL, counter BIGINT NOT NULL, transports JSONB, name TEXT NOT NULL,
  device_type TEXT NOT NULL, backed_up BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS passkeys_username ON passkeys (username);
-- Single sign-on: a provider identity (config.json sso.providers id + the provider's permanent subject) linked to an account.
CREATE TABLE IF NOT EXISTS user_identities (provider TEXT NOT NULL, subject TEXT NOT NULL,
  username TEXT NOT NULL REFERENCES users ON DELETE CASCADE, email TEXT NOT NULL, linked_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ, last_claims JSONB, PRIMARY KEY (provider, subject));
CREATE INDEX IF NOT EXISTS user_identities_username ON user_identities (username);
CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS push_subscriptions_username ON push_subscriptions (username);
CREATE TABLE IF NOT EXISTS resident_portal (phone TEXT NOT NULL, code TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE, username TEXT REFERENCES users ON DELETE SET NULL, updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, code));
CREATE INDEX IF NOT EXISTS resident_portal_username ON resident_portal (username);
CREATE INDEX IF NOT EXISTS resident_portal_email ON resident_portal (email);
CREATE TABLE IF NOT EXISTS portal_events (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, directory_code TEXT NOT NULL,
  username TEXT NOT NULL, relay INTEGER NOT NULL, event_type TEXT NOT NULL DEFAULT 'Portal Open',
  access TEXT NOT NULL DEFAULT 'Admit', ts TIMESTAMPTZ NOT NULL, result TEXT NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS portal_events_phone_ts ON portal_events (phone, ts DESC);
CREATE INDEX IF NOT EXISTS portal_events_unit_ts ON portal_events (phone, directory_code, ts DESC);
CREATE TABLE IF NOT EXISTS resident_code_rerolls (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, directory_code TEXT NOT NULL,
  username TEXT NOT NULL, old_code TEXT NOT NULL, new_code TEXT NOT NULL, synced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS resident_code_rerolls_unit ON resident_code_rerolls (phone, directory_code, created_at DESC);
CREATE TABLE IF NOT EXISTS resident_requests (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, directory_code TEXT NOT NULL,
  username TEXT NOT NULL REFERENCES users ON DELETE CASCADE, kind TEXT NOT NULL, payload JSONB NOT NULL,
  note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL,
  reviewed_by TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT);
CREATE INDEX IF NOT EXISTS resident_requests_phone ON resident_requests (phone, status, created_at DESC);
CREATE TABLE IF NOT EXISTS suspicious_reports (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, directory_code TEXT NOT NULL,
  username TEXT NOT NULL, tx_source TEXT NOT NULL, tx_key TEXT NOT NULL, tx_ts TIMESTAMPTZ NOT NULL,
  tx_summary TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL, reviewed_by TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT,
  UNIQUE (phone, directory_code, tx_source, tx_key));
CREATE INDEX IF NOT EXISTS suspicious_reports_phone ON suspicious_reports (phone, status, created_at DESC);
CREATE TABLE IF NOT EXISTS login_audit (id BIGSERIAL PRIMARY KEY, username TEXT, identifier TEXT NOT NULL, role TEXT,
  method TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, ip TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS login_audit_created ON login_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS login_audit_username ON login_audit (username, created_at DESC);
CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset', 'invite')),
  username TEXT NOT NULL REFERENCES users ON DELETE CASCADE, data TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS email_tokens_username ON email_tokens (username, kind);
CREATE TABLE IF NOT EXISTS emails (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL,
  kind TEXT NOT NULL, body TEXT, status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')), attempts INTEGER NOT NULL,
  next_try TIMESTAMPTZ NOT NULL, error TEXT, created_at TIMESTAMPTZ NOT NULL, sent_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS emails_due ON emails (status, next_try);
CREATE TABLE IF NOT EXISTS relay_timers (phone TEXT NOT NULL, relay INTEGER NOT NULL, release_at TIMESTAMPTZ NOT NULL,
  set_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (phone, relay));
CREATE INDEX IF NOT EXISTS relay_timers_due ON relay_timers (release_at);
CREATE TABLE IF NOT EXISTS gate_pull_archive (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone TEXT NOT NULL, pulled_at TIMESTAMPTZ NOT NULL, actor TEXT NOT NULL, hash TEXT NOT NULL,
  residents_count INTEGER NOT NULL, cards_count INTEGER NOT NULL,
  names_bin BYTEA NOT NULL, phone_bin BYTEA NOT NULL, cards_bin BYTEA NOT NULL);
CREATE INDEX IF NOT EXISTS gate_pull_archive_phone ON gate_pull_archive (phone, id DESC);
CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, phone TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
  secret TEXT NOT NULL, events JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS webhooks_phone ON webhooks (phone);
CREATE TABLE IF NOT EXISTS webhook_deliveries (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks ON DELETE CASCADE, phone TEXT NOT NULL, event TEXT NOT NULL,
  payload TEXT, status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')), attempts INTEGER NOT NULL,
  next_try TIMESTAMPTZ NOT NULL, last_status INTEGER, last_error TEXT, created_at TIMESTAMPTZ NOT NULL, sent_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_try);

-- Upgrades of databases made before these columns existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS webauthn_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_access BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_alerts BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ;
ALTER TABLE gate_cards ADD COLUMN IF NOT EXISTS raw_code TEXT;
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS area_codes JSONB NOT NULL DEFAULT '[]';
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS middle_pointer TEXT NOT NULL DEFAULT 'ffffff';
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS extra JSONB;
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS sizes JSONB;
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS conflicts JSONB NOT NULL DEFAULT '[]';
ALTER TABLE gate_state ADD COLUMN IF NOT EXISTS rebuild_ok BOOLEAN;
ALTER TABLE gate_state ADD COLUMN IF NOT EXISTS rebuild_problems JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS strong_at TIMESTAMPTZ;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS last_claims JSONB;
DO $$ BEGIN
  ALTER TABLE gate_access DROP CONSTRAINT IF EXISTS gate_access_role_check;
  ALTER TABLE gate_access ADD CONSTRAINT gate_access_role_check CHECK (role IN ('admin', 'editor', 'readonly', 'resident'));
  ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_role_check;
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_role_check CHECK (role IN ('admin', 'editor', 'readonly'));
END $$;
