import { createHash } from 'crypto'
import { int } from 'neo4j-driver'
import { getDriver } from './connection-service'
import { getCachedSchema } from './schema-service'
import { pairIdFor } from './pair-id'
import { getMetric } from './metrics/registry'
import { upsertPairs, saveSession } from './session-service'
import { estimatePairCount, MAX_CANDIDATE_PAIRS, CandidateLimitError } from './candidate-generator'
import { sanitize, toJsNumber } from './neo4j-int'
import type {
  Session,
  CandidatePair,
  MetricScore,
  ScoreDistributions,
  ScorePercentiles,
  PairEstimate,
  CandidateSummary,
  CaptureState,
} from '../shared/types'
import type { NodeRecord } from './metrics/types'

// Element ids per snapshot re-fetch. The plan is a NodeByElementIdSeek, so this
// is only about bounding one response.
const SNAPSHOT_BATCH_SIZE = 10_000

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

  // Per field, the nodes that actually carry the property. Lets surfacing tell
  // "the property is absent" apart from "both have it but they scored poorly" —
  // metrics emit scores sparsely, so a missing score alone means neither.
  const fieldNodeIds = new Map<string, Set<string>>()

  try {
    // Candidate generation, made explicit.
    //
    // Metrics decide which pairs are worth scoring by bucketing, and a pair that
    // no metric buckets together is never scored by anything. That is a recall
    // decision, and on a label small enough to compare completely it is one
    // nobody should be paying. Measured on a 244-node label: 28,822 of 29,646
    // possible pairs were considered and 824 — 2.8% — were never scored at all,
    // because they shared no token, no exact value and no phonetic code on any
    // field.
    //
    // So when the label is small enough to afford it, seed every pair up front.
    // densify() fills in each field's scores for pairs it finds already present,
    // which turns that seeding into a complete comparison without touching a
    // single metric.
    // Prefix blocking replaces candidate generation rather than adding to it,
    // and captures in bounded batches rather than walking the whole label.
    //
    // Scoring happens inside that loop, not after it. A surfaced-pair budget
    // cannot be honoured otherwise — how many surfaced is only known once they
    // are scored — and scoring per batch bounds memory to a batch rather than to
    // everything the walk finds. Each batch is persisted as it lands, so a
    // cancelled pass keeps what it captured.
    if ((session.blockingStrategy ?? 'auto') === 'prefix') {
      return await capturePrefix(neo4jSession, session, onProgress, signal)
    }

    const exhaustive = await seedExhaustivePairs(neo4jSession, session, pairScores)
    if (exhaustive !== null) {
      console.log(
        `[compute] candidates: exhaustive — ${exhaustive.nodes} nodes, ` +
          `${exhaustive.pairs.toLocaleString()} pairs, every pair compared`
      )
    }
    for (const fieldConfig of session.fields) {
      for (const metricConfig of fieldConfig.metrics) {
        // Signal that this metric has started so the UI shows it at 0% immediately
        onProgress({ metricId: metricConfig.metricId, fieldName: fieldConfig.propertyName, pct: 0, pairsAbove: 0 })
      }

      // Id and the one value this field needs, nothing else.
      //
      // This used to select properties(n) as well, so every node's full property
      // map was held for the whole run to save a round trip later. Measured on a
      // 6.3M-node label that is ~900 bytes per node against ~165 for id and
      // value — 5.7GB against 1.0GB, and the larger figure does not fit. The
      // properties are re-fetched after scoring, for the far smaller set of
      // nodes that actually landed in a pair.
      //
      // Consumed as a stream rather than as result.records, so the driver's
      // record objects are released as they are read instead of all being held
      // at once, and so cancellation has somewhere to land.
      console.log(`[compute] Fetching nodes for ${session.label}.${fieldConfig.propertyName}…`)
      const tFetch = Date.now()
      const nodes: NodeRecord[] = []
      for await (const r of neo4jSession.run(
        `MATCH (n:\`${session.label}\`) WHERE n.\`${fieldConfig.propertyName}\` IS NOT NULL ` +
        `RETURN elementId(n) AS id, n.\`${fieldConfig.propertyName}\` AS val`
      )) {
        nodes.push({ id: r.get('id') as string, value: r.get('val') })
        if ((nodes.length & 0x3fff) === 0 && signal.aborted) break
      }
      if (signal.aborted) break
      console.log(`[compute] ${nodes.length} nodes fetched for ${fieldConfig.propertyName} in ${Date.now() - tFetch}ms`)
      // The query above already filters to nodes that have the property, so this
      // is the exact set for which the field can be compared at all.
      fieldNodeIds.set(fieldConfig.propertyName, new Set(nodes.map((n) => n.id)))

      for (const metricConfig of fieldConfig.metrics) {
        if (signal.aborted) break
        const metric = getMetric(metricConfig.metricId)
        console.log(`[compute] Running ${metricConfig.metricId} on ${fieldConfig.propertyName}…`)

        let rawScores
        try {
          rawScores = await metric.computePairScores(
            nodes,
            metricConfig.params,
            (pct) => onProgress({ metricId: metricConfig.metricId, fieldName: fieldConfig.propertyName, pct, pairsAbove: 0 }),
            signal
          )
        } catch (err) {
          if (err instanceof CandidateLimitError) {
            throw new Error(
              `${err.message} Reached on ${fieldConfig.propertyName} · ${metricConfig.metricId}.`
            )
          }
          throw err
        }
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

        // The accumulated total can exceed the ceiling even when no single
        // metric did, since pairs from different fields merge here.
        if (pairScores.size > MAX_CANDIDATE_PAIRS) throw new CandidateLimitError()
      }
    }

    // Fill in the scores candidate generation never produced.
    //
    // Every bucketing metric only emits pairs whose values share a token, so a
    // pair can be a candidate on one field and have no score at all on another
    // the two nodes both carry. Surfacing cannot tell that apart from a genuine
    // low score, which made All mode reject pairs on comparisons that were
    // never attempted. Ask the metric for the real number instead.
    const candidates: CandidateSummary = exhaustive
      ? { strategy: 'exhaustive', nodes: exhaustive.nodes, pairs: pairScores.size, complete: true }
      : {
          strategy: 'token-bucket',
          nodes: Math.max(0, ...[...fieldNodeIds.values()].map((ids) => ids.size)),
          pairs: pairScores.size,
          complete: false,
        }
    if (!exhaustive) {
      console.log(
        `[compute] candidates: token-bucket — ${candidates.pairs.toLocaleString()} pairs from ` +
          `${candidates.nodes.toLocaleString()} nodes; pairs sharing no token were never compared`
      )
    }

    return await scoreAndSurface(neo4jSession, session, pairScores, candidates, fieldNodeIds, signal)
  } finally {
    // Fire-and-forget — session.close() involves a network round-trip to Aura;
    // awaiting it would stall the caller after all real work is done.
    neo4jSession.close().catch(() => {})
  }
}

