import type { FieldConfig, FieldSurfacingConfig } from './types'

/**
 * The identity of a field, as stored in `pair_scores.field_name`, in
 * `MetricScore.fieldName`, and in every map keyed by field.
 *
 * A field on the primary label keys as its bare property name; a field reached
 * over a pattern leg keys as `alias.property`.
 *
 * **Bare means primary, and that is load-bearing.** Every session written
 * before pattern legs existed stores bare names in its config and its score
 * rows. Qualifying primary fields too would orphan all of them, so the bare
 * form has to keep meaning exactly what it meant.
 *
 * Qualification is not cosmetic: `pair_scores` is
 * `PRIMARY KEY (pair_id, metric_id, field_name)`, so two labels in one pattern
 * that both carry `name` would collide on that key and silently overwrite one
 * score with the other. Same for `ERPairScore` in the graph write-back.
 */
export function fieldKey(field: { propertyName: string; legAlias?: string }): string {
  return field.legAlias ? `${field.legAlias}.${field.propertyName}` : field.propertyName
}

/** True when two field configurations denote the same field. */
export function sameField(
  a: FieldConfig | FieldSurfacingConfig,
  b: FieldConfig | FieldSurfacingConfig
): boolean {
  return fieldKey(a) === fieldKey(b)
}
