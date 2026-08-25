import { getMetric } from './metrics/registry'
import { fieldKey } from '../shared/field-key'
import type {
  CandidatePair,
  LabelMeta,
  ScorePercentiles,
  Session,
  Verdict,
} from '../shared/types'

// Short in-batch handles rather than pair UUIDs: cheaper in tokens and far
// easier for the model to echo back without transcription errors.
export function batchTag(index: number): string {
  return `P${index + 1}`
}

export interface BatchResult {
  tag: string
  verdict: Exclude<Verdict, 'pending'>
  reason: string
}

// Structured output makes the response shape a guarantee. Without it a single
// malformed line loses the whole batch rather than one pair.
export const BATCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'The pair handle, e.g. P3' },
          verdict: { type: 'string', enum: ['duplicate', 'distinct'] },
          reason: { type: 'string', description: 'One concise sentence of key evidence' },
        },
        required: ['tag', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

function formatProps(props: Record<string, unknown>): string {
  const entries = Object.entries(props)
  if (entries.length === 0) return '    (no properties)'
  return entries.map(([k, v]) => `    ${k}: ${String(v)}`).join('\n')
}

function formatScores(pair: CandidatePair): string {
  if (pair.scores.length === 0) return '    (no scores)'
  return pair.scores
    .map(
      (s) =>
        `    ${s.fieldName} · ${s.metricId}: ${s.score.toFixed(3)}${s.aboveThreshold ? ' ✓' : ''}`
    )
    .join('\n')
}

export function buildPairBlock(pair: CandidatePair, tag: string): string {
  return `[${tag}]
  Entity A:
${formatProps(pair.nodeA.properties)}
  Entity B:
${formatProps(pair.nodeB.properties)}
  Scores:
${formatScores(pair)}`
}

export function buildBatchMessage(pairs: CandidatePair[]): {
  text: string
  tagToPairId: Map<string, string>
} {
  const tagToPairId = new Map<string, string>()
  const blocks = pairs.map((pair, i) => {
    const tag = batchTag(i)
    tagToPairId.set(tag, pair.id)
    return buildPairBlock(pair, tag)
  })

  const text = `Classify each of the following ${pairs.length} candidate pair${
    pairs.length === 1 ? '' : 's'
  }. Return exactly one result per pair, using the pair handle shown in brackets.

${blocks.join('\n\n')}`

  return { text, tagToPairId }
}

// ─── Cached prefix ────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

// Distributions are computed at compute time but never persisted, so they are
// recomputed here from the session's own pairs.
function distributionsFor(pairs: CandidatePair[]): ScorePercentiles[] {
  const byKey = new Map<string, number[]>()
  for (const pair of pairs) {
    for (const s of pair.scores) {
      const key = `${s.metricId}|${s.fieldName}`
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key)!.push(s.score)
    }
  }

  return Array.from(byKey.entries()).map(([key, values]) => {
    const [metricId, fieldName] = key.split('|')
    const sorted = [...values].sort((a, b) => a - b)
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
}

// Deliberately deterministic: sorted inputs and a fixed stride, so the same
// session produces a byte-identical prefix and can reuse a warm cache across
// runs. Balanced across verdicts and spread over the score range rather than
// taking the first N, which would over-represent whatever the user reviewed
// first.
function selectFewShot(decided: CandidatePair[], count: number): CandidatePair[] {
  if (count <= 0 || decided.length === 0) return []

  const rank = (p: CandidatePair): number =>
    p.scores.reduce((max, s) => Math.max(max, s.score), 0)

  const bucket = (verdict: Verdict): CandidatePair[] =>
    decided
      .filter((p) => p.verdict === verdict)
      .sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))

  const spread = (list: CandidatePair[], take: number): CandidatePair[] => {
    if (take <= 0 || list.length === 0) return []
    if (list.length <= take) return list
    const stride = list.length / take
    return Array.from({ length: take }, (_, i) => list[Math.floor(i * stride)])
  }

  const dups = bucket('duplicate')
  const distincts = bucket('distinct')
  const half = Math.floor(count / 2)

  // Give the under-represented class whatever the other cannot fill.
  const takeDup = Math.min(dups.length, Math.max(half, count - distincts.length))
  const takeDistinct = Math.min(distincts.length, count - takeDup)

  return [...spread(dups, takeDup), ...spread(distincts, takeDistinct)].sort((a, b) =>
    a.id.localeCompare(b.id)
  )
}

function metricLines(session: Session): string {
  // session.fields only ever holds enabled fields — ConfigureScreen drops the
  // rest before saving.
  return session.fields
    .flatMap((f) =>
      f.metrics.map((m) => {
        let description = ''
        try {
          description = getMetric(m.metricId).description
        } catch {
          // A metric removed from the registry should degrade the prompt, not
          // break the run.
        }
        return `  - ${fieldKey(f)} · ${m.metricId} (threshold ${m.threshold})${
          description ? `: ${description}` : ''
        }`
      })
    )
    .join('\n')
}

export interface PrefixInput {
  session: Session
  labelMeta: LabelMeta | null
  allPairs: CandidatePair[]
  fewShotCount: number
}

