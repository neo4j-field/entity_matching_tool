import { bestOf, stringValues } from './values'
import type { MetricModule, PairScore } from './types'
import { tokenize, tokenBucketPairs } from '../candidate-generator'

export const tokenJaccard: MetricModule = {
  id: 'token-jaccard',
  displayName: 'Token Jaccard',
  description: '|intersection| / |union| of token sets. Order-insensitive.',
  applicableTo: ['name', 'text'],
  defaultThreshold: 0.70,
  defaultParams: { tokenMode: 'whitespace-lowercase', tokenizer: 'whitespace-lowercase' },

  scorePair(a, b, params) {
    const mode = (params.tokenMode as string) ?? 'whitespace-lowercase'
    return bestOf(stringValues(a), stringValues(b), (x, y) => {
      const ta = new Set(tokenize(x, mode))
      const tb = new Set(tokenize(y, mode))
      let inter = 0
      for (const tok of ta) if (tb.has(tok)) inter++
      const union = ta.size + tb.size - inter
      return union === 0 ? 0 : inter / union
    })
  },

  async computePairScores(nodes, params, onProgress, signal) {
    const mode = (params.tokenMode as string) ?? 'whitespace-lowercase'
    const tokenized = nodes
      .map((n) => ({ id: n.id, sets: stringValues(n.value).map((v) => new Set(tokenize(v, mode))) }))
      .filter((n) => n.sets.some((t) => t.size > 0))

    const candidates = tokenBucketPairs(
      tokenized.map((t) => ({ id: t.id, value: t.sets.flatMap((s) => [...s]).join(' ') }))
    )
    const byId = new Map(tokenized.map((t) => [t.id, t.sets]))
    const results: PairScore[] = []
    let done = 0

    for (const [idA, idB] of candidates) {
      if (signal?.aborted) break
      const score = bestOf(byId.get(idA)!, byId.get(idB)!, (a, b) => {
        let inter = 0
        for (const tok of a) if (b.has(tok)) inter++
        const union = a.size + b.size - inter
        return union === 0 ? 0 : inter / union
      })
      if (score !== null) results.push({ idA, idB, score })
      onProgress(++done / candidates.length)
    }
    return results
  },
}