// Partners kept per blocking node. A block is a prefix, so on a common prefix
// it can hold thousands of nodes that share nothing else; taking all of them
// would reproduce the unbounded-bucket problem the strategy exists to avoid.
const PREFIX_BLOCK_LIMIT = 50

export const DEFAULT_PREFIX_LENGTH = 8

// Nodes per walk query. Large enough to amortise the round trip — one lookup
// per node cost 160ms in round trips alone — small enough that the ordered
// scan stays a bounded index seek.
const PREFIX_WALK_BATCH = 5000

// A pass stops on whichever budget is reached first.
//
// Two, not one: a strict threshold surfaces almost nothing, so a surfaced-only
// budget would walk the entire label finding nothing and look hung — the exact
// failure this project has hit twice. A candidate budget bounds the work
// regardless of how selective the rule turns out to be.
//
// Sized so a pass returns in seconds. At the measured 0.26ms/node and ~2.4
// candidates per node, 100,000 candidates is roughly 40,000 nodes and about ten
// seconds on a label of any size.
const CAPTURE_CANDIDATE_BUDGET = 100_000
const CAPTURE_SURFACED_BUDGET = 2_000

/**
 * Candidate pairs from a prefix block, asked of the database.
 *
 * The predicate has to touch the raw stored property — wrapping it in a
 * function loses the index seek, so no normalisation can happen here and
 * matching is case-sensitive. That is a recall trade the caller is choosing.
 *
 * Each pair is produced once, from whichever member sorts earlier, with an
 * element-id tiebreak so two nodes holding the identical value still pair.
 * Without the tiebreak `n.f < m.f` drops exact duplicates entirely, which are
 * the ones most worth finding.
 */
