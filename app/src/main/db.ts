import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db
  const dbPath = join(app.getPath('userData'), 'er-sessions.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      connection_id   TEXT NOT NULL,
      label           TEXT NOT NULL,
      config_json     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'configuring',
      review_cursor   INTEGER NOT NULL DEFAULT 0,
      review_filter   TEXT NOT NULL DEFAULT '{"verdict":"all"}',
      review_sort     TEXT NOT NULL DEFAULT 'score-desc',
      merge_passes    TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairs (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      node_a_json     TEXT NOT NULL,
      node_b_json     TEXT NOT NULL,
      verdict         TEXT NOT NULL DEFAULT 'pending',
      decided_at      INTEGER,
      note            TEXT
    );

    CREATE TABLE IF NOT EXISTS pair_scores (
      pair_id         TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      metric_id       TEXT NOT NULL,
      field_name      TEXT NOT NULL,
      score           REAL NOT NULL,
      above_threshold INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pair_id, metric_id, field_name)
    );

    CREATE TABLE IF NOT EXISTS audit_records (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      merge_pass_id     TEXT NOT NULL,
      timestamp         INTEGER NOT NULL,
      label             TEXT NOT NULL,
      survivor_id       TEXT NOT NULL,
      survivor_props    TEXT NOT NULL,
      absorbed_ids      TEXT NOT NULL,
      absorbed_props    TEXT NOT NULL,
      scores_json       TEXT NOT NULL,
      conflict_strategy TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- No FK on session_id: usage rows are the lifetime cost ledger and must
    -- outlive the sessions that produced them.
    CREATE TABLE IF NOT EXISTS llm_jobs (
      id                       TEXT PRIMARY KEY,
      session_id               TEXT,
      kind                     TEXT NOT NULL,
      model                    TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'running',
      started_at               INTEGER NOT NULL,
      ended_at                 INTEGER,
      unit_count               INTEGER NOT NULL DEFAULT 0,
      units_completed          INTEGER NOT NULL DEFAULT 0,
      call_count               INTEGER NOT NULL DEFAULT 0,
      input_tokens             INTEGER NOT NULL DEFAULT 0,
      output_tokens            INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,
      cost_usd                 REAL    NOT NULL DEFAULT 0,
      features_json            TEXT    NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id                       TEXT PRIMARY KEY,
      job_id                   TEXT,
      session_id               TEXT,
      kind                     TEXT NOT NULL,
      model                    TEXT NOT NULL,
      started_at               INTEGER NOT NULL,
      duration_ms              INTEGER NOT NULL DEFAULT 0,
      input_tokens             INTEGER NOT NULL DEFAULT 0,
      output_tokens            INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,
      cost_usd                 REAL    NOT NULL DEFAULT 0,
      priced                   INTEGER NOT NULL DEFAULT 1,
      pricing_version          TEXT    NOT NULL,
      ok                       INTEGER NOT NULL DEFAULT 1,
      error                    TEXT,
      stop_reason              TEXT,
      features_json            TEXT    NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_pairs_session  ON pairs(session_id);
    CREATE INDEX IF NOT EXISTS idx_calls_session  ON llm_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_calls_job      ON llm_calls(job_id);
    CREATE INDEX IF NOT EXISTS idx_calls_kind     ON llm_calls(kind, model, started_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_kind      ON llm_jobs(kind, model, status, started_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_session   ON llm_jobs(session_id);
    CREATE INDEX IF NOT EXISTS idx_pairs_verdict  ON pairs(session_id, verdict);
    CREATE INDEX IF NOT EXISTS idx_scores_pair    ON pair_scores(pair_id);
    CREATE INDEX IF NOT EXISTS idx_audit_session  ON audit_records(session_id);
  `)

  addColumn(db, 'llm_jobs', 'variant', `TEXT NOT NULL DEFAULT ''`)

  // Who decided each pair. Nullable: a pending pair has no decider.
  if (addColumn(db, 'pairs', 'decided_by', 'TEXT')) {
    // Existing rows predate the column. Before it, the only signal was the
    // '[AI] ' prefix auto-classify writes onto its notes, so recover what we
    // can from that rather than mislabelling every historical verdict.
    db.exec(`
      UPDATE pairs SET decided_by = CASE
        WHEN verdict = 'pending' THEN NULL
        WHEN note LIKE '[AI]%'   THEN 'ai'
        ELSE 'human'
      END
    `)
  }

  addColumn(db, 'audit_records', 'decided_by_json', `TEXT NOT NULL DEFAULT '{}'`)

  // How much of the label had been captured when the merge was applied. A merge
  // from a partial capture is individually correct, but the record should not
  // read as "this label was deduplicated" when only part of it was compared.
  addColumn(db, 'audit_records', 'capture_json', 'TEXT')

  // The OpenAI semantic-cosine backend is gone, so nothing reads this setting.
  // It was stored in plaintext, unlike Neo4j passwords, so drop the row rather
  // than leaving a live key sitting in the database no code will ever use.
  db.prepare(`DELETE FROM settings WHERE key = 'openaiApiKey'`).run()
}

// CREATE TABLE IF NOT EXISTS won't add a column to a table that already exists,
// so schema additions made after a table has shipped go through here.
// Returns true when the column was added, so callers can run a one-time
// backfill without repeating it on every launch.
function addColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}
