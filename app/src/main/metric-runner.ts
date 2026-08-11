import { getDriver } from './connection-service'
import { pairIdFor } from './pair-id'
import { getMetric } from './metrics/registry'
import { upsertPairs } from './session-service'
import { estimatePairCount } from './candidate-generator'
import { sanitize, toJsNumber } from './neo4j-int'
import type {
  Session,
  CandidatePair,
  MetricScore,
  ScoreDistributions,
  ScorePercentiles,
  PairEstimate,
} from '../shared/types'
import type { NodeRecord } from './metrics/types'

export type ProgressEvent = {
  metricId: string
  fieldName: string
  pct: number
  pairsAbove: number
}

export async function runMetrics(
  session: Session,
  onProgress: (evt: ProgressEvent) => void,
  signal: AbortSignal
): Promise<ScoreDistributions> {
  const driver = getDriver()
  const neo4jSession = driver.session()

  // Map pairId → accumulated scores
  const pairScores: PairScoreMap = new Map()
  // Node snapshots captured during field fetches — no second round-trip needed
  const snapshotMap = new Map<string, { id: string; properties: Record<string, unknown> }>()

  // Per field, the nodes that actually carry the property. Lets surfacing tell
  // "the property is absent" apart from "both have it but they scored poorly" —
  // metrics emit scores sparsely, so a missing score alone means neither.
  const fieldNodeIds = new Map<string, Set<string>>()

  try {
    for (const fieldConfig of session.fields) {
      for (const metricConfig of fieldConfig.metrics) {
        // Signal that this metric has started so the UI shows it at 0% immediately
        onProgress({ metricId: metricConfig.metricId, fieldName: fieldConfig.propertyName, pct: 0, pairsAbove: 0 })
      }

      // Include properties(n) here — we're already paying for the round-trip, and this lets
      // us skip the separate snapshot-fetch query entirely after surfacing.
      console.log(`[compute] Fetching nodes for ${session.label}.${fieldConfig.propertyName}…`)
      const result = await neo4jSession.run(
        `MATCH (n:\`${session.label}\`) WHERE n.\`${fieldConfig.propertyName}\` IS NOT NULL ` +
        `RETURN elementId(n) AS id, n.\`${fieldConfig.propertyName}\` AS val, properties(n) AS props`
      )
      const nodes: NodeRecord[] = result.records.map((r) => {
        const id = r.get('id') as string
        // First time we see this node, capture its full property snapshot.
        // Sanitize each value so neo4j.Integer / BigInt becomes a plain JS number.
        if (!snapshotMap.has(id)) {
          const raw = (r.get('props') ?? {}) as Record<string, unknown>
          const properties: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(raw)) properties[k] = sanitize(v)
          snapshotMap.set(id, { id, properties })
        }
        return { id, value: r.get('val') }
      })
      console.log(`[compute] ${nodes.length} nodes fetched for ${fieldConfig.propertyName}`)
      // The query above already filters to nodes that have the property, so this
      // is the exact set for which the field can be compared at all.
      fieldNodeIds.set(fieldConfig.propertyName, new Set(nodes.map((n) => n.id)))

      for (const metricConfig of fieldConfig.metrics) {
        if (signal.aborted) break
        const metric = getMetric(metricConfig.metricId)
        console.log(`[compute] Running ${metricConfig.metricId} on ${fieldConfig.propertyName}…`)

        const rawScores = await metric.computePairScores(
          nodes,
          metricConfig.params,
          (pct) => onProgress({ metricId: metricConfig.metricId, fieldName: fieldConfig.propertyName, pct, pairsAbove: 0 }),
          signal
        )
        console.log(`[compute] ${metricConfig.metricId} done — ${rawScores.length} pair scores`)

        for (const { idA, idB, score } of rawScores) {
          if (idA === idB) continue
          const pairId = pairIdFor(session.id, idA, idB)
          if (!pairScores.has(pairId)) pairScores.set(pairId, { idA, idB, scores: [] })
          pairScores.get(pairId)!.scores.push({
            metricId: metricConfig.metricId,
            fieldName: fieldConfig.propertyName,
            score,
            aboveThreshold: score >= metricConfig.threshold,
          })
        }
      }
    }

    // Fill in the scores candidate generation never produced.
    //
    // Every bucketing metric only emits pairs whose values share a token, so a
    // pair can be a candidate on one field and have no score at all on another
    // the two nodes both carry. Surfacing cannot tell that apart from a genuine
    // low score, which made All mode reject pairs on comparisons that were
    // never attempted. Ask the metric for the real number instead.
    const tDense = Date.now()
    const densified = densify(session, pairScores, snapshotMap)
    console.log(`[compute] densify: ${densified} scores filled in ${Date.now() - tDense}ms`)

    // Surface pairs using snapshots already in memory — no extra query
    type SurfacedEntry = { pairId: string; idA: string; idB: string; scores: MetricScore[] }
    const surfacedEntries: SurfacedEntry[] = []
    for (const [pairId, { idA, idB, scores, abstained }] of pairScores) {
      if (surfaced(scores, session, idA, idB, fieldNodeIds, abstained))
        surfacedEntries.push({ pairId, idA, idB, scores })
    }
    console.log(`[compute] ${surfacedEntries.length} pairs surfaced`)

    const surfacedPairs: CandidatePair[] = surfacedEntries.map(({ pairId, idA, idB, scores }) => ({
      id: pairId,
      sessionId: session.id,
      label: session.label,
      nodeA: snapshotMap.get(idA) ?? { id: idA, properties: {} },
      nodeB: snapshotMap.get(idB) ?? { id: idB, properties: {} },
      scores,
      verdict: 'pending',
    }))

    let t = Date.now()
    upsertPairs(surfacedPairs)
    console.log(`[compute] upsertPairs: ${Date.now() - t}ms`)

    t = Date.now()
    const dists = computeDistributions(pairScores)
    console.log(`[compute] computeDistributions: ${Date.now() - t}ms`)

    return dists
  } finally {
    // Fire-and-forget — session.close() involves a network round-trip to Aura;
    // awaiting it would stall the caller after all real work is done.
    neo4jSession.close().catch(() => {})
  }
}