async function prefixBlockPairs(
  neo4jSession: ReturnType<ReturnType<typeof getDriver>['session']>,
  session: Session,
  pairScores: PairScoreMap,
  signal?: AbortSignal,
  batchSize: number = PREFIX_WALK_BATCH
): Promise<{ nodes: number; pairs: number; capture: CaptureState }> {
  const field = session.blockingField
  if (!field) throw new Error('Prefix blocking needs a field to block by.')

  const indexes =
    getCachedSchema()
      ?.labels.find((l) => l.name === session.label)
      ?.properties.find((p) => p.name === field)?.indexes ?? []
  if (!indexes.some((k) => k === 'RANGE' || k === 'TEXT')) {
    throw new Error(
      `Prefix blocking on ${session.label}.${field} needs a RANGE or TEXT index on that ` +
        `property, and there is none. Without one the database scans the whole label for ` +
        `every node. Choose a property that is indexed, or a different strategy.`
    )
  }

  // In this mode densify() produces every score, and it can only ask metrics
  // that expose scorePair. A metric without one would contribute nothing, the
  // field would look unjudgeable, and All mode would quietly drop it — the same
  // silent narrowing that #23 describes, arriving through a different door.
  // Refuse the configuration instead of returning a rule narrower than the one
  // on screen.
  const unscorable = session.fields.flatMap((f) =>
    f.metrics.filter((m) => !getMetric(m.metricId).scorePair).map((m) => `${f.propertyName} · ${m.metricId}`)
  )
  if (unscorable.length > 0) {
    throw new Error(
      `Prefix blocking cannot score ${unscorable.join(', ')}. That metric compares whole sets of ` +
        `nodes at once rather than one pair at a time, so this strategy would leave those fields ` +
        `unscored and drop them from the rule. Remove the metric, or choose another strategy.`
    )
  }

  const prefix = Math.max(1, session.blockingPrefixLength ?? DEFAULT_PREFIX_LENGTH)
  const label = session.label

  // Walked in batches, not as one query.
  //
  // `WITH n ORDER BY n.f` over a whole label is a blocking sort: the database
  // materialises every row before emitting any. On a 6.3M-node label that hit
  // Aura's 1.3 GiB transaction limit in 24 seconds. With a LIMIT the planner
  // seeks the index instead and streams, so the walk is a sequence of bounded
  // queries carrying a cursor.
  //
  // The cursor is (value, elementId) rather than value alone, because a batch
  // boundary can fall inside a run of equal values and `n.f > $cursor` would
  // skip every node sharing the boundary value.
  const q =
    `MATCH (n:\`${label}\`) WHERE n.\`${field}\` IS NOT NULL\n` +
    `  AND ($cv IS NULL OR n.\`${field}\` > $cv\n` +
    `       OR (n.\`${field}\` = $cv AND elementId(n) > $cid))\n` +
    `WITH n ORDER BY n.\`${field}\`, elementId(n) LIMIT $batch\n` +
    `WITH n, left(n.\`${field}\`, ${prefix}) AS block\n` +
    // OPTIONAL, so a node with no partners still returns a row. A plain MATCH
    // drops them, and a batch where nothing matched would return nothing at all
    // — leaving the cursor unable to advance and ending the walk early.
    `OPTIONAL MATCH (m:\`${label}\`) WHERE m.\`${field}\` STARTS WITH block\n` +
    `  AND (n.\`${field}\` < m.\`${field}\`\n` +
    `       OR (n.\`${field}\` = m.\`${field}\` AND elementId(n) < elementId(m)))\n` +
    `WITH n, [x IN collect(elementId(m)) WHERE x IS NOT NULL][..${PREFIX_BLOCK_LIMIT}] AS partners\n` +
    `RETURN elementId(n) AS id, n.\`${field}\` AS v, partners`

  // Resume where the last pass stopped. Pairs are produced only from the member
  // that sorts earlier, so a resumed walk never re-finds what it already has,
  // and reaching the end means the label is finished.
  const prior = session.capture
  let cv: unknown = prior?.cursorValue ?? null
  let cid: string | null = prior?.cursorId ?? null
  let nodes = 0
  let complete = false

  for (;;) {
    if (signal?.aborted) break
    const result = await neo4jSession.run(q, { cv, cid, batch: int(batchSize) })
    if (result.records.length === 0) {
      complete = true
      break
    }

    for (const r of result.records) {
      const idA = r.get('id') as string
      nodes++
      for (const idB of r.get('partners') as string[]) {
        const pairId = pairIdFor(session.id, idA, idB)
        if (!pairScores.has(pairId)) pairScores.set(pairId, { idA, idB, scores: [] })
      }
    }
    if (pairScores.size > MAX_CANDIDATE_PAIRS) throw new CandidateLimitError()

    const last = result.records[result.records.length - 1]
    cv = last.get('v')
    cid = last.get('id') as string

    // A short batch means the walk ran out of nodes, not out of budget.
    // One batch per call — the capture loop owns the budget, because it is the
    // only place that knows how many pairs actually surfaced.
    if (result.records.length < batchSize) complete = true
    break
  }

  return {
    nodes: (prior?.nodesWalked ?? 0) + nodes,
    pairs: pairScores.size,
    capture: {
      fingerprint: prior?.fingerprint,
      cursorValue: complete ? null : (cv as string | null),
      cursorId: complete ? null : cid,
      nodesWalked: (prior?.nodesWalked ?? 0) + nodes,
      complete,
    },
  }
}

