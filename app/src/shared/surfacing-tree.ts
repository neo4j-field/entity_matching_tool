import { fieldKey } from './field-key'
import type { RuleNode, SurfacingRule } from './types'

/**
 * Three-valued: a pair can pass a leaf, fail it, or be unjudgeable on it.
 *
 * `undefined` means the comparison was never possible — neither node carried
 * the property, or every metric declined it. That is not the same as failing,
 * and conflating the two is what #10 and #23 were both about.
 */
export type Verdict = boolean | undefined

/**
 * Evaluate a rule against one pair's scores.
 *
 * Unjudgeable children are ignored and the node is decided on the rest; a node
 * with nothing judged is itself unjudgeable. That is what stops an empty group,
 * or one whose every leaf is absent, from passing every pair — and it is what
 * `all` mode already did via its `compared > 0` guard.
 */
export function evaluateRule(
  node: RuleNode,
  fieldScores: Map<string, number>,
  comparable: (key: string) => boolean
): Verdict {
  if (node.kind === 'field') {
    const key = fieldKey(node)
    // A required field that cannot be judged is a failure, not an absence: the
    // condition asked for both records to carry it and they do not. Without
    // `required` it stays unknown and the enclosing group decides on the rest.
    if (!comparable(key)) return node.required ? false : undefined
    return (fieldScores.get(key) ?? 0) >= node.threshold
  }

  if (node.kind === 'weighted') {
    // Divide by the weights actually in play, so this is a mean rather than a
    // sum: weights drift away from totalling 1 whenever a field is removed or a
    // slider moves, and an unnormalised sum silently rescales the threshold.
    if (node.children.some((c) => c.required && !comparable(fieldKey(c)))) return false
    const usable = node.children.filter((c) => comparable(fieldKey(c)))
    const totalWeight = usable.reduce((sum, c) => sum + c.weight, 0)
    if (usable.length === 0 || totalWeight <= 0) return undefined
    const weighted = usable.reduce((sum, c) => sum + c.weight * (fieldScores.get(fieldKey(c)) ?? 0), 0)
    return weighted / totalWeight >= node.threshold
  }

  const known: boolean[] = []
  for (const child of node.children) {
    const v = evaluateRule(child, fieldScores, comparable)
    if (v !== undefined) known.push(v)
  }
  if (known.length === 0) return undefined
  return node.op === 'and' ? known.every(Boolean) : known.some(Boolean)
}

/**
 * The tree a rule denotes, converting the three legacy modes on the way.
 *
 * The conversion is exact rather than approximate:
 *   any              -> or(leaves)
 *   all              -> and(leaves)
 *   weighted-average -> weighted(leaves)
 *
 * `all`'s requirement that at least one field was comparable is not lost — it
 * falls out of "a node with no known children is unjudgeable".
 *
 * Converting on read means no session on disk is rewritten. Stored rules stay
 * in their original form until someone edits one.
 */
export function ruleTree(rule: SurfacingRule): RuleNode {
  if (rule.tree) return rule.tree

  if (rule.mode === 'weighted-average') {
    return {
      kind: 'weighted',
      threshold: rule.combinedThreshold ?? 0.85,
      children: rule.fields.map((f) => ({
        propertyName: f.propertyName,
        legAlias: f.legAlias,
        weight: f.weight,
        required: f.required,
      })),
    }
  }

  return {
    kind: 'group',
    op: rule.mode === 'any' ? 'or' : 'and',
    children: rule.fields.map((f) => ({
      kind: 'field' as const,
      propertyName: f.propertyName,
      legAlias: f.legAlias,
      threshold: f.threshold,
      required: f.required,
    })),
  }
}

/** One-line rendering, for prompts and for summarising a rule on screen. */
export function describeRule(node: RuleNode): string {
  if (node.kind === 'field') {
    const op = node.threshold >= 1 ? '=' : '≥'
    return `${fieldKey(node)} ${op} ${node.threshold.toFixed(2)}${node.required ? ' (required)' : ''}`
  }
  if (node.kind === 'weighted') {
    const parts = node.children.map((c) => `${fieldKey(c)}×${c.weight.toFixed(2)}`)
    return `weighted(${parts.join(', ')}) ≥ ${node.threshold.toFixed(2)}`
  }
  if (node.children.length === 0) return '(empty)'
  const joined = node.children.map(describeRule).join(node.op === 'and' ? ' AND ' : ' OR ')
  return node.children.length === 1 ? joined : `(${joined})`
}

/**
 * Every field a rule references, so callers can check the tree against the
 * fields the session actually scores. A leaf naming a field with no enabled
 * metric is never comparable, so it is unjudgeable for every pair — a rule that
 * silently surfaces nothing.
 */
export function ruleFieldKeys(node: RuleNode): string[] {
  if (node.kind === 'field') return [fieldKey(node)]
  if (node.kind === 'weighted') return node.children.map(fieldKey)
  return node.children.flatMap(ruleFieldKeys)
}

/**
 * Every leaf of a rule, with the threshold it tests.
 *
 * Used to report which leaves a sample could judge and which passed, because a
 * rule that surfaces nothing gives no clue on its own about which branch killed
 * it — and the two causes need opposite fixes. A leaf nothing could judge means
 * the field is not being compared, or its leg has no data; a leaf judged often
 * but never passed means the threshold is too strict for this data.
 */
export function ruleLeaves(node: RuleNode): { key: string; threshold: number }[] {
  if (node.kind === 'field') return [{ key: fieldKey(node), threshold: node.threshold }]
  if (node.kind === 'weighted') return node.children.map((c) => ({ key: fieldKey(c), threshold: node.threshold }))
  return node.children.flatMap(ruleLeaves)
}
