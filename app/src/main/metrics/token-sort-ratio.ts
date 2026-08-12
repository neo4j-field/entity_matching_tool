import { bestOf, stringValues } from './values'
import type { MetricModule, PairScore } from './types'
import { tokenize, tokenBucketPairs } from '../candidate-generator'

function sequenceRatio(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  // LCS-based ratio: 2 * lcs_length / (a.length + b.length)
  const m = a.length, n = b.length
  const dp = new Array(n + 1).fill(0)
  let lcs = 0
  for (let i = 1; i <= m; i++) {
    let prev = 0
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1])
      if (dp[j] > lcs) lcs = dp[j]
      prev = temp
    }
  }
  return (2 * lcs) / (m + n)
}

export const tokenSortRatio: MetricModule = {
  id: 'token-sort-ratio',
  displayName: 'Token Sort Ratio',
  description: 'Sorts tokens alphabetically then computes sequence ratio. Order-insensitive.',
  applicableTo: ['name'],
  defaultThreshold: 0.85,
  defaultParams: { tokenMode: 'whitespace-lowercase' },

  scorePair(a, b, params) {
    const mode = (params.tokenMode as string) ?? 'whitespace-lowercase'
    const norm = (v: string): string => tokenize(v, mode).sort().join(' ')
    return bestOf(stringValues(a), stringValues(b), (x, y) => sequenceRatio(norm(x), norm(y)))
  },

  async computePairScores(nodes, params, onProgress, signal) {
    const mode = (params.tokenMode as string) ?? 'whitespace-lowercase'
    const sorted = nodes
      .map((n) => ({
        id: n.id,
        val: typeof n.value === 'string'
          ? tokenize(n.value, mode).sort().join(' ')
          : null,
      }))
      .filter((n): n is { id: string; val: string } => n.val !== null)

    const candidates = tokenBucketPairs(sorted.map((s) => ({ id: s.id, value: s.val })))
    const byId = new Map(sorted.map((s) => [s.id, s.val]))
    const results: PairScore[] = []
    let done = 0

    for (const [idA, idB] of candidates) {
      if (signal?.aborted) break
      results.push({ idA, idB, score: sequenceRatio(byId.get(idA)!, byId.get(idB)!) })
      onProgress(++done / candidates.length)
    }
    return results
  },
}