// Comparing every pair costs ~325 bytes each while a run is in progress, so
// exhaustive mode is only offered where that is comfortably affordable. Above
// this the existing per-metric bucketing decides candidates, as it always has.
const EXHAUSTIVE_PAIR_LIMIT = 500_000

/**
 * Seeds every pair of the label when it is small enough to compare completely.
 *
 * Returns null when the label is too large, leaving candidate generation to the
 * metrics. Scores are not written here — densify() fills them in, which is what
 * makes this a strategy rather than a special case.
 */
async function seedExhaustivePairs(
  neo4jSession: ReturnType<ReturnType<typeof getDriver>['session']>,
  session: Session,
  pairScores: PairScoreMap
): Promise<{ nodes: number; pairs: number } | null> {
  const strategy = session.blockingStrategy ?? 'auto'
  if (strategy === 'token-bucket') return null

  const counted = await neo4jSession.run(
    `MATCH (n:\`${session.label}\`) RETURN count(n) AS total`
  )
  const total = toJsNumber(counted.records[0]?.get('total') ?? 0)
  if (total < 2) return null

  // 'auto' declines above the limit and lets bucketing decide. An explicit
  // choice is honoured up to the point where it cannot complete at all, and
  // refused past it with the reason rather than by silently doing something
  // else — the run would otherwise die inside candidate generation.
  if (pairCount(total) > EXHAUSTIVE_PAIR_LIMIT) {
    if (strategy === 'auto') return null
    if (pairCount(total) > MAX_CANDIDATE_PAIRS) {
      throw new Error(
        `Comparing every pair of ${total.toLocaleString()} nodes is ` +
          `${Math.round(pairCount(total)).toLocaleString()} comparisons, past the ` +
          `${MAX_CANDIDATE_PAIRS.toLocaleString()} limit. Choose "pairs sharing a word" ` +
          `instead, or narrow the label.`
      )
    }
  }

  const ids: string[] = []
  for await (const r of neo4jSession.run(
    `MATCH (n:\`${session.label}\`) RETURN elementId(n) AS id`
  )) {
    ids.push(r.get('id') as string)
  }

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const pairId = pairIdFor(session.id, ids[i], ids[j])
      if (!pairScores.has(pairId)) pairScores.set(pairId, { idA: ids[i], idB: ids[j], scores: [] })
    }
  }
  return { nodes: ids.length, pairs: pairScores.size }
}

/**
 * Walks the label in bounded batches, scoring and persisting each before asking
 * for the next, stopping on whichever budget is reached first.
 */
// Identifies the configuration a walk was made under. Fields, metric ids, and
// metric params are in it because they determine the scores; the blocking key
// and prefix length because they determine which pairs are ever offered; the
// label because it is what is being walked. Thresholds and the surfacing rule
// are out — see CaptureState.fingerprint.
function captureFingerprint(session: Session): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        label: session.label,
        blockingField: session.blockingField,
        blockingPrefixLength: session.blockingPrefixLength,
        fields: session.fields.map((f) => ({
          name: f.propertyName,
          metrics: f.metrics.map((mc) => ({ id: mc.metricId, params: mc.params })),
        })),
      })
    )
    .digest('hex')
    .slice(0, 12)
}

