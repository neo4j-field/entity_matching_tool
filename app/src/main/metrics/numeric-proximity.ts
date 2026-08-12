import { bestOf, numericValues } from './values'
import type { MetricModule, PairScore } from './types'

export const numericProximity: MetricModule = {
  id: 'numeric-proximity',
  displayName: 'Numeric Proximity',
  description: '1 − |a−b| / max(|a|,|b|,1). Good for numeric identifiers.',
  applicableTo: ['numeric'],
  defaultThreshold: 0.95,
  defaultParams: { relativeTolerance: 0.05 },

  scorePair(a, b) {
    return bestOf(numericValues(a), numericValues(b), (x, y) =>
      Math.max(0, 1 - Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1))
    )
  },

  async computePairScores(nodes, _params, onProgress, signal) {
    const nums = nodes
      .map((n) => ({ id: n.id, val: typeof n.value === 'number' ? n.value : null }))
      .filter((n): n is { id: string; val: number } => n.val !== null)
      .sort((a, b) => a.val - b.val)

    const results: PairScore[] = []
    let done = 0
    for (let i = 0; i < nums.length; i++) {
      if (signal?.aborted) break
      for (let j = i + 1; j < nums.length; j++) {
        const a = nums[i].val, b = nums[j].val
        const score = 1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1)
        if (score <= 0) break // sorted, so further pairs are worse
        results.push({ idA: nums[i].id, idB: nums[j].id, score: Math.max(0, score) })
      }
      onProgress(++done / nums.length)
    }
    return results
  },
}
