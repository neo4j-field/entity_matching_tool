// A property may hold a list. The combine merge strategy produces them, and any
// graph may simply store several aliases for a thing.
//
// Metrics previously began `if (typeof a !== "string") return null`, so a
// list-valued property was never compared — and because a field where every
// metric declines is treated as unjudgeable, an All rule would silently drop it.
// On a real session that left 69 of 74 pairs judged on two fields instead of
// three, with the review panel still showing the third.
//
// Comparing the cross product and keeping the best score is the same thing as
// asking whether any pair of values meets the threshold, and it leaves
// scalar-to-scalar behaviour exactly as it was.

// A merge survivor gains a value each time it absorbs a conflicting one, and
// each value is another chance to match, which makes it easier to merge again.
// Cap the number that take part so that loop cannot run away, and so cost stays
// bounded at |a| x |b| comparisons.
export const MAX_LIST_VALUES = 10

/** Values of a property as a list, ignoring anything not of the wanted type. */
export function stringValues(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').slice(0, MAX_LIST_VALUES)
  return []
}

export function numericValues(v: unknown): number[] {
  if (typeof v === 'number') return [v]
  if (Array.isArray(v)) return v.filter((x): x is number => typeof x === 'number').slice(0, MAX_LIST_VALUES)
  return []
}

/**
 * Best score across every combination of the two sides' values.
 *
 * Returns null when either side has nothing comparable — an empty list, or a
 * type this metric cannot read. That is a genuine abstention and the caller
 * should treat it as one.
 */
export function bestOf<T>(a: T[], b: T[], score: (x: T, y: T) => number | null): number | null {
  let best: number | null = null
  for (const x of a) {
    for (const y of b) {
      const s = score(x, y)
      if (s === null) continue
      if (best === null || s > best) best = s
    }
  }
  return best
}
