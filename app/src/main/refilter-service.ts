import { getDb } from './db'
import { getDriver } from './connection-service'
import { applySurfacingRule, loadSnapshots } from './metric-runner'
import type { MetricScore, NodeSnapshot, RefilterResult, Session } from '../shared/types'

/**
 * Re-apply the surfacing rule to candidates already captured.
 *
 * Scores do not depend on thresholds, so a threshold or surfacing-rule change
 * is a question about stored numbers rather than a reason to walk the label
 * again. That is what makes a threshold worth lowering: the candidates that
 * fell short are still there to be let back in.
 *
 * A field is comparable exactly when the pair has a score row for it — see
 * applySurfacingRule. The graph is touched only to fill in snapshots for pairs
 * entering the queue for the first time, which are not stored for candidates
 * that have never surfaced. That fetch is the whole cost: re-filtering 30,217
 * captured candidates on Company took 75ms, and hydrating the 14,731 pairs it
 * promoted took 2.4s.
 */
export async function refilterPairs(session: Session, signal?: AbortSignal): Promise<RefilterResult> {
  const t0 = Date.now()
  const db = getDb()
  const pairs = db
    .prepare('SELECT id, surfaced, verdict, node_a_json, node_b_json FROM pairs WHERE session_id = ?')
    .all(session.id) as Record<string, unknown>[]
  const scoreRows = db
    .prepare(
      'SELECT ps.* FROM pair_scores ps JOIN pairs p ON p.id = ps.pair_id WHERE p.session_id = ?'
    )
    .all(session.id) as Record<string, unknown>[]

  const byPair = new Map<string, MetricScore[]>()
  for (const r of scoreRows) {
    const pid = r.pair_id as string
    if (!byPair.has(pid)) byPair.set(pid, [])
    byPair.get(pid)!.push({
      metricId: r.metric_id as string,
      fieldName: r.field_name as string,
      score: r.score as number,
      aboveThreshold: false,
    })
  }

  // Current per-metric thresholds, for the aboveThreshold flag the review screen
  // colours by. Recomputed here because it is threshold-dependent and so goes
  // stale the moment a threshold moves.
  const thresholds = new Map<string, number>()
  for (const f of session.fields) {
    for (const m of f.metrics) thresholds.set(`${f.propertyName}|${m.metricId}`, m.threshold)
  }

  console.log(`[refilter] read ${pairs.length} pairs and ${scoreRows.length} scores in ${Date.now() - t0}ms`)
  const result: RefilterResult = { surfaced: 0, added: 0, removed: 0, keptForVerdict: 0, repaired: 0 }
  const toHydrate: { pairId: string; idA: string; idB: string }[] = []
  const updates: { id: string; surfaced: number }[] = []

  for (const row of pairs) {
    const id = row.id as string
    const scores = byPair.get(id) ?? []
    const withFlags = scores.map((s) => ({
      ...s,
      aboveThreshold: s.score >= (thresholds.get(`${s.fieldName}|${s.metricId}`) ?? 1),
    }))
    const scoredFields = new Set(scores.map((s) => s.fieldName))
    let nowSurfaced = applySurfacingRule(withFlags, session, (p) => scoredFields.has(p))

    const wasSurfaced = (row.surfaced as number) === 1
    // A pair someone has already ruled on stays in the queue even if a raised
    // threshold would now exclude it. Hiding decided work makes the queue lie
    // about what was reviewed, and the verdict still stands.
    if (!nowSurfaced && wasSurfaced && (row.verdict as string) !== 'pending') {
      nowSurfaced = true
      result.keptForVerdict++
    }

    if (nowSurfaced) result.surfaced++

    // Snapshots written before temporal values were converted hold the driver's
    // internal shape and display as "[object Object]". Re-fetching is the only
    // repair — the stored form has lost the type that says how to read it. A
    // resumed capture never revisits nodes it has already walked, so without
    // this those pairs would carry it for the life of the session.
    if (nowSurfaced && wasSurfaced && hasLegacyTemporal(row.node_a_json as string, row.node_b_json as string)) {
      const a = JSON.parse(row.node_a_json as string) as NodeSnapshot
      const b = JSON.parse(row.node_b_json as string) as NodeSnapshot
      toHydrate.push({ pairId: id, idA: a.id, idB: b.id })
      result.repaired++
    }

    if (nowSurfaced !== wasSurfaced) {
      updates.push({ id, surfaced: nowSurfaced ? 1 : 0 })
      if (nowSurfaced) {
        result.added++
        const a = JSON.parse(row.node_a_json as string) as NodeSnapshot
        const b = JSON.parse(row.node_b_json as string) as NodeSnapshot
        if (Object.keys(a.properties ?? {}).length === 0 || Object.keys(b.properties ?? {}).length === 0) {
          toHydrate.push({ pairId: id, idA: a.id, idB: b.id })
        }
      } else {
        result.removed++
      }
    }
  }

  const setSurfaced = db.prepare('UPDATE pairs SET surfaced = ? WHERE id = ?')
  // One statement per metric rather than per score row — bounded by the number
  // of configured metrics rather than by the size of the capture.
  const setScoreFlags = db.prepare(`
    UPDATE pair_scores SET above_threshold = (score >= ?)
    WHERE field_name = ? AND metric_id = ?
      AND pair_id IN (SELECT id FROM pairs WHERE session_id = ?)
  `)
  db.transaction(() => {
    for (const u of updates) setSurfaced.run(u.surfaced, u.id)
    for (const [key, threshold] of thresholds) {
      const [fieldName, metricId] = key.split('|')
      setScoreFlags.run(threshold, fieldName, metricId, session.id)
    }
  })()

  if (toHydrate.length > 0) {
    const t = Date.now()
    await hydrate(toHydrate, signal)
    console.log(`[refilter] hydrated ${toHydrate.length} pairs in ${Date.now() - t}ms`)
  }
  return result
}

// A neo4j.Integer serialises as {"low":n,"high":n}, and a temporal value is a
// bag of them. No ordinary property produces that shape, so its presence in the
// stored JSON identifies a snapshot written before the conversion existed.
function hasLegacyTemporal(nodeAJson: string, nodeBJson: string): boolean {
  return nodeAJson.includes('"low":') || nodeBJson.includes('"low":')
}

// Pairs entering the queue for the first time have no stored snapshots — only
// surfaced pairs carry them, because storing them for every candidate cost 116 MB
// per pass on Company against 12 MB for ids and scores alone.
async function hydrate(
  pairs: { pairId: string; idA: string; idB: string }[],
  signal?: AbortSignal
): Promise<void> {
  const driver = getDriver()
  const neo4jSession = driver.session()
  try {
    const ids = new Set<string>()
    for (const p of pairs) { ids.add(p.idA); ids.add(p.idB) }
    const snapshots = new Map<string, NodeSnapshot>()
    await loadSnapshots(neo4jSession, ids, snapshots, signal ?? new AbortController().signal)

    const db = getDb()
    const update = db.prepare('UPDATE pairs SET node_a_json = ?, node_b_json = ? WHERE id = ?')
    db.transaction(() => {
      for (const p of pairs) {
        update.run(
          JSON.stringify(snapshots.get(p.idA) ?? { id: p.idA, properties: {} }),
          JSON.stringify(snapshots.get(p.idB) ?? { id: p.idB, properties: {} }),
          p.pairId
        )
      }
    })()
  } finally {
    await neo4jSession.close()
  }
}
