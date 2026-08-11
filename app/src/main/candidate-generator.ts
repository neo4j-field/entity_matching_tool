// Ceiling on candidate pairs from a single metric on a single field.
//
// This has to be enforced here rather than by the caller. Candidate generation
// materialises every pair before returning, so a configuration wide enough to
// matter dies inside this function — on a 647k-node label a token metric hit
// V8's own ~16.7M-entry Set limit and threw "Set maximum size exceeded", which
// tells the user nothing about what they configured.
export const MAX_CANDIDATE_PAIRS = 5_000_000

export class CandidateLimitError extends Error {
  constructor() {
    super(
      `This configuration produces more than ${MAX_CANDIDATE_PAIRS.toLocaleString()} candidate pairs. ` +
        `Raise a threshold, remove a field, or drop a metric — Estimate Pair Count on the ` +
        `Configure screen predicts the count before a run.`
    )
    this.name = 'CandidateLimitError'
  }
}

export interface StringNode {
  id: string
  value: string
}

export function tokenize(s: string, mode: string): string[] {
  let out = s
  if (mode === 'whitespace-lowercase' || mode === 'alphanumeric') out = out.toLowerCase()
  if (mode === 'alphanumeric') out = out.replace(/[^a-z0-9\s]/g, ' ')
  return out.split(/\s+/).filter(Boolean)
}

/**
 * Returns all candidate (idA, idB) pairs that share at least one token.
 * Provides an upper bound on pairs that any string metric might score above threshold.
 * Pairs are returned as sorted tuples to avoid duplicates.
 */
export function tokenBucketPairs(nodes: StringNode[], maxBucketSize = 500): [string, string][] {
  const buckets = new Map<string, string[]>()
  for (const { id, value } of nodes) {
    // Distinct tokens only. "Las Vegas / LAS" tokenizes to two `las`, which
    // would put the id in that bucket twice and pair the node with itself.
    for (const tok of new Set(tokenize(value, 'whitespace-lowercase'))) {
      if (!buckets.has(tok)) buckets.set(tok, [])
      buckets.get(tok)!.push(id)
    }
  }

  const seen = new Set<string>()
  const pairs: [string, string][] = []

  for (const ids of buckets.values()) {
    if (ids.length < 2 || ids.length > maxBucketSize) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (ids[i] === ids[j]) continue
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`
        if (!seen.has(key)) {
          if (pairs.length >= MAX_CANDIDATE_PAIRS) throw new CandidateLimitError()
          seen.add(key)
          pairs.push(ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]])
        }
      }
    }
  }
  return pairs
}

/**
 * Upper bound on the candidate pairs, counted without building any of them.
 *
 * Sizing the candidate set by calling tokenBucketPairs and reading .length costs
 * memory proportional to the pairs themselves — a Set of `${idA}|${idB}` strings,
 * each about 85 characters once element ids are involved. On twenty thousand
 * multi-word values across a dozen fields that runs to gigabytes, which is how
 * the pair estimate exhausted the heap even after its fetch was bounded.
 *
 * A pair sharing several tokens is counted once per shared token, so this
 * overshoots. That is the safe direction: the number is only used to decide how
 * far to thin the sample, and overshooting thins harder.
 */
export function estimatePairCount(nodes: StringNode[], maxBucketSize = 500): number {
  const sizes = new Map<string, number>()
  for (const { value } of nodes) {
    for (const tok of new Set(tokenize(value, 'whitespace-lowercase'))) {
      sizes.set(tok, (sizes.get(tok) ?? 0) + 1)
    }
  }
  let total = 0
  for (const size of sizes.values()) {
    if (size < 2 || size > maxBucketSize) continue
    total += (size * (size - 1)) / 2
  }
  return total
}
