import { randomUUID } from 'crypto'
import { getDriver } from './connection-service'
import { getDb } from './db'
import { listPairs, loadSession } from './session-service'
import { writeAuditRecord as writeNeo4jAuditRecord } from './neo4j-storage'
import type { MergeGroup, MergeApplyResult, AuditRecord, MetricScore } from '../shared/types'

// ── Union-Find ────────────────────────────────────────────────────────────────

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    if (this.parent.get(x) !== x) this.parent.set(x, this.find(this.parent.get(x)!))
    return this.parent.get(x)!
  }

  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }

  groups(): Map<string, string[]> {
    const g = new Map<string, string[]>()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      if (!g.has(root)) g.set(root, [])
      g.get(root)!.push(id)
    }
    return g
  }
}

// ── Dry Run ───────────────────────────────────────────────────────────────────

export async function buildMergeGroups(sessionId: string): Promise<MergeGroup[]> {
  const pairs = listPairs(sessionId).filter((p) => p.verdict === 'duplicate')
  if (pairs.length === 0) return []

  const uf = new UnionFind()
  const directPairs = new Set<string>()

  for (const pair of pairs) {
    uf.union(pair.nodeA.id, pair.nodeB.id)
    const key = [pair.nodeA.id, pair.nodeB.id].sort().join('|')
    directPairs.add(key)
  }

  const driver = getDriver()
  const session = driver.session()
  const groups: MergeGroup[] = []

  try {
    for (const memberIds of uf.groups().values()) {
      if (memberIds.length < 2) continue

      // Find survivor: highest degree
      const result = await session.run(
        `MATCH (n) WHERE elementId(n) IN $ids
         WITH n, COUNT { (n)--() } AS deg ORDER BY deg DESC, elementId(n)
         RETURN elementId(n) AS id LIMIT 1`,
        { ids: memberIds }
      )
      const survivorId = result.records[0]?.get('id') as string ?? memberIds[0]

      // Collect display texts
      const textResult = await session.run(
        `MATCH (n) WHERE elementId(n) IN $ids
         RETURN elementId(n) AS id,
                coalesce(n.name, n.title, n.heading, n.summary, n.text, elementId(n)) AS text`,
        { ids: memberIds }
      )
      const textById = new Map(textResult.records.map((r) => [r.get('id') as string, r.get('text') as string]))

      // Classify pairs within group as direct vs transitive
      const direct: [string, string][] = []
      const transitive: [string, string][] = []
      for (let i = 0; i < memberIds.length; i++) {
        for (let j = i + 1; j < memberIds.length; j++) {
          const key = [memberIds[i], memberIds[j]].sort().join('|')
          if (directPairs.has(key)) direct.push([memberIds[i], memberIds[j]])
          else transitive.push([memberIds[i], memberIds[j]])
        }
      }

      groups.push({
        memberIds,
        memberTexts: memberIds.map((id) => textById.get(id) ?? id),
        survivorId,
        directlyComparedPairs: direct,
        transitivePairs: transitive,
      })
    }
  } finally {
    await session.close()
  }

  return groups
}

// ── Apply ─────────────────────────────────────────────────────────────────────

export async function applyMerges(
  sessionId: string,
  conflictStrategy: 'discard' | 'overwrite' | 'combine',
  apocAvailable: boolean
): Promise<MergeApplyResult> {
  const groups = await buildMergeGroups(sessionId)
  const passId = randomUUID()
  let applied = 0, skipped = 0, failed = 0

  const driver = getDriver()

  for (const group of groups) {
    try {
      const survivorId = apocAvailable
        ? await mergeWithApoc(driver, group.memberIds, conflictStrategy)
        : await mergeWithFallback(driver, group.memberIds, conflictStrategy)

      if (survivorId) {
        const record = writeAuditRecord(sessionId, passId, group, survivorId, conflictStrategy)
        writeNeo4jAuditRecord(record).catch(() => {})
        applied++
      } else {
        skipped++
      }
    } catch (err) {
      console.error('Merge failed for group', group.memberIds, err)
      failed++
    }
  }

  return { groupsApplied: applied, groupsSkipped: skipped, groupsFailed: failed, passId }
}

async function mergeWithApoc(
  driver: ReturnType<typeof getDriver>,
  groupIds: string[],
  strategy: string
): Promise<string | null> {
  const session = driver.session()
  try {
    const result = await session.run(
      `MATCH (n) WHERE elementId(n) IN $ids
       WITH n, COUNT { (n)--() } AS degree ORDER BY degree DESC, elementId(n)
       WITH collect(n) AS nodes WHERE size(nodes) >= 2
       CALL apoc.refactor.mergeNodes(nodes, {properties: $strategy, mergeRels: true})
       YIELD node RETURN elementId(node) AS survivor`,
      { ids: groupIds, strategy }
    )
    return result.records[0]?.get('survivor') as string ?? null
  } finally {
    await session.close()
  }
}

