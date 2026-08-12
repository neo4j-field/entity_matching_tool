// ─── AI Configuration Suggestion ─────────────────────────────────────────────

export interface AISuggestionField {
  propertyName: string
  enabled: boolean
  metrics: { metricId: string; threshold: number }[]
  reason: string
}

export interface AISuggestion {
  explanation: string
  fields: AISuggestionField[]
}

// ─── Schema ──────────────────────────────────────────────────────────────────

export type PropertyKind = 'identifier' | 'name' | 'text' | 'numeric' | 'boolean' | 'date' | 'other'

export interface PropertyMeta {
  name: string
  types: string[]
  mandatory: boolean
  inferredKind: PropertyKind
  sampleValues: unknown[]
}

export interface LabelMeta {
  name: string
  count: number
  properties: PropertyMeta[]
}

export interface RelTypeMeta {
  name: string
  startLabels: string[]
  endLabels: string[]
}

export interface SchemaModel {
  labels: LabelMeta[]
  relationshipTypes: RelTypeMeta[]
  discoveredAt: string // ISO string
  apocAvailable: boolean
}

// ─── Connection ───────────────────────────────────────────────────────────────

export interface ConnectionProfile {
  id: string
  name: string
  uri: string
  username: string
  database: string
}

export interface TestConnectionResult {
  ok: boolean
  latencyMs?: number
  nodeCount?: number
  relCount?: number
  apocAvailable?: boolean
  error?: string
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type SessionStatus = 'configuring' | 'computing' | 'reviewing' | 'merges-applied'
export type Verdict = 'pending' | 'duplicate' | 'distinct'
export type ReviewSort = 'score-desc' | 'score-asc' | 'recently-decided' | 'pending-first'

export interface ReviewFilter {
  verdict: 'all' | Verdict
}

export interface MetricConfig {
  metricId: string
  params: Record<string, unknown>
  threshold: number
}

export interface FieldConfig {
  propertyName: string
  metrics: MetricConfig[]
}

export interface FieldSurfacingConfig {
  propertyName: string
  threshold: number
  weight: number
}

export interface SurfacingRule {
  mode: 'any' | 'all' | 'weighted-average'
  fields: FieldSurfacingConfig[]
  combinedThreshold?: number
}

export interface MergePassSummary {
  id: string
  appliedAt: string // ISO
  groupsApplied: number
  groupsSkipped: number
  groupsFailed: number
}

export interface Session {
  id: string
  connectionId: string
  label: string
  fields: FieldConfig[]
  surfacingRule: SurfacingRule
  status: SessionStatus
  reviewCursor: number
  reviewFilter: ReviewFilter
  reviewSort: ReviewSort
  mergePasses: MergePassSummary[]
  createdAt: string
  updatedAt: string
}

// ─── Pairs ────────────────────────────────────────────────────────────────────

export interface NodeSnapshot {
  id: string
  properties: Record<string, unknown>
}

export interface MetricScore {
  metricId: string
  fieldName: string
  score: number
  aboveThreshold: boolean
}

export interface CandidatePair {
  id: string // sha1(sort([idA,idB]))[:12]
  sessionId: string
  label: string
  nodeA: NodeSnapshot
  nodeB: NodeSnapshot
  scores: MetricScore[]
  verdict: Verdict
  decidedAt?: string
  note?: string
  decidedBy?: DecidedBy | null
}

// ─── Score distributions ──────────────────────────────────────────────────────

export interface ScorePercentiles {
  metricId: string
  fieldName: string
  p50: number
  p75: number
  p90: number
  p95: number
  max: number
}

export interface ScoreDistributions {
  all: ScorePercentiles[]
  pending: ScorePercentiles[]
  candidates?: CandidateSummary
}

/**
 * How the run decided which pairs were worth scoring.
 *
 * This was previously invisible. A run either compared everything or compared
 * only pairs sharing a token — discarding any token shared by more than
 * `maxBucketSize` values — and nothing distinguished the two or reported what
 * the second had dropped. That is the single largest determinant of what
 * reaches the queue, so it belongs in the result rather than in a constant.
 */
export interface CandidateSummary {
  strategy: 'exhaustive' | 'token-bucket'
  nodes: number
  // Pairs that reached scoring.
  pairs: number
  // Only meaningful for 'exhaustive': every pair of the label was compared.
  complete: boolean
}

export interface PairEstimate {
  count: number
  // False when the count came from a node sample rather than the whole label.
  exact: boolean
  candidates: number
  sampledNodes?: number
  totalNodes?: number
  // Pairs surfaced within the sample, before scaling. The precision of `count`
  // follows roughly 1/sqrt(observed).
  observed?: number
  // Every pair the metrics would score across the whole label, before any
  // threshold. This is the quantity compute's ceiling applies to — not `count`,
  // which counts only pairs that pass the surfacing rule.
  projectedCandidates?: number

}

// ─── Merge ───────────────────────────────────────────────────────────────────

export interface MergeGroup {
  memberIds: string[] // elementIds
  memberTexts: string[]
  survivorId: string
  directlyComparedPairs: [string, string][]
  transitivePairs: [string, string][] // not directly reviewed
}

export interface MergeApplyResult {
  groupsApplied: number
  groupsSkipped: number
  groupsFailed: number
  passId: string
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface AppSettings {
  anthropicApiKey: string
  assistantModel: string
  excludedLabels: string[]
  theme: 'light' | 'dark' | 'system'
  useNeo4jStorage: boolean
  useNeo4jPairScores: boolean
  pricingOverrides: PricingOverrides
  classifyBatchSize: number
  classifyFewShotCount: number
  classifyCachedPrefix: boolean
  classifyConcurrency: number
}

// ─── LLM usage, cost, and telemetry ──────────────────────────────────────────

export interface ModelPricing {
  modelId: string
  displayName: string
  inputPerMTok: number
  outputPerMTok: number
  cacheWrite5mPerMTok: number
  cacheWrite1hPerMTok: number
  cacheReadPerMTok: number
  overridden?: boolean
}

export type PricingOverrides = Record<string, Partial<ModelPricing>>

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cacheCreation5mTokens?: number
  cacheCreation1hTokens?: number
}

export interface CostBreakdown {
  inputUsd: number
  outputUsd: number
  cacheWriteUsd: number
  cacheReadUsd: number
  totalUsd: number
  priced: boolean
  pricingVersion: string
}

export type LlmJobKind = 'auto-classify' | 'configure-suggest' | 'assistant-chat'

export interface LlmCallRecord {
  id: string
  jobId: string | null
  sessionId: string | null
  kind: LlmJobKind
  model: string
  startedAt: number
  durationMs: number
  tokens: TokenCounts
  cost: CostBreakdown
  ok: boolean
  error: string | null
  stopReason: string | null
  features: Record<string, number | string>
}

export interface UsageTotals {
  callCount: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUsd: number
  unpricedCallCount: number
}

export interface UsageSummary {
  totals: UsageTotals
  byKind: { kind: LlmJobKind; totals: UsageTotals }[]
  byModel: { model: string; totals: UsageTotals }[]
}

export interface JobEstimate {
  kind: LlmJobKind
  model: string
  unitCount: number
  callCount: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
  costLowUsd: number
  costHighUsd: number
  durationMsEstimate: number | null
  // 'history' = fitted from prior runs of this kind on this model.
  // 'history-other-model' = fitted from this kind on a different model.
  // 'prompt-size' = cold start, extrapolated from the prompts we are about to send.
  basis: 'history' | 'history-other-model' | 'prompt-size' | 'none'
  sampleSize: number
  priced: boolean
}

export interface ClassifyPlan {
  estimate: JobEstimate
  batchSize: number
  fewShotCount: number
  fewShotAvailable: number
  prefixTokens: number
  // Exact when counted via the token-counting endpoint; approximated from
  // characters when that call is unavailable.
  prefixTokensExact: boolean
  cacheFloor: number
  cacheRequested: boolean
  // False when the prefix is shorter than the model's floor, in which case the
  // breakpoint is silently ignored by the API.
  cacheEligible: boolean
  // Reviewed pairs available to draw examples from — the ceiling on how far
  // the worked-example count can usefully be raised.
  decidedPairCount: number
  // Examples needed to clear the floor. null when the prefix already caches, or
  // when there aren't enough reviewed pairs to get there.
  suggestedFewShotCount: number | null
  // A model whose floor this prefix already clears, cheapest first. null when
  // the current model is already the best available option.
  alternativeModel: { id: string; displayName: string; cacheFloor: number } | null
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export type DecidedBy = 'human' | 'ai'

export interface AuditRecord {
  id: string
  sessionId: string
  mergePassId: string
  timestamp: string
  label: string
  survivorId: string
  survivorProperties: Record<string, unknown>
  absorbedIds: string[]
  absorbedProperties: Record<string, unknown>[]
  scores: MetricScore[]
  conflictStrategy: 'discard' | 'overwrite' | 'combine'
  // How the pairs behind this merge were decided. A merge founded entirely on
  // AI verdicts is a materially different thing from one a human reviewed.
  decidedBy: { human: number; ai: number; unknown: number }
}