async function capturePrefix(
  neo4jSession: ReturnType<ReturnType<typeof getDriver>['session']>,
  session: Session,
  onProgress: (evt: ProgressEvent) => void,
  signal: AbortSignal
): Promise<ScoreDistributions> {
  const allScores: PairScoreMap = new Map()
  const snapshotMap = new Map<string, NodeSnapshot>()
  let surfacedTotal = 0
  const fingerprint = captureFingerprint(session)
  // Resume only a walk that is both unfinished and made under this exact
  // configuration. A finished one is not resumed but restarted: the only way
  // back here with a complete capture is a deliberate re-run, and continuing
  // from a spent cursor walked the label again while adding to the old count —
  // 1,533 nodes walked on a 511-node label, and a coverage figure above 100%.
  const priorCapture = session.capture
  const resumable = priorCapture && priorCapture.fingerprint === fingerprint && !priorCapture.complete
  if (priorCapture && !resumable) {
    console.log(
      `[compute] capture: restarting the walk (${priorCapture.complete ? 're-run of a finished capture' : 'configuration changed'})`
    )
  }
  let capture: CaptureState = resumable
    ? priorCapture!
    : { cursorValue: null, cursorId: null, nodesWalked: 0, complete: false, fingerprint }

  const started = Date.now()
  for (;;) {
    if (signal.aborted) break

    const batchScores: PairScoreMap = new Map()
    const walked = await prefixBlockPairs(neo4jSession, { ...session, capture }, batchScores, signal)
    capture = walked.capture

    if (batchScores.size > 0) {
      // Only the nodes in this batch's pairs, so memory tracks the batch.
      const involved = new Set<string>()
      for (const { idA, idB } of batchScores.values()) { involved.add(idA); involved.add(idB) }
      await loadSnapshots(neo4jSession, involved, snapshotMap, signal)
      densify(session, batchScores, snapshotMap)

      const fields = fieldPresence(session, snapshotMap)
      const surfacedPairs: CandidatePair[] = []
      // Every scored candidate is stored, surfaced or not, so a threshold can
      // later be re-applied — including lowered — against what was actually
      // compared. Only surfaced pairs carry node snapshots: keeping them for
      // all of them costs 116 MB per pass on Company against 12 MB.
      let batchSurfaced = 0
      for (const [pairId, entry] of batchScores) {
        allScores.set(pairId, entry)
        const { idA, idB, scores, abstained } = entry
        const isSurfaced = surfaced(scores, session, idA, idB, fields, abstained)
        if (isSurfaced) batchSurfaced++
        surfacedPairs.push({
          id: pairId,
          sessionId: session.id,
          label: session.label,
          nodeA: isSurfaced ? snapshotMap.get(idA) ?? { id: idA, properties: {} } : { id: idA, properties: {} },
          nodeB: isSurfaced ? snapshotMap.get(idB) ?? { id: idB, properties: {} } : { id: idB, properties: {} },
          scores,
          verdict: 'pending',
          surfaced: isSurfaced,
        })
      }
      upsertPairs(surfacedPairs)
      surfacedTotal += batchSurfaced
      onProgress({
        metricId: 'capture',
        fieldName: session.blockingField ?? '',
        pct: capture.complete ? 100 : 0,
        pairsAbove: surfacedTotal,
      })
    }

    if (capture.complete) break
    if (allScores.size >= CAPTURE_CANDIDATE_BUDGET) break
    if (surfacedTotal >= CAPTURE_SURFACED_BUDGET) break
  }

  // Persist how far the walk reached, so the next pass resumes rather than
  // restarts. Written even when the pass was cancelled — the pairs it captured
  // are already in the queue, and re-walking them would find nothing new.
  saveSession({ ...session, capture, updatedAt: new Date().toISOString() })

  console.log(
    `[compute] capture: ${allScores.size.toLocaleString()} candidates, ${surfacedTotal} surfaced, ` +
      `${capture.nodesWalked.toLocaleString()} nodes walked, ` +
      `${capture.complete ? 'label complete' : 'more remaining'}, ${Date.now() - started}ms`
  )

  return {
    ...computeDistributions(allScores),
    candidates: {
      strategy: 'prefix',
      nodes: capture.nodesWalked,
      pairs: allScores.size,
      complete: capture.complete,
    },
  }
}

