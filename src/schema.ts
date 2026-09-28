import type { SqlDatabase } from "./database.js";

export const SCHEMA_VERSION = 5;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS teleport_schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teleport_sessions (
    session_id TEXT PRIMARY KEY,
    header JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    next_seq BIGINT NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
    writer_epoch BIGINT NOT NULL DEFAULT 1 CHECK (writer_epoch >= 1),
    writer_device_id TEXT,
    writer_token_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE teleport_sessions ADD COLUMN IF NOT EXISTS inherited_event_count BIGINT
    CHECK (inherited_event_count >= 0)`,
  `CREATE TABLE IF NOT EXISTS teleport_events (
    session_id TEXT NOT NULL REFERENCES teleport_sessions(session_id) ON DELETE CASCADE,
    seq BIGINT NOT NULL CHECK (seq >= 0),
    event JSON NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS teleport_mutations (
    session_id TEXT NOT NULL REFERENCES teleport_sessions(session_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    start_seq BIGINT NOT NULL,
    end_seq BIGINT NOT NULL,
    committed_revision BIGINT NOT NULL,
    committed_next_seq BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS teleport_handoffs (
    code_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES teleport_sessions(session_id) ON DELETE CASCADE,
    from_epoch BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS teleport_handoffs_session_idx
    ON teleport_handoffs(session_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS teleport_writer_audit (
    session_id TEXT NOT NULL REFERENCES teleport_sessions(session_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('handoff', 'admin_recovery')),
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    from_device_id TEXT,
    to_device_id TEXT NOT NULL,
    from_epoch BIGINT NOT NULL CHECK (from_epoch >= 1),
    to_epoch BIGINT NOT NULL CHECK (to_epoch > from_epoch),
    committed_revision BIGINT NOT NULL CHECK (committed_revision >= 0),
    committed_next_seq BIGINT NOT NULL CHECK (committed_next_seq >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS teleport_writer_audit_session_idx
    ON teleport_writer_audit(session_id, created_at DESC, idempotency_key DESC)`,
  `CREATE TABLE IF NOT EXISTS teleport_import_rollback_audit (
    session_id TEXT NOT NULL,
    import_idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    rolled_back_revision BIGINT NOT NULL CHECK (rolled_back_revision >= 1),
    rolled_back_next_seq BIGINT NOT NULL CHECK (rolled_back_next_seq >= 0),
    rolled_back_writer_epoch BIGINT NOT NULL CHECK (rolled_back_writer_epoch >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, import_idempotency_key)
  )`,
];

export async function initializeSchema(database: SqlDatabase): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const statement of STATEMENTS) await transaction.query(statement);
    const stored = await transaction.query<{ value: string }>(
      `SELECT value FROM teleport_schema_meta WHERE key = 'schema_version'`,
    );
    const version = stored.rows[0]?.value;
    if (version === undefined) {
      await transaction.query(
        `INSERT INTO teleport_schema_meta (key, value) VALUES ('schema_version', $1)`,
        [String(SCHEMA_VERSION)],
      );
      return;
    }
    if ([1, 2, 3, 4].includes(Number(version))) {
      await transaction.query(`ALTER TABLE teleport_import_rollback_audit
        DROP CONSTRAINT IF EXISTS teleport_import_rollback_audit_rolled_back_next_seq_check`);
      await transaction.query(`ALTER TABLE teleport_import_rollback_audit
        ADD CONSTRAINT teleport_import_rollback_audit_rolled_back_next_seq_check
        CHECK (rolled_back_next_seq >= 0)`);
    }
    if (Number(version) === 1) {
      // v1 used JSONB, which reorders object keys. JSON preserves the DSH event
      // envelope's insertion order for byte-stable HMR prefix comparison. Rows
      // already normalized by JSONB cannot be reconstructed losslessly.
      const count = await transaction.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM teleport_events`,
      );
      if (Number(count.rows[0]?.count ?? 0) > 0) {
        throw new Error(
          "teleport schema v1 contains JSONB events and cannot be migrated losslessly; export or recreate this pre-adapter store",
        );
      }
      await transaction.query(
        `ALTER TABLE teleport_events ALTER COLUMN event TYPE JSON USING event::json`,
      );
      await transaction.query(
        `UPDATE teleport_schema_meta SET value = $1 WHERE key = 'schema_version'`,
        [String(SCHEMA_VERSION)],
      );
      return;
    }
    if (Number(version) === 2) {
      await transaction.query(
        `UPDATE teleport_schema_meta SET value = $1 WHERE key = 'schema_version'`,
        [String(SCHEMA_VERSION)],
      );
      return;
    }
    if (Number(version) === 3 || Number(version) === 4) {
      await transaction.query(
        `UPDATE teleport_schema_meta SET value = $1 WHERE key = 'schema_version'`,
        [String(SCHEMA_VERSION)],
      );
      return;
    }
    if (Number(version) !== SCHEMA_VERSION) {
      throw new Error(
        `teleport database schema version ${version} is incompatible with this build (${SCHEMA_VERSION})`,
      );
    }
  });
}
