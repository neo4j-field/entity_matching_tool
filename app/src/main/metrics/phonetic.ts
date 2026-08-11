import type { MetricModule, PairScore } from './types'

// Double Metaphone — simplified single-code variant sufficient for entity names
function metaphone(word: string): string {
  const w = word.toUpperCase().replace(/[^A-Z]/g, '')
  if (!w) return ''
  let out = ''
  let i = 0
  const at = (n: number) => w[i + n] ?? ''

  while (i < w.length) {
    const c = w[i]
    if ('AEIOU'.includes(c)) { if (i === 0) out += c; i++; continue }
    switch (c) {
      case 'B': out += 'B'; break
      case 'C':
        if (at(1) === 'I' || at(1) === 'E' || at(1) === 'Y') out += 'S'
        else if (at(1) === 'H') { out += 'X'; i++ }
        else out += 'K'
        break
      case 'D':
        if (at(1) === 'G' && 'IEY'.includes(at(2))) { out += 'J'; i++ }
        else out += 'T'
        break
      case 'F': out += 'F'; break
      case 'G':
        if (at(1) === 'H' && !'AEIOU'.includes(at(2))) { i++; break }
        if ('IEY'.includes(at(1))) out += 'J'
        else out += 'K'
        break
      case 'H': if ('AEIOU'.includes(at(1))) out += 'H'; break
      case 'J': out += 'J'; break
      case 'K': if (at(-1) !== 'C') out += 'K'; break
      case 'L': out += 'L'; break
      case 'M': out += 'M'; break
      case 'N': out += 'N'; break
      case 'P': if (at(1) === 'H') { out += 'F'; i++ } else out += 'P'; break
      case 'Q': out += 'K'; break
      case 'R': out += 'R'; break
      case 'S':
        if (at(1) === 'H' || (at(1) === 'I' && (at(2) === 'O' || at(2) === 'A'))) { out += 'X'; i++ }
        else out += 'S'
        break
      case 'T':
        if (at(1) === 'H') { out += '0'; i++ }
        else if (at(1) === 'I' && (at(2) === 'A' || at(2) === 'O')) out += 'X'
        else out += 'T'
        break
      case 'V': out += 'F'; break
      case 'W': case 'Y': if ('AEIOU'.includes(at(1))) out += c; break
      case 'X': out += 'KS'; break
      case 'Z': out += 'S'; break
      default: out += c
    }
    i++
  }
  return out
}

export const phoneticMetric: MetricModule = {
  id: 'phonetic',
  displayName: 'Phonetic (Metaphone)',
  description: '1.0 if phonetic codes match, 0.0 otherwise. Catches spelling variations.',
  applicableTo: ['name', 'identifier'],
  defaultThreshold: 1.0,
  defaultParams: {},

  scorePair(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return null
    return metaphone(a) === metaphone(b) ? 1 : 0
  },

  async computePairScores(nodes, _params, onProgress, signal) {
    const coded = nodes
      .map((n) => ({
        id: n.id,
        code: typeof n.value === 'string' ? metaphone(n.value) : null,
      }))
      .filter((n): n is { id: string; code: string } => !!n.code)

    // Group by phonetic code — only same-code pairs score 1.0
    const buckets = new Map<string, string[]>()
    for (const { id, code } of coded) {
      if (!buckets.has(code)) buckets.set(code, [])
      buckets.get(code)!.push(id)
    }

    const results: PairScore[] = []
    let done = 0
    const total = coded.length
    for (const ids of buckets.values()) {
      if (signal?.aborted) break
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          results.push({ idA: ids[i], idB: ids[j], score: 1.0 })
      done++
      onProgress(done / total)
    }
    return results
  },
}
