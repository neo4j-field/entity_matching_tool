import { bestOf, stringValues } from './values'
import type { MetricModule, PairScore } from './types'
import { MAX_CANDIDATE_PAIRS, CandidateLimitError } from '../candidate-generator'

function normalize(s: string, mode: string): string {
  if (mode === 'none') return s
  let out = s.toLowerCase()
  if (mode === 'nfkd-lower-strip') {
    out = out.normalize('NFKD').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  return out
}

export const exactMatch: MetricModule = {
  id: 'exact-match',
  displayName: 'Exact Match',
  description: 'Score 1.0 when normalized strings are identical, 0.0 otherwise.',
  applicableTo: ['identifier', 'name'],
  defaultThreshold: 1.0,
  defaultParams: { normalization: 'nfkd-lower-strip' },

  scorePair(a, b, params) {
    const mode = (params.normalization as string) ?? 'nfkd-lower-strip'
    return bestOf(stringValues(a), stringValues(b), (x, y) =>
      normalize(x, mode) === normalize(y, mode) ? 1 : 0
    )
  },

  async computePairScores(nodes, params, onProgress, signal) {
    const mode = (params.normalization as string) ?? 'nfkd-lower-strip'
    // Group by normalized value — only pairs within the same bucket score 1.0.
    // A node holding several values joins a bucket for each of them.
    const buckets = new Map<string, string[]>()
    for (const n of nodes) {
      for (const norm of new Set(stringValues(n.value).map((v) => normalize(v, mode)))) {
        if (!buckets.has(norm)) buckets.set(norm, [])
        buckets.get(norm)!.push(n.id)
      }
    }
    const strings = nodes

    const results: PairScore[] = []
    let done = 0
    const total = strings.length
    for (const ids of buckets.values()) {
      if (signal?.aborted) break
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (results.length >= MAX_CANDIDATE_PAIRS) throw new CandidateLimitError()
          results.push({ idA: ids[i], idB: ids[j], score: 1.0 })
        }
      }
      done++
      onProgress(done / total)
    }
    return results
  },
}