function surfaced(
  scores: MetricScore[],
  session: Session,
  idA: string,
  idB: string,
  fieldNodeIds: Map<string, Set<string>>,
  abstained?: Set<string>
): boolean {
  const { mode, fields } = session.surfacingRule

  // Field score = max across metrics for that field
  const fieldScores = new Map<string, number>()
  for (const score of scores) {
    const current = fieldScores.get(score.fieldName) ?? 0
    fieldScores.set(score.fieldName, Math.max(current, score.score))
  }

  // A field can only be judged when both nodes carry the property. Absent is
  // not the same as scoring zero: a pair should not fail a comparison that was
  // never possible. Both nodes must carry the property, and some metric must have been willing
  // to score it. A field every metric declined is no more judgeable than one the
  // nodes do not have.
  const comparable = (propertyName: string): boolean => {
    if (abstained?.has(propertyName)) return false
    const ids = fieldNodeIds.get(propertyName)
    return ids !== undefined && ids.has(idA) && ids.has(idB)
  }

  if (mode === 'any') {
    for (const fc of fields) {
      const fs = fieldScores.get(fc.propertyName) ?? 0
      if (fs >= fc.threshold) return true
    }
    return false
  }

  if (mode === 'all') {
    // Every field the pair can actually be compared on must meet its threshold.
    // Fields one or both nodes lack are skipped rather than counted as a
    // failure — otherwise sparse data excludes pairs that match on everything
    // they share. A field both nodes have but that produced no score is still a
    // failure: that is a real comparison the pair lost.
    let compared = 0
    for (const fc of fields) {
      if (!comparable(fc.propertyName)) continue
      compared++
      if ((fieldScores.get(fc.propertyName) ?? 0) < fc.threshold) return false
    }
    return compared > 0
  }

  // weighted-average — divide by the weights actually in play so this is a mean
  // rather than a sum. Weights drift away from summing to 1 whenever a field is
  // removed or a slider is dragged, and an unnormalized sum silently rescales
  // the combined threshold: five fields left holding 1/9 each cap the total at
  // 0.56, so a 0.85 threshold can never be met however well the pair matches.
  // A field every metric declined is dropped from both sides of the ratio, so
  // it neither helps nor hurts. Leaving it only in the denominator would penalise
  // a pair for a comparison nothing was willing to make.
  const usable = fields.filter((fc) => !abstained?.has(fc.propertyName))
  const totalWeight = usable.reduce((sum, fc) => sum + fc.weight, 0)
  if (totalWeight <= 0) return false
  const weighted = usable.reduce((sum, fc) => {
    return sum + fc.weight * (fieldScores.get(fc.propertyName) ?? 0)
  }, 0)
  return weighted / totalWeight >= (session.surfacingRule.combinedThreshold ?? 0.85)
}


