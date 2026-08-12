import { isDate, isDateTime, isDuration, isLocalDateTime, isLocalTime, isPoint, isTime } from 'neo4j-driver'

/**
 * Safely converts any Neo4j integer representation to a plain JS number.
 * Handles: native BigInt (driver v6), neo4j.Integer custom type (driver v4/v5),
 * and plain JS numbers (passthrough).
 */
export function toJsNumber(val: unknown): number {
  if (typeof val === 'number') return val
  if (typeof val === 'bigint') return Number(val)
  if (val !== null && typeof val === 'object') {
    const v = val as Record<string, unknown>
    if (typeof v['toNumber'] === 'function') {
      return (v['toNumber'] as () => number)()
    }
  }
  return Number(val)
}

// Temporal and spatial values are objects whose meaning lives entirely in their
// prototype's toString(). Structured clone strips the prototype, so by the time
// one reaches the renderer it is a bag of {low, high} pairs and displays as
// "[object Object]" — a Date carrying 2012-09-11 arrived as
// {year:{low:2012,high:0},month:{low:9,high:0},day:{low:11,high:0}}. Convert
// while the prototype is still attached, which is only true here in main.
function temporalOrSpatialToString(val: object): string | null {
  if (
    isDate(val) || isDateTime(val) || isLocalDateTime(val) ||
    isTime(val) || isLocalTime(val) || isDuration(val) || isPoint(val)
  ) {
    return String(val)
  }
  return null
}

/**
 * Recursively sanitizes a value returned from Neo4j so it is safe to send
 * over IPC (structured clone) or use in arithmetic. Converts neo4j.Integer /
 * BigInt leaves to plain JS numbers, and temporal and spatial values to their
 * string form.
 */
export function sanitize(val: unknown): unknown {
  if (typeof val === 'bigint') return Number(val)
  if (val === null || val === undefined) return val
  if (typeof val === 'object') {
    const v = val as Record<string, unknown>
    if (typeof v['toNumber'] === 'function') {
      return (v['toNumber'] as () => number)()
    }
    const asText = temporalOrSpatialToString(val)
    if (asText !== null) return asText
    if (Array.isArray(val)) return (val as unknown[]).map(sanitize)
    // A plain object still reaching here holds unconverted Integer leaves.
    const out: Record<string, unknown> = {}
    for (const [k, inner] of Object.entries(v)) out[k] = sanitize(inner)
    return out
  }
  return val
}
