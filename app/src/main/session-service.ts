import { randomUUID } from 'crypto'
import { legacyPairId } from './pair-id'
import { getDb } from './db'
import type { Session, CandidatePair, DecidedBy, MetricScore, Verdict } from '../shared/types'

// ── Sessions ──────────────────────────────────────────────────────────────────

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    label: row.label as string,
    ...(JSON.parse(row.config_json as string) as Pick<
      Session,
      | 'fields'
      | 'surfacingRule'
      | 'blockingStrategy'
      | 'blockingField'
      | 'blockingPrefixLength'
    >),
    status: row.status as Session['status'],
    reviewCursor: row.review_cursor as number,
    reviewFilter: JSON.parse(row.review_filter as string),
    reviewSort: row.review_sort as Session['reviewSort'],
    mergePasses: JSON.parse(row.merge_passes as string),
    createdAt: new Date(row.created_at as number).toISOString(),
    updatedAt: new Date(row.updated_at as number).toISOString(),
  }
}

// One SQLite file holds the sessions for every saved connection, so a caller
// that omits connectionId gets every database's sessions mixed together.
export function listSessions(connectionId?: string): Session[] {
  const db = getDb()
  const rows = (
    connectionId
      ? db
          .prepare('SELECT * FROM sessions WHERE connection_id = ? ORDER BY updated_at DESC')
          .all(connectionId)
      : db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all()
  ) as Record<string, unknown>[]
  return rows.map(rowToSession)
}

export function createSession(partial: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Session {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const { fields, surfacingRule, blockingStrategy, blockingField, blockingPrefixLength, ...rest } = partial
  db.prepare(`
    INSERT INTO sessions(id, connection_id, label, config_json, status, review_cursor, review_filter, review_sort, merge_passes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, rest.connectionId, rest.label,
    JSON.stringify({ fields, surfacingRule, blockingStrategy, blockingField, blockingPrefixLength }),
    rest.status,
    rest.reviewCursor,
    JSON.stringify(rest.reviewFilter),
    rest.reviewSort,
    JSON.stringify(rest.mergePasses),
    now, now
  )
  return loadSession(id)!
}

export function loadSession(id: string): Session | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToSession(row) : null
}

export function saveSession(session: Session): void {
  const db = getDb()
  const { fields, surfacingRule, blockingStrategy, blockingField, blockingPrefixLength } = session
  db.prepare(`
    UPDATE sessions SET
      config_json   = ?,
      status        = ?,
      review_cursor = ?,
      review_filter = ?,
      review_sort   = ?,
      merge_passes  = ?,
      updated_at    = ?
    WHERE id = ?
  `).run(
    JSON.stringify({ fields, surfacingRule, blockingStrategy, blockingField, blockingPrefixLength }),
    session.status,
    session.reviewCursor,
    JSON.stringify(session.reviewFilter),
    session.reviewSort,
    JSON.stringify(session.mergePasses),
    Date.now(),
    session.id
  )
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

// ── Pairs ─────────────────────────────────────────────────────────────────────

function rowToPair(row: Record<string, unknown>, scores: MetricScore[]): CandidatePair {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    label: JSON.parse((row.node_a_json as string))?.label ?? '',
    nodeA: JSON.parse(row.node_a_json as string),
    nodeB: JSON.parse(row.node_b_json as string),
    scores,
    verdict: row.verdict as Verdict,
    decidedAt: row.decided_at ? new Date(row.decided_at as number).toISOString() : undefined,
    note: (row.note as string | null) ?? undefined,
    decidedBy: (row.decided_by as DecidedBy | null) ?? null,
  }
}

export function listPairs(sessionId: string): CandidatePair[] {
  const db = getDb()
  const pairs = db.prepare('SELECT * FROM pairs WHERE session_id = ?').all(sessionId) as Record<string, unknown>[]
  const scoreRows = db
    .prepare('SELECT ps.* FROM pair_scores ps JOIN pairs p ON p.id = ps.pair_id WHERE p.session_id = ?')
    .all(sessionId) as Record<string, unknown>[]

  const scoresByPair = new Map<string, MetricScore[]>()
  for (const sr of scoreRows) {
    const pid = sr.pair_id as string
    if (!scoresByPair.has(pid)) scoresByPair.set(pid, [])
    scoresByPair.get(pid)!.push({
      metricId: sr.metric_id as string,
      fieldName: sr.field_name as string,
      score: sr.score as number,
      aboveThreshold: (sr.above_threshold as number) === 1,
    })
  }

  return pairs.map((row) => rowToPair(row, scoresByPair.get(row.id as string) ?? []))
}

export function getPair(pairId: string): CandidatePair | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(pairId) as Record<string, unknown> | undefined
  if (!row) return null
  const scores = db.prepare('SELECT * FROM pair_scores WHERE pair_id = ?').all(pairId) as Record<string, unknown>[]
  return rowToPair(row, scores.map((sr) => ({
    metricId: sr.metric_id as string,
    fieldName: sr.field_name as string,
    score: sr.score as number,
    aboveThreshold: (sr.above_threshold as number) === 1,
  })))
}

export function upsertPairs(pairs: CandidatePair[]): void {
  const db = getDb()
  const insertPair = db.prepare(`
    INSERT INTO pairs(id, session_id, node_a_json, node_b_json, verdict, decided_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      node_a_json = excluded.node_a_json,
      node_b_json = excluded.node_b_json
      -- verdict, decided_at, note intentionally NOT overwritten
  `)
  const upsertScore = db.prepare(`
    INSERT OR REPLACE INTO pair_scores(pair_id, metric_id, field_name, score, above_threshold)
    VALUES (?, ?, ?, ?, ?)
  `)
  // Rows written before pair ids were session-scoped carry the unscoped id.
  // Recompute would otherwise miss them and insert a second copy of every pair,
  // leaving the queue holding both — the old row with its verdict and a new
  // pending one. Match only within this session, so a row another session owns
  // is left alone and this session gets its own copy, which is the point of the
  // scoped id. Remove once no pre-scoping session is still in use.
  const findLegacy = db.prepare(`SELECT id FROM pairs WHERE id = ? AND session_id = ?`)

  const tx = db.transaction(() => {
    for (const pair of pairs) {
      const legacy = legacyPairId(pair.nodeA.id, pair.nodeB.id)
      const id = findLegacy.get(legacy, pair.sessionId) ? legacy : pair.id

      insertPair.run(
        id, pair.sessionId,
        JSON.stringify(pair.nodeA), JSON.stringify(pair.nodeB),
        pair.verdict,
        pair.decidedAt ? new Date(pair.decidedAt).getTime() : null,
        pair.note ?? null
      )
      for (const score of pair.scores) {
        upsertScore.run(id, score.metricId, score.fieldName, score.score, score.aboveThreshold ? 1 : 0)
      }
    }
  })
  tx()
}

// decidedBy is required rather than defaulted: every caller should have to say
// whether a human or the classifier produced the verdict.
export function setVerdict(pairId: string, verdict: Verdict, decidedBy: DecidedBy): void {
  getDb()
    .prepare('UPDATE pairs SET verdict = ?, decided_at = ?, decided_by = ? WHERE id = ?')
    .run(
      verdict,
      verdict !== 'pending' ? Date.now() : null,
      verdict !== 'pending' ? decidedBy : null,
      pairId
    )
}

export function setNote(pairId: string, note: string): void {
  getDb().prepare('UPDATE pairs SET note = ? WHERE id = ?').run(note, pairId)
}