/** Which nodes carry each configured field, read from their snapshots. */
function fieldPresence(
  session: Session,
  snapshots: Map<string, NodeSnapshot>
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const fc of session.fields) {
    const ids = new Set<string>()
    for (const [id, snap] of snapshots) {
      if (snap.properties[fc.propertyName] !== undefined) ids.add(id)
    }
    m.set(fc.propertyName, ids)
  }
  return m
}

/**
 * Everything after candidates are chosen: fetch the properties of the nodes that
 * landed in a pair, fill in every score, apply the surfacing rule, persist.
 *
 * Shared so a strategy only has to decide which pairs are worth scoring. Prefix
 * blocking passes no fieldNodeIds because it never fetches per field — the sets
 * are derived from the snapshots instead, which report exactly the properties
 * each node carries.
 */
async function scoreAndSurface(
  neo4jSession: ReturnType<ReturnType<typeof getDriver>['session']>,
  session: Session,
  pairScores: PairScoreMap,
  candidates: CandidateSummary,
  fieldNodeIds?: Map<string, Set<string>>,
  signal?: AbortSignal
): Promise<ScoreDistributions> {
  const snapshotMap = new Map<string, NodeSnapshot>()
  const involved = new Set<string>()
  for (const { idA, idB } of pairScores.values()) { involved.add(idA); involved.add(idB) }
  const tSnap = Date.now()
  await loadSnapshots(neo4jSession, involved, snapshotMap, signal ?? new AbortController().signal)
  console.log(
    `[compute] snapshots: ${snapshotMap.size} of ${involved.size} nodes in ${Date.now() - tSnap}ms`
  )

  const fields =
    fieldNodeIds ??
    (() => {
      const m = new Map<string, Set<string>>()
      for (const fc of session.fields) {
        const ids = new Set<string>()
        for (const [id, snap] of snapshotMap) {
          if (snap.properties[fc.propertyName] !== undefined) ids.add(id)
        }
        m.set(fc.propertyName, ids)
      }
      return m
    })()

  const tDense = Date.now()
  const densified = densify(session, pairScores, snapshotMap)
  console.log(`[compute] densify: ${densified} scores filled in ${Date.now() - tDense}ms`)

  // Every scored candidate is stored, surfaced or not. Scores do not depend on
  // thresholds, so keeping the ones that fell short is what lets a threshold be
  // changed — including lowered — and re-applied against real candidates rather
  // than guessed at and rescanned. Only surfaced pairs carry node snapshots:
  // storing them for all would cost 116 MB per pass on Company against 12 MB.
  const allPairs: CandidatePair[] = []
  let surfacedCount = 0
  for (const [pairId, { idA, idB, scores, abstained }] of pairScores) {
    const isSurfaced = surfaced(scores, session, idA, idB, fields, abstained)
    if (isSurfaced) surfacedCount++
    allPairs.push({
      id: pairId,
      sessionId: session.id,
      label: session.label,
      nodeA: isSurfaced ? snapshotMap.get(idA) ?? { id: idA, properties: {} } : { id: idA, properties: {} },
      nodeB: isSurfaced ? snapshotMap.get(idB) ?? { id: idB, properties: {} } : { id: idB, properties: {} },
      scores,
      verdict: 'pending',
      surfaced: isSurfaced,
    })
  }
  console.log(
    `[compute] ${surfacedCount} pairs surfaced, ${allPairs.length - surfacedCount} kept for re-filtering`
  )

  let t = Date.now()
  upsertPairs(allPairs)
  console.log(`[compute] upsertPairs: ${Date.now() - t}ms`)

  t = Date.now()
  const dists = computeDistributions(pairScores)
  console.log(`[compute] computeDistributions: ${Date.now() - t}ms`)

  return { ...dists, candidates }
}