export function buildPrefix(input: PrefixInput): {
  text: string
  fewShotUsed: number
  fewShotHuman: number
} {
  const { session, labelMeta, allPairs, fewShotCount } = input
  const decided = allPairs.filter((p) => p.verdict !== 'pending')

  // Prefer verdicts a human actually made. Filling the examples with the
  // classifier's own prior output would calibrate it against itself, so any
  // early bias compounds run over run instead of being corrected. AI verdicts
  // are still better than no examples, so they backfill rather than being
  // excluded — and the prompt below says which it got.
  const humanDecided = decided.filter((p) => p.decidedBy === 'human')
  const examples = selectFewShot(humanDecided, fewShotCount)
  const fewShotHuman = examples.length
  if (examples.length < fewShotCount) {
    const chosen = new Set(examples.map((p) => p.id))
    examples.push(
      ...selectFewShot(
        decided.filter((p) => p.decidedBy !== 'human' && !chosen.has(p.id)),
        fewShotCount - examples.length
      )
    )
  }

  const fieldTypes = session.fields
    .map((f) => {
      const types = labelMeta?.properties.find((p) => p.name === f.propertyName)?.types
      return `  - ${fieldKey(f)} (${types?.join(', ') ?? 'String'})`
    })
    .join('\n')

  const dists = distributionsFor(allPairs)
  const distLines = dists
    .map(
      (d) =>
        `  - ${d.fieldName} · ${d.metricId}: p50=${d.p50.toFixed(2)} p75=${d.p75.toFixed(
          2
        )} p90=${d.p90.toFixed(2)} p95=${d.p95.toFixed(2)} max=${d.max.toFixed(2)}`
    )
    .join('\n')

  const sections: string[] = [
    `You are an entity resolution expert working on a Neo4j knowledge graph. You decide whether two candidate nodes describe the same real-world entity.

For each pair you are given, return a verdict of "duplicate" or "distinct" and one concise sentence naming the key evidence. Judge on the evidence in the properties; the similarity scores are a signal, not a verdict. Two records can score highly and still be distinct entities (a parent company and its subsidiary, two people sharing a name), and can score poorly and still be the same entity (an abbreviation, a former name, a typo).`,

    `## Dataset

Label: ${session.label}${labelMeta?.count !== undefined ? ` (${labelMeta.count} nodes)` : ''}

Compared properties:
${fieldTypes || '  (none)'}

Active metrics:
${metricLines(session) || '  (none)'}`,
  ]

  if (distLines) {
    sections.push(`## Score calibration

Percentiles across all ${allPairs.length} candidate pairs in this dataset. Use these to judge what counts as a high or low score *here* — a score at or below p50 is unremarkable, and only scores near the top of the range are strong evidence.

${distLines}`)
  }

  if (examples.length > 0) {
    const exampleBlocks = examples
      .map((pair, i) => {
        const note = (pair.note ?? '').replace(/^\[AI\]\s*/, '').trim()
        return `${buildPairBlock(pair, `E${i + 1}`)}
  Verdict: ${pair.verdict}${note ? `\n  Reasoning: ${note}` : ''}`
      })
      .join('\n\n')

    const aiCount = examples.length - fewShotHuman
    const provenance =
      aiCount === 0
        ? 'All of these were decided by the human reviewer working on this exact dataset. Match their standard.'
        : fewShotHuman === 0
          ? 'These were decided by an automated classifier on this dataset, not by a human. Treat them as a guide to the conventions in use, not as ground truth — judge each new pair on its own evidence.'
          : `${fewShotHuman} of these were decided by the human reviewer working on this exact dataset; the remaining ${aiCount} came from an automated classifier and are a weaker signal. Weight the human decisions more heavily.`

    sections.push(`## Worked examples from this dataset

${provenance}

${exampleBlocks}`)
  }

  return { text: sections.join('\n\n'), fewShotUsed: examples.length, fewShotHuman }
}

// ─── Response handling ────────────────────────────────────────────────────────

export interface ParsedResult {
  pairId: string
  verdict: Exclude<Verdict, 'pending'>
  reason: string
}

// Returns only results that map to a pair we actually asked about. Anything
// missing or unrecognised is left for the caller to retry individually.
export function parseBatchResponse(
  raw: string,
  tagToPairId: Map<string, string>
): { results: ParsedResult[]; unresolvedTags: string[] } {
  const results: ParsedResult[] = []
  const seen = new Set<string>()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    return { results: [], unresolvedTags: [...tagToPairId.keys()] }
  }

  const items = (parsed as { results?: unknown }).results
  if (Array.isArray(items)) {
    for (const item of items) {
      const r = item as Record<string, unknown>
      const tag = typeof r.tag === 'string' ? r.tag.trim() : ''
      const verdict = typeof r.verdict === 'string' ? r.verdict.trim().toLowerCase() : ''
      const pairId = tagToPairId.get(tag)
      if (!pairId || seen.has(tag)) continue
      if (verdict !== 'duplicate' && verdict !== 'distinct') continue
      seen.add(tag)
      results.push({
        pairId,
        verdict,
        reason: typeof r.reason === 'string' ? r.reason.trim() : '',
      })
    }
  }

  const unresolvedTags = [...tagToPairId.keys()].filter((t) => !seen.has(t))
  return { results, unresolvedTags }
}

// Structured output should return bare JSON, but a model that falls back to
// prose still usually wraps it in a fence.
function stripFences(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1] : trimmed
}