function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

function computeDistributions(
  pairScores: Map<string, { idA: string; idB: string; scores: MetricScore[] }>
): ScoreDistributions {
  // Collect scores per (metricId, fieldName) for all pairs and pending-only
  const allScores = new Map<string, number[]>()
  const pendingScores = new Map<string, number[]>()

  for (const { scores } of pairScores.values()) {
    for (const s of scores) {
      const key = `${s.metricId}|${s.fieldName}`
      if (!allScores.has(key)) allScores.set(key, [])
      allScores.get(key)!.push(s.score)
      // All pairs start as pending after recompute
      if (!pendingScores.has(key)) pendingScores.set(key, [])
      pendingScores.get(key)!.push(s.score)
    }
  }

  const toPercentiles = (map: Map<string, number[]>): ScorePercentiles[] =>
    Array.from(map.entries()).map(([key, vals]) => {
      const [metricId, fieldName] = key.split('|')
      const sorted = [...vals].sort((a, b) => a - b)
      return {
        metricId,
        fieldName,
        p50: percentile(sorted, 0.5),
        p75: percentile(sorted, 0.75),
        p90: percentile(sorted, 0.9),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1] ?? 0,
      }
    })

  return { all: toPercentiles(allScores), pending: toPercentiles(pendingScores) }
}

type PairEntry = { idA: string; idB: string; scores: MetricScore[]; abstained?: Set<string> }
type PairScoreMap = Map<string, PairEntry>
type NodeSnapshot = { id: string; properties: Record<string, unknown> }

// Fills in the scores candidate generation never produced, for every field the
// two nodes both carry. Returns how many it added.
//
// Also records fields where both nodes have the property but no metric would
// produce a number — a metric can decline a comparison it cannot make well, as
// edit distance does below its minimum length. That is not the pair losing a
// comparison, so surfacing must not read it as one.
function densify(session: Session, pairScores: PairScoreMap, snapshots: Map<string, NodeSnapshot>): number {
  let densified = 0
  for (const entry of pairScores.values()) {
    const { idA, idB, scores } = entry
    const propsA = snapshots.get(idA)?.properties
    const propsB = snapshots.get(idB)?.properties
    if (!propsA || !propsB) continue
    const have = new Set(scores.map((s) => `${s.fieldName}|${s.metricId}`))
    const scoredFields = new Set(scores.map((s) => s.fieldName))

    for (const fieldConfig of session.fields) {
      // properties() omits nulls, so absence here means the node genuinely
      // lacks the property and there is nothing to compare.
      const a = propsA[fieldConfig.propertyName]
      const b = propsB[fieldConfig.propertyName]
      if (a === undefined || b === undefined) continue

      for (const metricConfig of fieldConfig.metrics) {
        if (have.has(`${fieldConfig.propertyName}|${metricConfig.metricId}`)) continue
        const metric = getMetric(metricConfig.metricId)
        if (!metric.scorePair) continue
        const score = metric.scorePair(a, b, metricConfig.params)
        if (score === null) continue
        scores.push({
          metricId: metricConfig.metricId,
          fieldName: fieldConfig.propertyName,
          score,
          aboveThreshold: score >= metricConfig.threshold,
        })
        scoredFields.add(fieldConfig.propertyName)
        densified++
      }

      if (!scoredFields.has(fieldConfig.propertyName)) {
        if (!entry.abstained) entry.abstained = new Set()
        entry.abstained.add(fieldConfig.propertyName)
      }
    }
  }
  return densified
}