// Loads full property maps for a set of node ids, in batches.
export async function loadSnapshots(
  neo4jSession: ReturnType<ReturnType<typeof getDriver>['session']>,
  ids: Set<string>,
  into: Map<string, NodeSnapshot>,
  signal: AbortSignal
): Promise<void> {
  const all = [...ids]
  for (let i = 0; i < all.length; i += SNAPSHOT_BATCH_SIZE) {
    if (signal.aborted) return
    const batch = all.slice(i, i + SNAPSHOT_BATCH_SIZE)
    const result = await neo4jSession.run(
      'MATCH (n) WHERE elementId(n) IN $ids RETURN elementId(n) AS id, properties(n) AS props',
      { ids: batch }
    )
    for (const r of result.records) {
      const raw = (r.get('props') ?? {}) as Record<string, unknown>
      const properties: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) properties[k] = sanitize(v)
      into.set(r.get('id') as string, { id: r.get('id') as string, properties })
    }
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
  return applySurfacingRule(scores, session, (propertyName) => {
    if (abstained?.has(propertyName)) return false
    const ids = fieldNodeIds.get(propertyName)
    return ids !== undefined && ids.has(idA) && ids.has(idB)
  })
}

/**
 * The surfacing rule itself, separated from how comparability is established.
 *
 * A compute run knows which nodes carry which property and which metrics
 * declined; a re-filter reading pairs back from SQLite knows neither, but does
 * not need to. After densify() a field has a score row exactly when both nodes
 * carried it and some metric was willing to score it — the same condition — so
 * both callers can answer `comparable` from what they have and get the same
 * verdict out.
 */
