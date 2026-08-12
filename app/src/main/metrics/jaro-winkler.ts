import { bestOf, stringValues } from './values'
import type { MetricModule, PairScore } from './types'
import { tokenBucketPairs } from '../candidate-generator'

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1
  const matchDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1
  const s1Match = new Array(s1.length).fill(false)
  const s2Match = new Array(s2.length).fill(false)
  let matches = 0, transpositions = 0

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDist)
    const end = Math.min(i + matchDist + 1, s2.length)
    for (let j = start; j < end; j++) {
      if (s2Match[j] || s1[i] !== s2[j]) continue
      s1Match[i] = s2Match[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0

  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1Match[i]) continue
    while (!s2Match[k]) k++
    if (s1[i] !== s2[k]) transpositions++
    k++
  }
  return (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3
}

function jaroWinkler(s1: string, s2: string, p: number): number {
  const j = jaro(s1, s2)
  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++
    else break
  }
  return j + prefix * p * (1 - j)
}

export const jaroWinklerMetric: MetricModule = {
  id: 'jaro-winkler',
  displayName: 'Jaro-Winkler',
  description: 'Gives extra credit to common prefixes. Good for entity names.',
  applicableTo: ['name'],
  defaultThreshold: 0.85,
  defaultParams: { prefixWeight: 0.1 },

  scorePair(a, b, params) {
    const p = (params.prefixWeight as number) ?? 0.1
    return bestOf(stringValues(a), stringValues(b), (x, y) =>
      jaroWinkler(x.toLowerCase(), y.toLowerCase(), p)
    )
  },

  async computePairScores(nodes, params, onProgress, signal) {
    const p = (params.prefixWeight as number) ?? 0.1
    const items = nodes
      .map((n) => ({ id: n.id, values: stringValues(n.value).map((v) => v.toLowerCase()) }))
      .filter((n) => n.values.length > 0)

    const byId = new Map(items.map((s) => [s.id, s.values]))
    const candidates = tokenBucketPairs(items.map((s) => ({ id: s.id, value: s.values.join(' ') })))
    const results: PairScore[] = []
    let done = 0
    for (const [idA, idB] of candidates) {
      if (signal?.aborted) break
      const score = bestOf(byId.get(idA)!, byId.get(idB)!, (x, y) => jaroWinkler(x, y, p))
      if (score !== null) results.push({ idA, idB, score })
      onProgress(++done / candidates.length)
    }
    return results
  },
}
