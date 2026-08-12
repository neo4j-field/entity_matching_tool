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
    // One entry per value, so a node holding several takes part at each of
    // them. The same pair can then be reached more than once — through
    // different values — so keep the best score rather than emitting duplicates.
    const nums = nodes
      .flatMap((n) => numericValues(n.value).map((val) => ({ id: n.id, val })))
      .sort((a, b) => a.val - b.val)

    const best = new Map<string, PairScore>()
    let done = 0
    for (let i = 0; i < nums.length; i++) {
      if (signal?.aborted) break
      for (let j = i + 1; j < nums.length; j++) {
        if (nums[i].id === nums[j].id) continue
        const a = nums[i].val, b = nums[j].val
        const score = 1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1)
        if (score <= 0) break // sorted, so further pairs are worse
        const [idA, idB] = nums[i].id < nums[j].id ? [nums[i].id, nums[j].id] : [nums[j].id, nums[i].id]
        const key = `${idA}|${idB}`
        const prev = best.get(key)
        if (prev === undefined || score > prev.score) best.set(key, { idA, idB, score })
      }
      onProgress(++done / nums.length)
    }
    return [...best.values()]
  },
}
