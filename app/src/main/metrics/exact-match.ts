import { bestOf, stringValues } from './values'
import type { MetricModule, PairScore } from './types'
import { MAX_CANDIDATE_PAIRS, CandidateLimitError } from '../candidate-generator'

// Two rules, both of which the previous implementation got wrong outside ASCII.
//
// `\w` is [A-Za-z0-9_] in JavaScript, so every Cyrillic, Greek, Arabic, Hebrew,
// CJK, Thai and Devanagari character counted as punctuation and was replaced by
// a space. After collapsing, a non-Latin value normalised to the empty string —
// and two empty strings are equal, so Exact Match scored 1.000 for Moscow
// against Tokyo. Unicode-aware classes fix that.
//
// NFKD then decomposes an accented letter into a base plus a combining mark, and
// that mark was itself replaced by a space, splitting the word: "Zürich" became
// "zu rich" and so failed to match "Zurich" — close to the canonical case
// normalisation exists to handle. Marks are now removed rather than spaced.
//
// Every ASCII case is unchanged, so Latin-only data behaves exactly as before.
function normalize(s: string, mode: string): string {
  if (mode === 'none') return s
  const out = s.toLowerCase()
  if (mode !== 'nfkd-lower-strip') return out
  return out
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
