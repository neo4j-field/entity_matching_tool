import { bestOf, stringValues } from './values'
import type { MetricModule, PairScore } from './types'
import { tokenBucketPairs } from '../candidate-generator'

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
    }
  }
  return dp[n]
}

const DEFAULT_MIN_LEN = 3

// The ratio is a step function of string length: on a 4-character value a single
// edit costs a flat 0.25, on a 2-character value it costs 0.5. Below a few
// characters the score says more about length than similarity, so this metric
// abstains rather than reporting a number that cannot be thresholded sensibly.
function minLenOf(params: Record<string, unknown>): number {
  const raw = Number(params.minLen)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_LEN
}

export const editDistance: MetricModule = {
  id: 'edit-distance',
  displayName: 'Edit Distance (Levenshtein ratio)',
  description: '1 − edit_distance / max(len(a), len(b)). Good for short identifiers.',
  applicableTo: ['identifier', 'name'],
  defaultThreshold: 0.85,
  defaultParams: { minLen: DEFAULT_MIN_LEN },

  scorePair(a, b, params) {
    const minLen = minLenOf(params)
    return bestOf(stringValues(a), stringValues(b), (x, y) =>
      x.length < minLen || y.length < minLen
        ? null
        : 1 - levenshtein(x, y) / Math.max(x.length, y.length, 1)
    )
  },

  async computePairScores(nodes, params, onProgress, signal) {
    const minLen = minLenOf(params)
    // Bucket on every value the node holds, score across all of them. Joining
    // for the bucket key unions the tokens; the scoring below still sees the
    // values separately, so a list never gets compared as one run-on string.
    const items = nodes
      .map((n) => ({ id: n.id, values: stringValues(n.value).filter((v) => v.length >= minLen) }))
      .filter((n) => n.values.length > 0)

    const byId = new Map(items.map((s) => [s.id, s.values]))
    const candidates = tokenBucketPairs(items.map((s) => ({ id: s.id, value: s.values.join(' ') })))
    const results: PairScore[] = []
    let done = 0
    for (const [idA, idB] of candidates) {
      if (signal?.aborted) break
      const score = bestOf(byId.get(idA)!, byId.get(idB)!, (x, y) =>
        1 - levenshtein(x, y) / Math.max(x.length, y.length, 1)
      )
      if (score === null) continue
      results.push({ idA, idB, score })
      onProgress(++done / candidates.length)
    }
    return results
  },
}