async function mergeWithFallback(
  driver: ReturnType<typeof getDriver>,
  groupIds: string[],
  strategy: string
): Promise<string | null> {
  const session = driver.session()
  const tx = session.beginTransaction()
  try {
    // 1. Select survivor
    const survivorResult = await tx.run(
      `MATCH (n) WHERE elementId(n) IN $ids
       WITH n, COUNT { (n)--() } AS deg ORDER BY deg DESC, elementId(n)
       RETURN elementId(n) AS id LIMIT 1`,
      { ids: groupIds }
    )
    const survivorId = survivorResult.records[0]?.get('id') as string
    if (!survivorId) { await tx.rollback(); return null }
    const absorbedIds = groupIds.filter((id) => id !== survivorId)

    // 2. Collect all relationships on absorbed nodes
    const relResult = await tx.run(
      `MATCH (n) WHERE elementId(n) IN $ids
       OPTIONAL MATCH (n)-[r]->(target)
       RETURN elementId(n) AS from, type(r) AS relType, properties(r) AS relProps, elementId(target) AS to, 'out' AS dir
       UNION ALL
       MATCH (n) WHERE elementId(n) IN $ids
       OPTIONAL MATCH (source)-[r]->(n)
       RETURN elementId(source) AS from, type(r) AS relType, properties(r) AS relProps, elementId(n) AS to, 'in' AS dir`,
      { ids: absorbedIds }
    )

    // 3. Re-create each relationship on the survivor per type
    const relTypes = new Set(relResult.records.map((r) => r.get('relType') as string).filter(Boolean))
    for (const relType of relTypes) {
      const relsOfType = relResult.records.filter((r) => r.get('relType') === relType)
      for (const rel of relsOfType) {
        const dir = rel.get('dir') as string
        const fromId = dir === 'out' ? survivorId : rel.get('from') as string
        const toId = dir === 'out' ? rel.get('to') as string : survivorId
        const relProps = rel.get('relProps') as Record<string, unknown> ?? {}
        await tx.run(
          `MATCH (from) WHERE elementId(from) = $fromId
           MATCH (to) WHERE elementId(to) = $toId
           MERGE (from)-[r:\`${relType}\`]->(to) SET r += $relProps`,
          { fromId, toId, relProps }
        )
      }
    }

    // 4. Apply property strategy to survivor
    if (strategy === 'overwrite') {
      for (const absId of absorbedIds) {
        await tx.run(
          `MATCH (survivor) WHERE elementId(survivor) = $sid
           MATCH (absorbed) WHERE elementId(absorbed) = $aid
           SET survivor += properties(absorbed)`,
          { sid: survivorId, aid: absId }
        )
      }
    }
    // 'discard' = no-op; 'combine' falls back to discard without APOC

    // 5. Delete absorbed nodes
    await tx.run(
      'MATCH (n) WHERE elementId(n) IN $ids DETACH DELETE n',
      { ids: absorbedIds }
    )

    await tx.commit()
    return survivorId
  } catch (err) {
    await tx.rollback()
    throw err
  } finally {
    await session.close()
  }
}

// A merge from a partial capture is individually correct, but the label has not
// been deduplicated — only the part that was walked has. Nothing downstream
// could tell the two apart, so the record now carries it.
function captureOf(sessionId: string): AuditRecord['capture'] {
  const capture = loadSession(sessionId)?.capture
  return capture ? { complete: capture.complete, nodesWalked: capture.nodesWalked } : undefined
}

function writeAuditRecord(
  sessionId: string,
  passId: string,
  group: MergeGroup,
  survivorId: string,
  conflictStrategy: string
): AuditRecord {
  const db = getDb()
  const pairs = listPairs(sessionId).filter((p) =>
    group.memberIds.includes(p.nodeA.id) && group.memberIds.includes(p.nodeB.id)
  )
  const allScores: MetricScore[] = pairs.flatMap((p) => p.scores)
  const absorbed = group.memberIds.filter((id) => id !== survivorId)

  const record: AuditRecord = {
    id: randomUUID(),
    sessionId,
    mergePassId: passId,
    timestamp: new Date().toISOString(),
    label: pairs[0]?.label ?? '',
    survivorId,
    survivorProperties: {},
    absorbedIds: absorbed,
    absorbedProperties: absorbed.map((id) => {
      const pair = pairs.find((p) => p.nodeA.id === id || p.nodeB.id === id)
      return pair?.nodeA.id === id ? pair.nodeA.properties : pair?.nodeB.properties ?? {}
    }),
    scores: allScores,
    conflictStrategy: conflictStrategy as AuditRecord['conflictStrategy'],
    // Attribution for the pairs this merge rests on. A merge is destructive and
    // irreversible, so the record should say whether a human ever looked at the
    // evidence for it.
    decidedBy: pairs.reduce(
      (acc, p) => {
        if (p.verdict === 'pending') return acc
        if (p.decidedBy === 'ai') acc.ai++
        else if (p.decidedBy === 'human') acc.human++
        else acc.unknown++
        return acc
      },
      { human: 0, ai: 0, unknown: 0 }
    ),
    capture: captureOf(sessionId),
  }

  db.prepare(`
    INSERT INTO audit_records(id, session_id, merge_pass_id, timestamp, label, survivor_id,
      survivor_props, absorbed_ids, absorbed_props, scores_json, conflict_strategy,
      decided_by_json, capture_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.sessionId, record.mergePassId,
    new Date(record.timestamp).getTime(),
    record.label, record.survivorId,
    JSON.stringify(record.survivorProperties),
    JSON.stringify(record.absorbedIds),
    JSON.stringify(record.absorbedProperties),
    JSON.stringify(record.scores),
    record.conflictStrategy,
    JSON.stringify(record.decidedBy),
    record.capture ? JSON.stringify(record.capture) : null
  )
  return record
}