export function applySurfacingRule(
  scores: MetricScore[],
  session: Session,
  comparable: (propertyName: string) => boolean
): boolean {
  const { mode, fields } = session.surfacingRule

  // Field score = max across metrics for that field
  const fieldScores = new Map<string, number>()
  for (const score of scores) {
    const current = fieldScores.get(score.fieldName) ?? 0
    fieldScores.set(score.fieldName, Math.max(current, score.score))
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
  // A field that cannot be judged is dropped from both sides of the ratio, so it
  // neither helps nor hurts. Leaving it only in the denominator would penalise a
  // pair for a comparison nothing was willing to make.
  //
  // This now covers a field one of the nodes does not carry, which previously
  // averaged in as a zero and so counted absent data as a mismatch. 'all' mode
  // already skipped those for exactly the reason stated above, and the two modes
  // disagreeing on what "cannot be judged" means is what made a re-filter unable
  // to reproduce compute's own verdict.
  const usable = fields.filter((fc) => comparable(fc.propertyName))
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

// Floor on the thinned sample.
//
// The thinning formula bounds scoring work but says nothing about statistical
// power, and on a dense field it thins the sample into uselessness. Measured on
// a 2.7M-node label whose rule reported 60.6M candidates: the formula chose 574
// nodes, which surfaced 9 pairs, and repeating that sample at five points in the
// store projected between 22M and 202M — a ninefold spread, Poisson noise on
// single-digit counts. At 2,000 nodes the same rule observed 127 pairs and at
// 5,000 it observed 670; those two agree within 9%.
//
// C(2000,2) is 2M comparisons — a few seconds rather than half of one. That cost
// buys the difference between a number worth acting on and one that is not.
const MIN_SCORED_NODES = 2_000

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
/**
 * Estimate the next capture pass by walking one batch from the session's cursor.
 *
 * The next pass starts at exactly that cursor, so local density is the right
 * thing to measure — this is a measurement of the run that will happen, not a
 * model of a different strategy.
 *
 * Extrapolating to the whole label is deliberately not attempted. Density varies
 * enough by region that probing Address at several lexical seeds put it anywhere
 * between 146 and 1,730 passes depending only on how many probes were taken and
 * how deep each went, while each extra probe seeks a cold part of the index for
 * 14-33s. Coverage after each real pass is reported from what was actually
 * walked and needs no estimate.
 */
async function estimatePrefixPass(
  neo4jSession: ReturnType<ReturnType<typeof getDriver>['session']>,
  session: Session,
  totalNodes: number
): Promise<PairEstimate> {
  const signal = new AbortController().signal
  const batchScores: PairScoreMap = new Map()
  // prefixBlockPairs persists nothing, so probing leaves the session's own
  // cursor untouched.
  const walked = await prefixBlockPairs(neo4jSession, session, batchScores, signal)
  if (walked.nodes === 0 || batchScores.size === 0) {
    return { count: 0, exact: false, candidates: 0, incremental: true, totalNodes, sampledNodes: walked.nodes }
  }

  const involved = new Set<string>()
  for (const { idA, idB } of batchScores.values()) { involved.add(idA); involved.add(idB) }
  const snapshots = new Map<string, NodeSnapshot>()
  await loadSnapshots(neo4jSession, involved, snapshots, signal)
  densify(session, batchScores, snapshots)
  const fields = fieldPresence(session, snapshots)

  let observed = 0
  for (const { idA, idB, scores, abstained } of batchScores.values()) {
    if (surfaced(scores, session, idA, idB, fields, abstained)) observed++
  }

  const candidatesPerNode = batchScores.size / walked.nodes
  const surfacedPerNode = observed / walked.nodes
  // Whichever budget binds first decides how far a pass gets.
  const byCandidates = CAPTURE_CANDIDATE_BUDGET / Math.max(candidatesPerNode, 1e-9)
  const bySurfaced = CAPTURE_SURFACED_BUDGET / Math.max(surfacedPerNode, 1e-9)
  const walkedSoFar = session.capture?.nodesWalked ?? 0
  const remaining = Math.max(0, totalNodes - walkedSoFar)
  const nodesPerPass = Math.max(1, Math.min(byCandidates, bySurfaced, remaining))

  console.log(
    `[estimate] prefix: ${walked.nodes} nodes probed, ${batchScores.size} candidates, ` +
      `${observed} surfaced -> ~${Math.round(nodesPerPass)} nodes/pass`
  )

  return {
    count: Math.round(surfacedPerNode * nodesPerPass),
    exact: false,
    candidates: Math.round(candidatesPerNode * nodesPerPass),
    observed,
    sampledNodes: walked.nodes,
    totalNodes,
    incremental: true,
  }
}

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

    // A prefix capture never builds a whole-label pair set, so projecting one
    // describes a run that will not happen — it reported 483,339,921 candidates
    // against the 5,000,000 ceiling for a session that then captured 30,217 in
    // 27 seconds. What is worth estimating is the next pass.
    if ((session.blockingStrategy ?? 'auto') === 'prefix') {
      return await estimatePrefixPass(neo4jSession, session, totalNodes)
    }

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
      // by the square root of how far over the limit we are — then never go
      // below the floor, however dense the field.
      const target = Math.floor(fetched.length * Math.sqrt(EXACT_CANDIDATE_LIMIT / candidates))
      sample = strideSample(fetched, Math.min(fetched.length, Math.max(MIN_SCORED_NODES, target)))
    }

    console.log(`[estimate] scoring ${sample.length} nodes across ${session.fields.length} fields`)
    t = Date.now()
    const count = await surfacedCount(session, sample)
    console.log(`[estimate] surfacedCount: ${count} in ${Date.now() - t}ms`)
    // Exact only when every node in the label was scored — both the fetch bound
    // and the candidate thinning have to have been no-ops.
    // Candidates grow roughly linearly with node count, not quadratically:
    // tokenBucketPairs drops any bucket over maxBucketSize, so past a certain
    // size the large buckets stop contributing and growth comes from the number
    // of medium ones. Measured on a 647,358-node label — 20,000 nodes gave 1.31M
    // candidates and the whole label 46.7M, against 32.4x the nodes. Scaling the
    // sample's count by the node ratio lands within 4%.
    //
    // Surfaced pairs scale quadratically over the same sample, because a pair is
    // only observed when both of its nodes are drawn. Two quantities, two laws.
    // Conflating them is what let a configuration pass the estimate and then be
    // refused by compute after a 101-second fetch.
    const projectedCandidates = Math.round(candidates * (totalNodes / fetched.length))

    if (sample.length === totalNodes) {
      return { count, exact: true, candidates, projectedCandidates: candidates }
    }

    const scale = pairCount(totalNodes) / pairCount(sample.length)
    return {
      count: Math.round(count * scale),
      exact: false,
      candidates,
      sampledNodes: sample.length,
      totalNodes,
      // Pairs actually seen. The scaled figure is only as good as this number,
      // and nothing else in the result reveals it.
      observed: count,
      projectedCandidates,
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
