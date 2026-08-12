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

// SQLite never returns freed pages to the filesystem on its own — a deleted
// session's rows become reusable space inside the file, and the file stays the
// size it grew to. Storing candidates that did not surface makes that gap wider,
// because a capture writes far more rows than reach the queue.
//
// Only worth the rewrite when there is something real to reclaim: VACUUM copies
// every live page, so running it after every delete would rewrite the database
// to recover a few kilobytes.
const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024

/**
 * Return unused space to the filesystem, if there is enough of it to be worth
 * rewriting the database for. Returns the bytes reclaimed, or 0 if it declined.
 *
 * VACUUM cannot run inside a transaction, and needs another connection to be
 * idle — a second one holding the write lock makes it fail rather than corrupt
 * anything, so the caller treats failure as "not now" and moves on.
 */
export function reclaimUnusedSpace(): number {
  const db = getDb()
  const pragma = (name: string): number =>
    Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]

  const pageSize = pragma('page_size')
  const freeBytes = pragma('freelist_count') * pageSize
  if (freeBytes < VACUUM_MIN_FREE_BYTES) return 0

  const before = pragma('page_count') * pageSize
  const started = Date.now()
  try {
    db.exec('VACUUM')
  } catch (err) {
    console.log(`[db] vacuum skipped: ${(err as Error).message}`)
    return 0
  }
  // VACUUM alone returns nothing to the filesystem in WAL mode: it rebuilds the
  // database through the write-ahead log, and the main file keeps its old size
  // until a checkpoint truncates it. Measured on a 171.1 MB database emptied to
  // 0.7 MB of live rows: after VACUUM the file was still 171.1 MB, and only the
  // checkpoint brought it to 0.7 MB.
  db.pragma('wal_checkpoint(TRUNCATE)')

  const after = pragma('page_count') * pageSize
  console.log(
    `[db] vacuum reclaimed ${((before - after) / 1e6).toFixed(1)} MB ` +
      `(${(before / 1e6).toFixed(1)} -> ${(after / 1e6).toFixed(1)} MB) in ${Date.now() - started}ms`
  )
  return before - after
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

  // Candidates that were scored but did not pass the surfacing rule are kept
  // with surfaced = 0, so a threshold change re-filters what is already stored
  // instead of forcing a rescan — and a threshold can be *lowered* to see what
  // appears. Their node snapshots are not stored: on Company those average 580
  // bytes each, which is 116 MB per 100k-candidate pass against 12 MB for ids
  // and scores alone. A pair that later surfaces is hydrated from the graph.
  addColumn(db, 'pairs', 'surfaced', 'INTEGER NOT NULL DEFAULT 1')
  db.exec('CREATE INDEX IF NOT EXISTS idx_pairs_surfaced ON pairs(session_id, surfaced)')

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