// Above this many candidate pairs the estimate thins the node set before scoring.
const EXACT_CANDIDATE_LIMIT = 50_000

// Hard ceiling on how many nodes the estimate will pull into memory. This bound
// has to be applied by the query, not after it: the estimate used to fetch every
// node of the label and only then decide whether to sample, which on a 6.3M-node
// label is ~3.7 GB of property maps into the main process and kills it outright.
const MAX_ESTIMATE_NODES = 20_000

const pairCount = (n: number): number => (n * (n - 1)) / 2

/**
 * Counts the pairs the session's surfacing rule would actually surface.
 *
 * Runs the real pipeline — candidate generation, densification, and the same
 * `surfaced()` the compute pass uses — so All and Weighted Average are answered
 * on real scores rather than on bucket counts. Since densification means every
 * mode considers the same candidate union, there is no cheaper way to tell the
 * modes apart than to score them.
 *
 * On labels too large to score in full, a stride sample of nodes is scored and
 * the result scaled by C(N,2)/C(n,2) — unbiased in expectation, because a pair
 * survives sampling exactly when both its nodes do.
 */
export async function estimateSurfacedPairs(session: Session): Promise<PairEstimate> {
  const driver = getDriver()
  const neo4jSession = driver.session()
  try {
    // Size the label first — a count-store lookup, independent of label size —
    // so the fetch below can be bounded rather than discovered to be too large
    // once it is already in memory.
    const countResult = await neo4jSession.run(
      `MATCH (n:\`${session.label}\`) RETURN count(n) AS total`
    )
    const totalNodes = toJsNumber(countResult.records[0]?.get('total') ?? 0)
    if (totalNodes < 2) return { count: 0, exact: true, candidates: 0 }

    // One scan for the whole label. Per-field queries would give each field its
    // own row set, and ids from different fields cannot be compared.
    const limit = Math.min(totalNodes, MAX_ESTIMATE_NODES)
    const result = await neo4jSession.run(
      `MATCH (n:\`${session.label}\`) RETURN elementId(n) AS id, properties(n) AS props LIMIT ${limit}`
    )
    const fetched: NodeSnapshot[] = result.records.map((r) => {
      const raw = (r.get('props') ?? {}) as Record<string, unknown>
      const properties: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) properties[k] = sanitize(v)
      return { id: r.get('id') as string, properties }
    })
    if (fetched.length < 2) return { count: 0, exact: true, candidates: 0 }

    console.log(`[estimate] ${session.label}: ${totalNodes} nodes, fetched ${fetched.length}`)
    let t = Date.now()
    const candidates = countCandidates(session, fetched)
    console.log(`[estimate] countCandidates: ${candidates.toLocaleString()} in ${Date.now() - t}ms`)
    let sample = fetched
    if (candidates > EXACT_CANDIDATE_LIMIT) {
      // Candidates grow with the square of node count, so scale the node sample
      // by the square root of how far over the limit we are.
      const target = Math.floor(fetched.length * Math.sqrt(EXACT_CANDIDATE_LIMIT / candidates))
      sample = strideSample(fetched, Math.max(2, target))
    }

    console.log(`[estimate] scoring ${sample.length} nodes across ${session.fields.length} fields`)
    t = Date.now()
    const count = await surfacedCount(session, sample)
    console.log(`[estimate] surfacedCount: ${count} in ${Date.now() - t}ms`)
    // Exact only when every node in the label was scored — both the fetch bound
    // and the candidate thinning have to have been no-ops.
    if (sample.length === totalNodes) return { count, exact: true, candidates }

    const scale = pairCount(totalNodes) / pairCount(sample.length)
    return {
      count: Math.round(count * scale),
      exact: false,
      candidates,
      sampledNodes: sample.length,
      totalNodes,
    }
  } finally {
    neo4jSession.close().catch(() => {})
  }
}

