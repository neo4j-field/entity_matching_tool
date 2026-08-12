import type { Driver } from 'neo4j-driver'
import { getDriver } from './connection-service'
import { getSettings } from './settings-service'
import type { CandidatePair, AuditRecord } from '../shared/types'

function isEnabled(): boolean {
  try {
    return getSettings().useNeo4jStorage
  } catch {
    return false
  }
}

// Scores are a sub-option of the write-back as a whole: recording a score for a
// pair that was never written would leave orphans.
function scoresEnabled(): boolean {
  try {
    const s = getSettings()
    return s.useNeo4jStorage && s.useNeo4jPairScores
  } catch {
    return false
  }
}

// MERGE without an index degrades to a full label scan of every ERPair or
// ERPairScore already written, which on a large session means each write gets
// slower than the last. Created once per driver instance, so a reconnect
// re-checks.
let indexedDriver: Driver | null = null

async function ensureIndexes(driver: Driver): Promise<void> {
  if (indexedDriver === driver) return
  const session = driver.session()
  try {
    await session.run('CREATE INDEX er_pair_id IF NOT EXISTS FOR (p:ERPair) ON (p.pairId)')
    await session.run(
      `CREATE INDEX er_pair_score_key IF NOT EXISTS
       FOR (s:ERPairScore) ON (s.pairId, s.fieldName, s.metricId)`
    )
    await session.run(
      'CREATE INDEX er_audit_id IF NOT EXISTS FOR (r:ERAuditRecord) ON (r.id)'
    )
    indexedDriver = driver
  } finally {
    await session.close()
  }
}

interface PairRow {
  pairId: string
  verdict: string
  decidedBy: string | null
  decidedAt: string | null
  sessionId: string
  note: string | null
  nodeAId: string
  nodeBId: string
}

interface ScoreRow {
  pairId: string
  fieldName: string
  metricId: string
  score: number
  aboveThreshold: boolean
}

function toPairRow(pair: CandidatePair): PairRow {
  return {
    pairId: pair.id,
    verdict: pair.verdict,
    decidedBy: pair.decidedBy ?? null,
    decidedAt: pair.decidedAt ?? null,
    sessionId: pair.sessionId,
    note: pair.note ?? null,
    nodeAId: pair.nodeA.id,
    nodeBId: pair.nodeB.id,
  }
}

function toScoreRows(pair: CandidatePair): ScoreRow[] {
  return pair.scores.map((s) => ({
    pairId: pair.id,
    fieldName: s.fieldName,
    metricId: s.metricId,
    score: s.score,
    aboveThreshold: s.aboveThreshold,
  }))
}

export async function writePairVerdict(pair: CandidatePair): Promise<void> {
  return writePairVerdicts([pair])
}

// Batched so a classify run writes once per batch rather than opening a session
// per pair, which would exhaust the driver's connection pool under concurrency.
export async function writePairVerdicts(pairs: CandidatePair[]): Promise<void> {
  if (!isEnabled() || pairs.length === 0) return
  const driver = getDriver()
  await ensureIndexes(driver)

  const session = driver.session()
  try {
    // A row whose node no longer exists (merged away since the verdict) is
    // dropped by the MATCH; the remaining rows are unaffected.
    await session.run(
      `UNWIND $rows AS row
       MERGE (p:ERPair {pairId: row.pairId})
       SET p.verdict = row.verdict,
           p.decidedBy = row.decidedBy,
           p.decidedAt = row.decidedAt,
           p.sessionId = row.sessionId,
           p.note = row.note
       WITH p, row
       MATCH (a) WHERE elementId(a) = row.nodeAId
       MATCH (b) WHERE elementId(b) = row.nodeBId
       MERGE (p)-[:INVOLVES {role: 'nodeA'}]->(a)
       MERGE (p)-[:INVOLVES {role: 'nodeB'}]->(b)`,
      { rows: pairs.map(toPairRow) }
    )

    if (scoresEnabled()) {
      const scoreRows = pairs.flatMap(toScoreRows)
      if (scoreRows.length > 0) {
        // Keyed on (pairId, fieldName, metricId) — the same grain as the SQLite
        // pair_scores table — so a recompute updates in place instead of
        // accumulating duplicates.
        await session.run(
          `UNWIND $rows AS row
           MERGE (s:ERPairScore {
             pairId: row.pairId, fieldName: row.fieldName, metricId: row.metricId
           })
           SET s.score = row.score, s.aboveThreshold = row.aboveThreshold
           WITH s, row
           MATCH (p:ERPair {pairId: row.pairId})
           MERGE (p)-[:SCORED]->(s)`,
          { rows: scoreRows }
        )
      }
    }
  } finally {
    await session.close()
  }
}

export async function writeAuditRecord(record: AuditRecord): Promise<void> {
  if (!isEnabled()) return
  const driver = getDriver()
  await ensureIndexes(driver)
  const session = driver.session()
  try {
    await session.run(
      `CREATE (r:ERAuditRecord {
         id: $id, sessionId: $sessionId, mergePassId: $mergePassId,
         timestamp: $timestamp, label: $label, conflictStrategy: $conflictStrategy,
         pairsDecidedByHuman: $byHuman, pairsDecidedByAi: $byAi,
         pairsDecidedByUnknown: $byUnknown,
         labelFullyCompared: $labelFullyCompared, nodesWalked: $nodesWalked
       })
       WITH r
       MATCH (survivor) WHERE elementId(survivor) = $survivorId
       MERGE (r)-[:MERGED_INTO]->(survivor)`,
      {
        id: record.id,
        sessionId: record.sessionId,
        mergePassId: record.mergePassId,
        timestamp: record.timestamp,
        label: record.label,
        conflictStrategy: record.conflictStrategy,
        survivorId: record.survivorId,
        byHuman: record.decidedBy?.human ?? 0,
        byAi: record.decidedBy?.ai ?? 0,
        byUnknown: record.decidedBy?.unknown ?? 0,
        // Whether the merge rests on a complete comparison of the label or on
        // part of one. Anything reading these records out of the graph has no
        // other way to know, and the difference is not cosmetic: a partial
        // capture leaves duplicates it never looked at. A run with no capture
        // state compared the whole label by construction.
        labelFullyCompared: record.capture ? record.capture.complete : true,
        nodesWalked: record.capture?.nodesWalked ?? null,
      }
    )
    // Link absorbed nodes
    if (record.absorbedIds.length > 0) {
      await session.run(
        `MATCH (r:ERAuditRecord {id: $id})
         MATCH (n) WHERE elementId(n) IN $ids
         MERGE (r)-[:ABSORBED]->(n)`,
        { id: record.id, ids: record.absorbedIds }
      )
    }
  } finally {
    await session.close()
  }
}