// Upper bound on how many pairs the pipeline would score, used only to decide
// how far to thin the sample. Different metrics group candidates differently and
// the widest grouping is what has to be modelled, or the thinning is sized
// against the wrong number and the scoring step runs out of memory.
function countCandidates(session: Session, nodes: NodeSnapshot[]): number {
  let widest = 0

  for (const fieldConfig of session.fields) {
    const present = nodes.filter((n) => n.properties[fieldConfig.propertyName] !== undefined)
    if (present.length < 2) continue

    for (const metricConfig of fieldConfig.metrics) {
      // Scores every pair regardless of value.
      if (metricConfig.metricId === 'semantic-cosine') {
        widest = Math.max(widest, pairCount(present.length))
        continue
      }

      const values = present.map((n) => String(n.properties[fieldConfig.propertyName]))

      // Exact match and phonetic bucket on the whole value — one bucket per
      // distinct value or code — and neither caps bucket size the way token
      // bucketing does. On a low-cardinality field such as a month number that
      // is a handful of enormous buckets: twelve values over twenty thousand
      // nodes is millions of pairs, where the token count would report none.
      if (metricConfig.metricId === 'exact-match' || metricConfig.metricId === 'phonetic') {
        const freq = new Map<string, number>()
        for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1)
        let total = 0
        for (const size of freq.values()) if (size > 1) total += pairCount(size)
        widest = Math.max(widest, total)
        continue
      }

      // Token bucketing — counted, never materialised. See estimatePairCount.
      widest = Math.max(widest, estimatePairCount(present.map((n, i) => ({ id: n.id, value: values[i] }))))
    }
  }
  return widest
}

async function surfacedCount(session: Session, nodes: NodeSnapshot[]): Promise<number> {
  const snapshots = new Map(nodes.map((n) => [n.id, n]))
  const fieldNodeIds = new Map<string, Set<string>>()
  const pairScores: PairScoreMap = new Map()
  const signal = new AbortController().signal

  for (const fieldConfig of session.fields) {
    const present = nodes.filter((n) => n.properties[fieldConfig.propertyName] !== undefined)
    fieldNodeIds.set(fieldConfig.propertyName, new Set(present.map((n) => n.id)))
    if (present.length < 2) continue

    const records: NodeRecord[] = present.map((n) => ({
      id: n.id,
      value: n.properties[fieldConfig.propertyName],
    }))

    for (const metricConfig of fieldConfig.metrics) {
      const metric = getMetric(metricConfig.metricId)
      const raw = await metric.computePairScores(records, metricConfig.params, () => {}, signal)
      for (const { idA, idB, score } of raw) {
        if (idA === idB) continue
        const pairId = pairIdFor(session.id, idA, idB)
        if (!pairScores.has(pairId)) pairScores.set(pairId, { idA, idB, scores: [] })
        pairScores.get(pairId)!.scores.push({
          metricId: metricConfig.metricId,
          fieldName: fieldConfig.propertyName,
          score,
          aboveThreshold: score >= metricConfig.threshold,
        })
      }
    }
  }

  densify(session, pairScores, snapshots)

  let count = 0
  for (const { idA, idB, scores, abstained } of pairScores.values()) {
    if (surfaced(scores, session, idA, idB, fieldNodeIds, abstained)) count++
  }
  return count
}

// Evenly spaced rather than random, so clicking Recalculate twice on unchanged
// data gives the same number.
function strideSample<T>(items: T[], target: number): T[] {
  if (target >= items.length) return items
  const stride = items.length / target
  const out: T[] = []
  for (let i = 0; i < target; i++) out.push(items[Math.floor(i * stride)])
  return out
}
