import { useState, useEffect, type ReactElement } from 'react'
import { useStore } from '../store'
import { fieldKey } from '../../../shared/field-key'
import { describeRule, ruleFieldKeys, ruleTree } from '../../../shared/surfacing-tree'
import { METRICS, suggestMetrics, getMetricDef } from '../lib/metrics'
import { formatUsd, summarizeTokens } from '../lib/usage'
import { MAX_CANDIDATE_PAIRS } from '../../../shared/constants'
import type {
  LabelMeta,
  FieldConfig,
  MetricConfig,
  SurfacingRule,
  LlmCallRecord,
  PropertyKind,
  PatternLeg,
  RuleNode,
  PairEstimate,
  BlockingStrategy,
} from '../../../shared/types'

type Step = 'label' | 'fields' | 'surfacing'

interface DraftMetric {
  metricId: string
  params: Record<string, unknown>
  threshold: number
}

interface DraftField {
  propertyName: string
  // Absent for a property of the primary label; otherwise the leg it came from.
  legAlias?: string
  enabled: boolean
  metrics: DraftMetric[]
  kind: string
}

// A leg the user has added, with whether the database actually has data for it.
// db.schema.visualization() reports label-pair combinations rather than only
// observed ones, so roughly one in eight matches nothing — configuring one of
// those produces a session that surfaces no pairs and reports no error.
interface DraftLeg extends PatternLeg {
  status: 'checking' | 'live' | 'empty'
}

const SKIP_KINDS = ['boolean']

// Compute holds one value per node per field for the whole run — measured at
// roughly 250 bytes per node, down from ~1KB when it also held every node's
// full property map. Warn past the point where that gets uncomfortable, and
// require an explicit choice past the point where V8's ~4GB heap ceiling makes
// failure the likely outcome.
//
// Thresholds are deliberately unchanged from when the per-node cost was four
// times higher. Node count is no longer the binding constraint — candidate
// pairs are, and compute refuses past five million of those — so loosening
// these buys headroom against the wrong axis.
const HEAVY_LABEL_NODES = 500_000
const EXTREME_LABEL_NODES = 2_000_000
const BYTES_PER_NODE = 250

// A sampled count is an extrapolation, and its precision follows roughly
// 1/sqrt(observed) — the pairs actually seen, not the pairs projected. Ten
// observations carry about a third of a digit of information, so print one
// significant figure; a hundred or more earns a second.
function roundSampled(n: number, observed: number | undefined): string {
  if (n < 100) return n.toLocaleString()
  const digits = observed !== undefined && observed < 100 ? 1 : 2
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - (digits - 1))
  return (Math.round(n / mag) * mag).toLocaleString()
}


// ── Rule editor ───────────────────────────────────────────────────────────────

interface RuleEditorProps {
  node: RuleNode
  options: { key: string; propertyName: string; legAlias?: string }[]
  onChange: (next: RuleNode) => void
  onRemove?: () => void
  depth?: number
}

function newLeaf(options: RuleEditorProps['options']): RuleNode {
  const first = options[0]
  return {
    kind: 'field',
    propertyName: first?.propertyName ?? '',
    legAlias: first?.legAlias,
    threshold: 0.85,
  }
}

function RuleEditor({ node, options, onChange, onRemove, depth = 0 }: RuleEditorProps): ReactElement {
  if (node.kind === 'field') {
    const known = options.some((o) => o.key === fieldKey(node))
    return (
      <div className="flex items-center gap-2 py-1">
        <select
          value={fieldKey(node)}
          onChange={(e) => {
            const opt = options.find((o) => o.key === e.target.value)
            if (opt) onChange({ ...node, propertyName: opt.propertyName, legAlias: opt.legAlias })
          }}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
        >
          {!known && <option value={fieldKey(node)}>{fieldKey(node)} (not compared)</option>}
          {options.map((o) => <option key={o.key} value={o.key}>{o.key}</option>)}
        </select>
        <span className="text-gray-500 text-xs">≥</span>
        <input
          type="number" min={0} max={1} step={0.01} value={node.threshold}
          onChange={(e) => onChange({ ...node, threshold: Number(e.target.value) })}
          className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
        />
        {/* A leaf naming a field with no enabled metric never receives a score,
            so it is unjudgeable for every pair and the rule silently surfaces
            nothing. The rule editor and the field editor are separate screens,
            which is what makes this easy to do by accident. */}
        {!known && <span className="text-amber-400 text-xs">⚠ this field is not being compared</span>}
        {onRemove && <button onClick={onRemove} className="text-gray-600 hover:text-gray-300 text-xs">×</button>}
      </div>
    )
  }

  if (node.kind === 'weighted') {
    return (
      <div className="border border-gray-800 rounded-lg px-3 py-2 space-y-1 bg-gray-950/50">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-sky-300 font-medium">Weighted average</span>
          <span className="text-gray-500">≥</span>
          <input
            type="number" min={0} max={1} step={0.01} value={node.threshold}
            onChange={(e) => onChange({ ...node, threshold: Number(e.target.value) })}
            className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
          />
          <div className="flex-1" />
          {/* Same failure as an empty group: nothing to average is unjudgeable,
              so the node can never be true. */}
          {node.children.length === 0 && <span className="text-amber-400 text-xs">⚠ empty — nothing can satisfy this</span>}
          {onRemove && <button onClick={onRemove} className="text-gray-600 hover:text-gray-300 text-xs">×</button>}
        </div>
        {node.children.map((c, i) => (
          <div key={`${fieldKey(c)}-${i}`} className="flex items-center gap-2 pl-3 py-0.5">
            <span className="text-xs text-gray-300 font-mono">{fieldKey(c)}</span>
            <span className="text-gray-600 text-xs">weight</span>
            <input
              type="number" min={0} step={0.05} value={c.weight}
              onChange={(e) => {
                const children = [...node.children]
                children[i] = { ...c, weight: Number(e.target.value) }
                onChange({ ...node, children })
              }}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
            />
            <button
              onClick={() => onChange({ ...node, children: node.children.filter((_, j) => j !== i) })}
              className="text-gray-600 hover:text-gray-300 text-xs"
            >×</button>
          </div>
        ))}
        <button
          onClick={() => {
            const first = options[0]
            if (!first) return
            onChange({ ...node, children: [...node.children, { propertyName: first.propertyName, legAlias: first.legAlias, weight: 0.5 }] })
          }}
          className="text-xs text-gray-500 hover:text-gray-300 pl-3"
        >+ field</button>
      </div>
    )
  }

  const setChild = (i: number, next: RuleNode): void => {
    const children = [...node.children]
    children[i] = next
    onChange({ ...node, children })
  }

  return (
    <div className={`rounded-lg border px-3 py-2 space-y-1 ${depth % 2 === 0 ? 'border-gray-800 bg-gray-950/40' : 'border-gray-700 bg-gray-900/40'}`}>
      <div className="flex items-center gap-2">
        <div className="flex rounded overflow-hidden border border-gray-700">
          {(['and', 'or'] as const).map((op) => (
            <button
              key={op}
              onClick={() => onChange({ ...node, op })}
              className={`px-2 py-0.5 text-xs ${node.op === op ? 'bg-emerald-900 text-emerald-300' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}
            >
              {op === 'and' ? 'ALL of' : 'ANY of'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* A group with nothing in it is unjudgeable, so it can never be true. */}
        {node.children.length === 0 && <span className="text-amber-400 text-xs">⚠ empty — nothing can satisfy this</span>}
        {onRemove && <button onClick={onRemove} className="text-gray-600 hover:text-gray-300 text-xs">×</button>}
      </div>

      <div className="pl-3 space-y-1">
        {node.children.map((child, i) => (
          <RuleEditor
            key={i}
            node={child}
            options={options}
            depth={depth + 1}
            onChange={(next) => setChild(i, next)}
            onRemove={() => onChange({ ...node, children: node.children.filter((_, j) => j !== i) })}
          />
        ))}
        <div className="flex gap-2 pt-0.5">
          <button
            onClick={() => onChange({ ...node, children: [...node.children, newLeaf(options)] })}
            className="text-xs text-gray-500 hover:text-gray-300"
          >+ field</button>
          <button
            onClick={() => onChange({ ...node, children: [...node.children, { kind: 'group', op: 'and', children: [] }] })}
            className="text-xs text-gray-500 hover:text-gray-300"
          >+ group</button>
          <button
            onClick={() => onChange({ ...node, children: [...node.children, { kind: 'weighted', threshold: 0.85, children: [] }] })}
            className="text-xs text-gray-500 hover:text-gray-300"
          >+ weighted average</button>
        </div>
      </div>
    </div>
  )
}

export default function ConfigureScreen() {
  const { schema, connection, session, settings, setSession, setScreen, setPairs, setDistributions, addToast } = useStore()
  const [step, setStep] = useState<Step>('label')
  const [selectedLabel, setSelectedLabel] = useState<LabelMeta | null>(null)
  const [fields, setFields] = useState<DraftField[]>([])
  const [legs, setLegs] = useState<DraftLeg[]>([])
  const [surfacingMode, setSurfacingMode] = useState<'any' | 'all' | 'weighted-average' | 'custom'>('any')
  // Only set in 'custom'. The three named modes stay as they were, and are what
  // a session stores unless someone builds an expression.
  const [ruleNode, setRuleNode] = useState<RuleNode | null>(null)
  const [fieldSurfacing, setFieldSurfacing] = useState<Record<string, { threshold: number; weight: number }>>({})
  const [combinedThreshold, setCombinedThreshold] = useState(0.85)
  const [blocking, setBlocking] = useState<BlockingStrategy>('auto')
  const [blockingField, setBlockingField] = useState<string>('')
  const [prefixLength, setPrefixLength] = useState(8)
  const [estimate, setEstimate] = useState<PairEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [creating, setCreating] = useState(false)
  const [acceptLargeLabel, setAcceptLargeLabel] = useState(false)
  const [expandedMetric, setExpandedMetric] = useState<string | null>(null)
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [aiExplanation, setAiExplanation] = useState<string | null>(null)
  const [aiReasons, setAiReasons] = useState<Record<string, string>>({})
  const [aiCall, setAiCall] = useState<LlmCallRecord | null>(null)

  const hasApiKey = Boolean(settings?.anthropicApiKey)
  const weightTotal = Object.values(fieldSurfacing).reduce((sum, cfg) => sum + cfg.weight, 0)

  // A prefix predicate has to touch the raw property, so it needs an index that
  // supports a range seek. Anything else means a full label scan per node.
  const seekable = (selectedLabel?.properties ?? []).filter((p) =>
    p.indexes?.some((k) => k === 'RANGE' || k === 'TEXT')
  )
  // semantic-cosine scores whole sets rather than single pairs, and prefix
  // blocking scores pair by pair, so the two cannot be combined.
  const setScoringMetrics = fields
    .filter((f) => f.enabled)
    .flatMap((f) => f.metrics.filter((m) => m.metricId === 'semantic-cosine').map(() => f.propertyName))

  const labelNodes = selectedLabel?.count ?? 0
  const projectedGb = (labelNodes * BYTES_PER_NODE) / 1_073_741_824
  const isExtremeLabel = labelNodes >= EXTREME_LABEL_NODES
  // The size gate guards a memory cost prefix blocking does not incur — it holds
  // one batch, not the label — so gating it there would disable Start on exactly
  // the labels the strategy exists for, behind a checkbox no longer shown.
  const blockedByLabelSize = isExtremeLabel && blocking !== 'prefix' && !acceptLargeLabel
  // Compute refuses this combination, so refuse it here rather than letting the
  // run fail partway through.
  const blockedByStrategy = blocking === 'prefix' && setScoringMetrics.length > 0

  useEffect(() => {
    const off = window.api.usage.onCall((record) => {
      if (record.kind === 'configure-suggest') setAiCall(record)
    })
    return () => { off() }
  }, [])

  // Pre-populate from an existing session when coming from the review screen for a re-run
  const isRerun = Boolean(session && (session.status === 'reviewing' || session.status === 'merges-applied'))
  const [reapplying, setReapplying] = useState(false)

  useEffect(() => {
    if (!isRerun || !schema) return
    const labelMeta = schema.labels.find((l) => l.name === session!.label)
    if (!labelMeta) return

    setSelectedLabel(labelMeta)

    // Show every comparable property, not just the ones the session kept —
    // otherwise a field deselected on an earlier pass can never be selected again.
    // Restore the pattern first: a saved related field has to find its leg.
    const savedLegs: DraftLeg[] = (session!.legs ?? []).map((l) => ({ ...l, status: 'live' }))
    setLegs(savedLegs)

    const saved = new Map(session!.fields.map((fc) => [fieldKey(fc), fc]))
    const fromSaved = (fc: FieldConfig, kind: PropertyKind): DraftField => ({
      propertyName: fc.propertyName,
      legAlias: fc.legAlias,
      enabled: true,
      kind,
      metrics: fc.metrics.map((m) => ({ metricId: m.metricId, params: { ...m.params }, threshold: m.threshold })),
    })

    const draft: DraftField[] = labelMeta.properties
      .filter((p) => !SKIP_KINDS.includes(p.inferredKind))
      .map((p) => {
        const fc = saved.get(p.name)
        if (fc) return fromSaved(fc, p.inferredKind)
        const suggested = suggestMetrics(p.inferredKind)
        return {
          propertyName: p.name,
          enabled: false,
          kind: p.inferredKind,
          metrics: suggested.map((m) => ({
            metricId: m.id,
            params: { ...m.defaultParams },
            threshold: m.defaultThreshold,
          })),
        }
      })

    // Every property of each saved leg, so a related field deselected on an
    // earlier pass can be selected again — the same reason the primary label
    // lists all of its properties rather than only the kept ones.
    for (const leg of savedLegs) {
      const legLabel = schema?.labels.find((l) => l.name === leg.label)
      for (const prop of legLabel?.properties ?? []) {
        if (SKIP_KINDS.includes(prop.inferredKind)) continue
        const key = `${leg.alias}.${prop.name}`
        const fc = saved.get(key)
        if (fc) { draft.push(fromSaved(fc, prop.inferredKind)); continue }
        const suggested = suggestMetrics(prop.inferredKind)
        draft.push({
          propertyName: prop.name, legAlias: leg.alias, enabled: false, kind: prop.inferredKind,
          metrics: suggested.map((m) => ({ metricId: m.id, params: { ...m.defaultParams }, threshold: m.defaultThreshold })),
        })
      }
    }

    // A saved field the schema no longer reports still has verdicts riding on it.
    for (const fc of session!.fields) {
      if (!draft.some((d) => fieldKey(d) === fieldKey(fc))) draft.push(fromSaved(fc, 'name'))
    }
    setFields(draft)

    const sf: Record<string, { threshold: number; weight: number }> = {}
    for (const f of session!.surfacingRule.fields) {
      sf[fieldKey(f)] = { threshold: f.threshold, weight: f.weight ?? (1 / session!.surfacingRule.fields.length) }
    }
    setFieldSurfacing(sf)
    setBlocking(session!.blockingStrategy ?? 'auto')
    setBlockingField(session!.blockingField ?? '')
    setPrefixLength(session!.blockingPrefixLength ?? 8)
    if (session!.surfacingRule.tree) {
      setRuleNode(session!.surfacingRule.tree)
      setSurfacingMode('custom')
    } else {
      setSurfacingMode(session!.surfacingRule.mode)
    }
    if (session!.surfacingRule.combinedThreshold != null) {
      setCombinedThreshold(session!.surfacingRule.combinedThreshold)
    }
    setStep('fields')
  }, [])

  const labels = schema?.labels.filter((l) => {
    const excluded = ['__Entity__', '__KGBuilder__', 'Document', 'Chunk', '_Bloom_Perspective_', '_Bloom_Scene_']
    return !excluded.includes(l.name)
  }) ?? []

  function selectLabel(label: LabelMeta) {
    setSelectedLabel(label)
    // Initialize fields from label properties
    const draft: DraftField[] = label.properties
      .filter((p) => !SKIP_KINDS.includes(p.inferredKind))
      .map((p) => {
        const suggested = suggestMetrics(p.inferredKind)
        return {
          propertyName: p.name,
          enabled: suggested.length > 0,
          kind: p.inferredKind,
          metrics: suggested.map((m) => ({
            metricId: m.id,
            params: { ...m.defaultParams },
            threshold: m.defaultThreshold,
          })),
        }
      })
    setFields(draft)
    // Initialize surfacing per-field configs
    const sf: Record<string, { threshold: number; weight: number }> = {}
    for (const f of draft) {
      sf[fieldKey(f)] = { threshold: 0.8, weight: 1 / Math.max(draft.length, 1) }
    }
    setFieldSurfacing(sf)
    setStep('fields')
  }

  // Legs available from the primary label, in either direction. Both ends are
  // offered because the useful relationship is as often incoming — an Address
  // that companies point at, an Officer who points at companies.
  const availableLegs = (schema?.relPatterns ?? []).flatMap((pat) => {
    const out: { relType: string; direction: 'out' | 'in'; label: string }[] = []
    if (pat.startLabel === selectedLabel?.name) out.push({ relType: pat.relType, direction: 'out', label: pat.endLabel })
    if (pat.endLabel === selectedLabel?.name) out.push({ relType: pat.relType, direction: 'in', label: pat.startLabel })
    return out
  }).filter((cand) => !legs.some((l) =>
    l.relType === cand.relType && l.direction === cand.direction && l.label === cand.label
  ))

  // The alias namespaces this leg's field keys and is stored in every score row,
  // so it has to be unique and stable. Derived from the label rather than typed,
  // to keep it out of the user's hands once anything is scored.
  function aliasFor(label: string): string {
    const base = label.charAt(0).toLowerCase() + label.slice(1)
    if (!legs.some((l) => l.alias === base)) return base
    let n = 2
    while (legs.some((l) => l.alias === `${base}${n}`)) n++
    return `${base}${n}`
  }

  async function addLeg(cand: { relType: string; direction: 'out' | 'in'; label: string }): Promise<void> {
    const leg: DraftLeg = { ...cand, alias: aliasFor(cand.label), status: 'checking' }
    setLegs((prev) => [...prev, leg])

    const labelMeta = schema?.labels.find((l) => l.name === cand.label)
    setFields((prev) => [
      ...prev,
      ...(labelMeta?.properties ?? [])
        .filter((prop) => !SKIP_KINDS.includes(prop.inferredKind))
        .map((prop) => {
          const suggested = suggestMetrics(prop.inferredKind)
          return {
            propertyName: prop.name,
            legAlias: leg.alias,
            enabled: false,
            kind: prop.inferredKind,
            metrics: suggested.map((m) => ({
              metricId: m.id, params: { ...m.defaultParams }, threshold: m.defaultThreshold,
            })),
          }
        }),
    ])

    const startLabel = cand.direction === 'out' ? selectedLabel!.name : cand.label
    const endLabel = cand.direction === 'out' ? cand.label : selectedLabel!.name
    let live = false
    try {
      live = await window.api.schema.validatePattern({ relType: cand.relType, startLabel, endLabel })
    } catch {
      live = false
    }
    setLegs((prev) => prev.map((l) => (l.alias === leg.alias ? { ...l, status: live ? 'live' : 'empty' } : l)))
  }

  function removeLeg(alias: string): void {
    setLegs((prev) => prev.filter((l) => l.alias !== alias))
    setFields((prev) => prev.filter((f) => f.legAlias !== alias))
  }

  function toggleField(key: string) {
    setFields((prev) => prev.map((f) => fieldKey(f) === key ? { ...f, enabled: !f.enabled } : f))
  }

  function toggleMetric(fieldName: string, metricId: string) {
    setFields((prev) => prev.map((f) => {
      if (fieldKey(f) !== fieldName) return f
      const hasIt = f.metrics.some((m) => m.metricId === metricId)
      if (hasIt) {
        return { ...f, metrics: f.metrics.filter((m) => m.metricId !== metricId) }
      } else {
        const def = getMetricDef(metricId)!
        return { ...f, metrics: [...f.metrics, { metricId, params: { ...def.defaultParams }, threshold: def.defaultThreshold }] }
      }
    }))
  }

  function setMetricParam(fieldName: string, metricId: string, key: string, value: unknown) {
    setFields((prev) => prev.map((f) => {
      if (fieldKey(f) !== fieldName) return f
      return {
        ...f,
        metrics: f.metrics.map((m) => m.metricId === metricId ? { ...m, params: { ...m.params, [key]: value } } : m),
      }
    }))
  }

  function setMetricThreshold(fieldName: string, metricId: string, threshold: number) {
    setFields((prev) => prev.map((f) => {
      if (fieldKey(f) !== fieldName) return f
      return {
        ...f,
        metrics: f.metrics.map((m) => m.metricId === metricId ? { ...m, threshold } : m),
      }
    }))
  }

  function goToSurfacing() {
    const enabled = fields.filter((f) => f.enabled && f.metrics.length > 0)
    if (enabled.length === 0) {
      addToast('Enable at least one field with a metric', 'error')
      return
    }
    // Rescale the weights of the surviving fields back to a sum of 1, keeping
    // their relative sizes. Carrying stale weights forward is what let a session
    // end up with five fields at 1/9 each, whose total could never reach the
    // combined threshold.
    const priorTotal = enabled.reduce((sum, f) => sum + (fieldSurfacing[fieldKey(f)]?.weight ?? 0), 0)
    const sf: Record<string, { threshold: number; weight: number }> = {}
    for (const f of enabled) {
      const cfg = fieldSurfacing[fieldKey(f)]
      sf[fieldKey(f)] = {
        threshold: cfg?.threshold ?? 0.8,
        weight: cfg && priorTotal > 0 ? cfg.weight / priorTotal : 1 / enabled.length,
      }
    }
    setFieldSurfacing(sf)
    setStep('surfacing')
  }

  async function runEstimate() {
    if (!selectedLabel) return
    setEstimating(true)
    setEstimate(null)
    try {
      // We need a temp session ID to estimate; create a temp draft session
      const draft = buildSessionPartial()
      const session = await window.api.session.create(draft)
      const result = await window.api.schema.estimatePairs(session.id)
      // Clean up: delete the temp session
      await window.api.session.delete(session.id)
      setEstimate(result)
    } catch (err) {
      addToast(`Estimate failed: ${(err as Error).message}`, 'error')
    } finally {
      setEstimating(false)
    }
  }

  function buildSessionPartial() {
    const enabledFields = fields.filter((f) => f.enabled && f.metrics.length > 0)
    const fieldConfigs: FieldConfig[] = enabledFields.map((f) => ({
      propertyName: f.propertyName,
      legAlias: f.legAlias,
      metrics: f.metrics as MetricConfig[],
    }))

    const sfFields = enabledFields.map((f) => ({
      propertyName: f.propertyName,
      legAlias: f.legAlias,
      threshold: fieldSurfacing[fieldKey(f)]?.threshold ?? 0.8,
      weight: fieldSurfacing[fieldKey(f)]?.weight ?? (1 / enabledFields.length),
    }))

    const surfacingRule: SurfacingRule = {
      // mode and fields stay populated even for a custom rule: they are what an
      // older build, and ruleTree(), fall back to when no tree is present.
      mode: surfacingMode === 'custom' ? 'all' : surfacingMode,
      fields: sfFields,
      combinedThreshold: surfacingMode === 'weighted-average' ? combinedThreshold : undefined,
      tree: surfacingMode === 'custom' && ruleNode ? ruleNode : undefined,
    }

    return {
      connectionId: connection!.id,
      label: selectedLabel!.name,
      fields: fieldConfigs,
      surfacingRule,
      blockingStrategy: blocking,
      blockingField: blocking === 'prefix' ? blockingField || seekable[0]?.name : undefined,
      blockingPrefixLength: blocking === 'prefix' ? prefixLength : undefined,
      // Only legs with data. A leg the schema offers but the graph has nothing
      // for would contribute no scores and no error.
      legs: legs.filter((l) => l.status === 'live').map(({ alias, relType, direction, label }) => ({
        alias, relType, direction, label,
      })),
      status: 'configuring' as const,
      reviewCursor: 0,
      reviewFilter: { verdict: 'all' as const },
      reviewSort: 'pending-first' as const,
      mergePasses: [],
    }
  }

  async function suggestWithAI() {
    if (!selectedLabel) return
    setAiSuggesting(true)
    setAiExplanation(null)
    setAiReasons({})
    try {
      const props = selectedLabel.properties.map((p) => ({
        name: p.name,
        kind: p.inferredKind,
        sampleValues: (p.sampleValues ?? []).map(String),
      }))
      const suggestion = await window.api.configure.suggest(selectedLabel.name, props)

      const reasonMap: Record<string, string> = {}
      setFields((prev) => prev.map((f) => {
        const s = suggestion.fields.find((sf) => sf.propertyName === f.propertyName)
        if (!s) return f
        reasonMap[f.propertyName] = s.reason
        return {
          ...f,
          enabled: s.enabled,
          metrics: s.enabled
            ? s.metrics
                .filter((m) => getMetricDef(m.metricId))
                .map((m) => ({
                  metricId: m.metricId,
                  params: { ...(getMetricDef(m.metricId)!.defaultParams) },
                  threshold: m.threshold,
                }))
            : f.metrics,
        }
      }))
      setAiReasons(reasonMap)
      setAiExplanation(suggestion.explanation)
    } catch (err) {
      addToast(`AI suggestion failed: ${(err as Error).message}`, 'error')
    } finally {
      setAiSuggesting(false)
    }
  }

  // Thresholds and the surfacing rule are questions about scores already stored,
  // not a reason to walk the label again. Re-applying them is a SQLite pass:
  // instant, and the only way a threshold can be *lowered* to see what appears
  // without discarding the capture and starting over.
  async function reapplyThresholds(): Promise<void> {
    if (!session) return
    setReapplying(true)
    try {
      const partial = buildSessionPartial()
      const updated = {
        ...session,
        fields: partial.fields,
        surfacingRule: partial.surfacingRule,
        updatedAt: new Date().toISOString(),
      }
      await window.api.session.save(updated)
      const result = await window.api.pairs.refilter(session.id)
      setSession(updated)
      setPairs(await window.api.pairs.list(session.id))
      const repaired = result.repaired > 0 ? `, ${result.repaired} refreshed from the graph` : ''
      const kept = result.keptForVerdict > 0 ? `, ${result.keptForVerdict} kept for their verdict` : ''
      addToast(
        `${result.surfaced.toLocaleString()} pairs in the queue — ${result.added} added, ${result.removed} removed${kept}${repaired}`,
        'success'
      )
      setScreen('review')
    } catch (err) {
      addToast(`Could not re-apply: ${(err as Error).message}`, 'error')
    } finally {
      setReapplying(false)
    }
  }

  async function startCompute() {
    setCreating(true)
    try {
      let activeSession
      // Update whenever we already hold a session, not only when it has been
      // reviewed. A session is created before compute runs, so a compute that
      // fails leaves one behind in 'configuring' with no pairs — and pressing
      // Start Compute again used to create another. Four failed attempts made
      // four identical sessions. Starting genuinely fresh clears the store
      // first (newSession), so a session here is always the one being edited.
      if (session) {
        // Update the existing session in-place — preserves all pair verdicts
        const partial = buildSessionPartial()
        activeSession = {
          ...session,
          fields: partial.fields,
          surfacingRule: partial.surfacingRule,
          blockingStrategy: partial.blockingStrategy,
          blockingField: partial.blockingField,
          blockingPrefixLength: partial.blockingPrefixLength,
          legs: partial.legs,
          updatedAt: new Date().toISOString(),
        }
        await window.api.session.save(activeSession)
      } else {
        activeSession = await window.api.session.create(buildSessionPartial())
      }
      setSession(activeSession)
      setPairs([])
      setDistributions(null)
      setScreen('compute')
    } catch (err) {
      addToast(`Failed to start compute: ${(err as Error).message}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  const enabledFieldCount = fields.filter((f) => f.enabled && f.metrics.length > 0).length

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto py-10 px-6 space-y-8">

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-sm">
          {(['label', 'fields', 'surfacing'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <span className="text-gray-600">›</span>}
              <button
                onClick={() => {
                  if (s === 'label') setStep('label')
                  if (s === 'fields' && selectedLabel) setStep('fields')
                }}
                className={`font-medium capitalize ${step === s ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'}`}
              >
                {s === 'label' ? '1. Label' : s === 'fields' ? '2. Fields & Metrics' : '3. Surfacing Rule'}
              </button>
            </div>
          ))}
        </div>

        {/* Step 1: Label selection */}
        {step === 'label' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white">Select Entity Label</h2>
              <p className="text-gray-400 text-sm mt-1">Choose which node label to deduplicate.</p>
            </div>
            {labels.length === 0 ? (
              <p className="text-gray-500">No labels found in schema.</p>
            ) : (
              <div className="grid gap-2">
                {labels.map((l) => (
                  <button
                    key={l.name}
                    onClick={() => selectLabel(l)}
                    className="flex items-center justify-between bg-gray-900 hover:bg-gray-800 border border-gray-800 hover:border-gray-700 rounded-xl px-5 py-4 text-left transition-colors group"
                  >
                    <div>
                      <div className="font-medium text-white group-hover:text-emerald-400 transition-colors">
                        {l.name}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {l.properties.length} properties
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold text-gray-400">{l.count.toLocaleString()}</div>
                      <div className="text-xs text-gray-600">nodes</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Fields & Metrics */}
        {step === 'fields' && selectedLabel && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h2 className="text-xl font-bold text-white">{selectedLabel.name} · Fields & Metrics</h2>
                <p className="text-gray-400 text-sm mt-1">
                  Toggle the checkbox on each property you want to compare.
                  Active metrics are shown as pills — click to add or remove them.
                  Adjust the threshold for each metric, then click <span className="text-white">Next</span>.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {hasApiKey ? (
                  <button
                    onClick={suggestWithAI}
                    disabled={aiSuggesting}
                    className="btn-secondary text-xs px-3 flex items-center gap-1.5 disabled:opacity-60"
                  >
                    {aiSuggesting ? (
                      <><span className="inline-block animate-spin">↻</span> Analyzing…</>
                    ) : (
                      <>✦ Ask AI to suggest</>
                    )}
                  </button>
                ) : (
                  <span className="text-xs text-gray-600" title="Add an Anthropic API key in Settings to enable AI suggestions">
                    ✦ AI suggest (needs API key)
                  </span>
                )}
                <button onClick={() => setStep('label')} className="btn-ghost text-xs">← Back</button>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <p className="text-xs text-gray-400">
                <span className="text-gray-300 font-medium">
                  Thresholds on this screen do not decide which pairs you review.
                </span>{' '}
                They mark a score as a match — the ✓ and the bar colours in the review panel — and
                they are given to the AI as context when it classifies. Which pairs enter the queue
                is decided entirely by the <span className="text-gray-300">Surfacing Rule</span> on
                the next step. You can also re-tune these against the real score distribution after
                computing.
              </p>
            </div>

            {aiExplanation && (
              <div className="bg-indigo-950 border border-indigo-800 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-indigo-300 flex items-center gap-1.5">✦ AI Suggestion</span>
                  <button
                    onClick={() => { setAiExplanation(null); setAiReasons({}) }}
                    className="text-xs text-indigo-600 hover:text-indigo-400"
                  >
                    Dismiss
                  </button>
                </div>
                <p className="text-sm text-indigo-200 leading-relaxed">{aiExplanation}</p>
                {aiCall && (
                  <p className="text-xs text-indigo-500 pt-1 border-t border-indigo-900">
                    {aiCall.model} · {summarizeTokens(aiCall.tokens)} ·{' '}
                    <span className="text-indigo-300">
                      {aiCall.cost.priced ? formatUsd(aiCall.cost.totalUsd) : 'unpriced model'}
                    </span>
                  </p>
                )}
              </div>
            )}

            {/* Related nodes. Fields from one hop away join the same rule; only
                the primary label ever merges. */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-white">Related nodes</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Compare on properties one hop away as well — an address, a ticker, a parent
                  company. Only {selectedLabel.name} nodes are ever merged; related nodes supply
                  values to compare and nothing else.
                </p>
              </div>

              {legs.map((leg) => (
                <div key={leg.alias} className="flex items-center gap-2 text-xs bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
                  <span className="font-mono text-gray-300">
                    ({selectedLabel.name}){leg.direction === 'out' ? '-' : '<-'}[:{leg.relType}]{leg.direction === 'out' ? '->' : '-'}({leg.label})
                  </span>
                  <span className="text-gray-600">as</span>
                  <span className="text-sky-300">{leg.alias}</span>
                  {leg.status === 'checking' && <span className="text-gray-500">checking…</span>}
                  {leg.status === 'live' && <span className="text-emerald-400">✓ has data</span>}
                  {leg.status === 'empty' && (
                    <span className="text-amber-400" title="The schema reports this shape but no nodes are connected this way, so it would contribute nothing">
                      ⚠ no data — will be ignored
                    </span>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => removeLeg(leg.alias)} className="text-gray-500 hover:text-gray-300">remove</button>
                </div>
              ))}

              {/* Multi-labelled nodes make one relationship look like several
                  legs: on a test database PREVIOUSLY_NAMED->Company and
                  PREVIOUSLY_NAMED->PreviousName are the same 647,358 edges,
                  because every PreviousName node is also a Company. Selecting
                  both counts one piece of evidence twice, which matters most
                  under a weighted average. */}
              {legs.some((a, i) => legs.some((b, j) => i < j && a.relType === b.relType && a.direction === b.direction)) && (
                <p className="text-xs text-amber-400">
                  ⚠ Two legs use the same relationship in the same direction. If the labels overlap —
                  nodes carrying both — these reach the same nodes, and their fields would count the
                  same evidence twice.
                </p>
              )}

              {availableLegs.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {availableLegs.map((cand) => (
                    <button
                      key={`${cand.relType}|${cand.direction}|${cand.label}`}
                      onClick={() => addLeg(cand)}
                      className="text-xs font-mono px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
                    >
                      + {cand.direction === 'out' ? '' : '←'}{cand.relType} ({cand.label})
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-600">
                  {legs.length > 0
                    ? 'No further relationships available from this label.'
                    : 'The schema reports no relationships from this label.'}
                </p>
              )}
            </div>

            {fields.length === 0 && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 px-6 py-8 text-center space-y-2">
                <p className="text-white font-medium">No comparable properties found</p>
                <p className="text-gray-400 text-sm">
                  The schema query returned no string or numeric properties for{' '}
                  <span className="text-emerald-400">{selectedLabel.name}</span>.
                  Check that your nodes have at least one non-boolean property, then reconnect to refresh the schema.
                </p>
              </div>
            )}

            {fields.map((field) => {
              // A related field's property metadata lives on its own label.
              const ownerLabel = field.legAlias
                ? schema?.labels.find((l) => l.name === legs.find((g) => g.alias === field.legAlias)?.label)
                : selectedLabel
              const propMeta = ownerLabel?.properties.find((p) => p.name === field.propertyName)
              // For properties whose kind couldn't be determined, fall back to name-applicable metrics
              const applicableMetrics = METRICS.filter((m) =>
                m.applicableTo.includes((field.kind === 'other' ? 'name' : field.kind) as never)
              )
              return (
                <div key={fieldKey(field)} className={`bg-gray-900 rounded-xl border transition-colors ${field.enabled ? 'border-gray-700' : 'border-gray-800 opacity-60'}`}>
                  <div className="flex items-center gap-3 px-5 py-4">
                    <input
                      type="checkbox"
                      checked={field.enabled}
                      onChange={() => toggleField(fieldKey(field))}
                      className="w-4 h-4 accent-emerald-500"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {field.legAlias && (
                          <span className="text-xs px-1.5 py-0.5 bg-sky-950 border border-sky-800 rounded text-sky-300">
                            {legs.find((g) => g.alias === field.legAlias)?.label ?? field.legAlias}
                          </span>
                        )}
                        <span className="font-medium text-white">{field.propertyName}</span>
                        <span className="text-xs px-1.5 py-0.5 bg-gray-800 rounded text-gray-400">{field.kind}</span>
                        {propMeta?.mandatory && (
                          <span className="text-xs px-1.5 py-0.5 bg-amber-900 rounded text-amber-300">required</span>
                        )}
                        {aiReasons[field.propertyName] && (
                          <span className="text-xs px-1.5 py-0.5 bg-indigo-950 border border-indigo-800 rounded text-indigo-400">✦ AI</span>
                        )}
                      </div>
                      {aiReasons[field.propertyName] ? (
                        <div className="text-xs text-indigo-400 mt-0.5">{aiReasons[field.propertyName]}</div>
                      ) : propMeta?.sampleValues && propMeta.sampleValues.length > 0 ? (
                        <div className="text-xs text-gray-600 mt-0.5 truncate">
                          e.g. {propMeta.sampleValues.slice(0, 3).map(String).join(', ')}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {field.enabled && (
                    <div className="border-t border-gray-800 px-5 py-4 space-y-3">
                      {/* Metric checkboxes */}
                      <div className="flex flex-wrap gap-2">
                        {applicableMetrics.map((m) => {
                          const active = field.metrics.some((fm) => fm.metricId === m.id)
                          return (
                            <button
                              key={m.id}
                              onClick={() => toggleMetric(field.propertyName, m.id)}
                              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                                active
                                  ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
                                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                              }`}
                              title={m.description}
                            >
                              {m.displayName}
                            </button>
                          )
                        })}
                        {applicableMetrics.length === 0 && (
                          <span className="text-xs text-gray-600">No metrics available for kind &ldquo;{field.kind}&rdquo;</span>
                        )}
                      </div>

                      {/* Active metric controls */}
                      {field.metrics.map((fm) => {
                        const def = getMetricDef(fm.metricId)
                        if (!def) return null
                        const key = `${fieldKey(field)}:${fm.metricId}`
                        const expanded = expandedMetric === key
                        return (
                          <div key={fm.metricId} className="bg-gray-950 rounded-lg p-3 space-y-2">
                            <div className="flex items-center gap-3">
                              <span className="text-xs font-medium text-gray-300 flex-1">{def.displayName}</span>
                              <label className="flex items-center gap-2 text-xs text-gray-400">
                                Threshold
                                <input
                                  type="number"
                                  min={0}
                                  max={1}
                                  step={0.01}
                                  value={fm.threshold}
                                  onChange={(e) => setMetricThreshold(field.propertyName, fm.metricId, parseFloat(e.target.value))}
                                  className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
                                />
                              </label>
                              {def.paramSchema && Object.keys(def.paramSchema).length > 0 && (
                                <button
                                  onClick={() => setExpandedMetric(expanded ? null : key)}
                                  className="text-xs text-gray-500 hover:text-gray-300"
                                >
                                  {expanded ? 'Hide params' : 'Params…'}
                                </button>
                              )}
                            </div>
                            {expanded && def.paramSchema && (
                              <div className="space-y-2 pt-1">
                                {Object.entries(def.paramSchema).map(([pkey, pdef]) => (
                                  <label key={pkey} className="flex items-center gap-2 text-xs text-gray-400">
                                    <span className="w-36 shrink-0">{pdef.label}</span>
                                    {pdef.type === 'select' ? (
                                      <select
                                        value={String(fm.params[pkey] ?? '')}
                                        onChange={(e) => setMetricParam(field.propertyName, fm.metricId, pkey, e.target.value)}
                                        className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
                                      >
                                        {pdef.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                                      </select>
                                    ) : pdef.type === 'number' ? (
                                      <input
                                        type="number"
                                        min={pdef.min}
                                        max={pdef.max}
                                        step={pdef.step}
                                        value={Number(fm.params[pkey] ?? 0)}
                                        onChange={(e) => setMetricParam(field.propertyName, fm.metricId, pkey, parseFloat(e.target.value))}
                                        className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
                                      />
                                    ) : (
                                      <input
                                        type="text"
                                        value={String(fm.params[pkey] ?? '')}
                                        onChange={(e) => setMetricParam(field.propertyName, fm.metricId, pkey, e.target.value)}
                                        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
                                      />
                                    )}
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            <div className="pt-2">
              <button
                onClick={goToSurfacing}
                disabled={enabledFieldCount === 0}
                className="btn-primary"
              >
                Next: Surfacing Rule →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Surfacing Rule */}
        {step === 'surfacing' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">Surfacing Rule</h2>
                <p className="text-gray-400 text-sm mt-1">
                  A pair enters the review queue when its scores satisfy this rule.
                </p>
              </div>
              <button onClick={() => setStep('fields')} className="btn-ghost text-xs">← Back</button>
            </div>

            {/* Mode selector */}
            <div className="flex gap-2">
              {(['any', 'all', 'weighted-average', 'custom'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    // Seed the expression from the mode on screen, so switching
                    // to Custom starts from the rule you already had rather than
                    // from nothing. The three modes are exact special cases.
                    if (mode === 'custom' && !ruleNode) {
                      setRuleNode(ruleTree({
                        mode: surfacingMode === 'custom' ? 'all' : surfacingMode,
                        fields: fields
                          .filter((f) => f.enabled && f.metrics.length > 0)
                          .map((f) => ({
                            propertyName: f.propertyName,
                            legAlias: f.legAlias,
                            threshold: fieldSurfacing[fieldKey(f)]?.threshold ?? 0.8,
                            weight: fieldSurfacing[fieldKey(f)]?.weight ?? 0.5,
                          })),
                        combinedThreshold,
                      }))
                    }
                    setSurfacingMode(mode)
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    surfacingMode === mode
                      ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
                      : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {mode === 'any' ? 'Any field'
                    : mode === 'all' ? 'All fields'
                    : mode === 'weighted-average' ? 'Weighted average'
                    : 'Custom rule'}
                </button>
              ))}
            </div>

            {surfacingMode === 'custom' && ruleNode && (
              <div className="space-y-2">
                <RuleEditor
                  node={ruleNode}
                  options={fields
                    .filter((f) => f.enabled && f.metrics.length > 0)
                    .map((f) => ({ key: fieldKey(f), propertyName: f.propertyName, legAlias: f.legAlias }))}
                  onChange={setRuleNode}
                />
                <p className="text-xs text-gray-500 font-mono bg-gray-950 border border-gray-800 rounded px-3 py-2">
                  {describeRule(ruleNode)}
                </p>
                {/* Which leaf is responsible when a rule surfaces nothing. The
                    two causes need opposite fixes: nothing judged means the
                    field is not being compared or its leg has no data; judged
                    but never passed means the threshold is too strict here. */}
                {estimate?.leafSupport && estimate.leafSupport.length > 0 && (
                  <div className="bg-gray-950 border border-gray-800 rounded px-3 py-2 space-y-1">
                    <p className="text-xs text-gray-400">
                      In the sample just estimated, each condition of this rule:
                    </p>
                    {estimate.leafSupport.map((l) => (
                      <div key={`${l.key}|${l.threshold}`} className="flex items-center gap-2 text-xs font-mono">
                        <span className="text-gray-300 w-56 truncate">{l.key} ≥ {l.threshold.toFixed(2)}</span>
                        {l.judged === 0 ? (
                          <span className="text-amber-400">never judged — this field is not compared, or its leg has no data</span>
                        ) : l.passed === 0 ? (
                          <span className="text-amber-400">
                            judged {l.judged.toLocaleString()}×, passed 0 — nothing reaches this threshold
                          </span>
                        ) : (
                          <span className="text-gray-500">
                            judged {l.judged.toLocaleString()}×, passed {l.passed.toLocaleString()}×
                            {' '}({((l.passed / l.judged) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    ))}
                    <p className="text-[11px] text-gray-600 pt-0.5">
                      A condition every pair fails makes any ALL group containing it impossible. An
                      exact match on a field that identifies a node — a company number, a URI — can
                      never be true of two different nodes.
                    </p>
                  </div>
                )}

                <p className="text-xs text-gray-600">
                  A field neither node carries cannot be judged, so it is left out and the group is
                  decided on the rest — a group with nothing judged surfaces nothing. This is what
                  All fields already does; the expression just makes it explicit.
                </p>
                {/* Under the named modes every enabled field was in the rule, so
                    these could not diverge. They can now, and an unreferenced
                    field is not inert: candidate generation is the union across
                    every enabled field. Measured on a 244-node label, adding one
                    unreferenced field took the candidate set from 5,744 to
                    28,817 and surfaced one extra pair — a pair that became a
                    candidate only through that field and then passed the rule. */}
                {(() => {
                  const used = new Set(ruleFieldKeys(ruleNode))
                  const unused = fields
                    .filter((f) => f.enabled && f.metrics.length > 0 && !used.has(fieldKey(f)))
                    .map((f) => fieldKey(f))
                  if (unused.length === 0) return null
                  return (
                    <p className="text-xs text-amber-400/90">
                      ⚠ {unused.length} compared field{unused.length === 1 ? '' : 's'} not used by this
                      rule: <span className="font-mono">{unused.join(', ')}</span>. They do not decide
                      whether a pair surfaces, but they are still scored, still shown in review, and
                      still widen the set of pairs considered — so they can bring in pairs the rule
                      then accepts. Deselect them on{' '}
                      <span className="text-gray-300">Fields &amp; Metrics</span> to narrow the search.
                    </p>
                  )
                })()}
              </div>
            )}

            <div className={`text-xs text-gray-500 space-y-1.5 ${surfacingMode === 'custom' ? 'hidden' : ''}`}>
              <p>
                A field&apos;s score is its{' '}
                <span className="text-gray-300">best-scoring metric</span> — if any one metric you
                chose for that field reaches the threshold below, the field counts as a match. Adding
                a lenient metric to a field therefore lowers that field&apos;s bar.
              </p>
              {surfacingMode === 'any' && (
                <>
                  <p className="text-gray-400">
                    Surfaces a pair when <span className="text-gray-300">at least one</span> field
                    reaches its threshold. Other fields can score anything, including nothing at all.
                  </p>
                  <p>
                    If a property is missing from one or both nodes, that field simply scores 0 and
                    cannot surface the pair on its own — but any other field still can, so the pair
                    may well appear.
                  </p>
                </>
              )}
              {surfacingMode === 'all' && (
                <>
                  <p className="text-gray-400">
                    Surfaces a pair only when <span className="text-gray-300">every comparable</span>{' '}
                    field reaches its threshold.
                  </p>
                  <p>
                    A field is comparable when both nodes actually carry the property. Fields one or
                    both nodes are missing are skipped rather than counted as a failure, so a pair is
                    never rejected for a comparison that was never possible — it is judged on the
                    fields the two records share.
                  </p>
                  <p>
                    A field both nodes do have still has to meet its threshold. Scoring poorly is a
                    comparison the pair lost; having nothing to compare is not.
                  </p>
                </>
              )}
              {surfacingMode === 'weighted-average' && (
                <>
                  <p className="text-gray-400">
                    Surfaces a pair when the weighted sum of field scores reaches the combined
                    threshold. Per-field thresholds above are ignored in this mode — only the weights
                    and the combined threshold apply.
                  </p>
                  <p>
                    A missing property contributes 0 to the sum rather than excluding the pair, so a
                    strong showing on the remaining fields can still surface it.
                  </p>
                  <p>
                    Weights are relative — they are divided by their total, so only their sizes
                    against each other matter, not what they add up to.
                  </p>
                </>
              )}
            </div>

            {/* Per-field thresholds / weights. A custom rule carries its own
                thresholds on each leaf, so these would be editable and ignored. */}
            <div className={`space-y-3 ${surfacingMode === 'custom' ? 'hidden' : ''}`}>
              {Object.entries(fieldSurfacing).map(([name, cfg]) => (
                <div key={name} className="bg-gray-900 rounded-xl border border-gray-800 px-5 py-4">
                  <div className="flex items-center gap-4">
                    <span className="font-medium text-white text-sm flex-1">{name}</span>
                    {surfacingMode !== 'weighted-average' && (
                      <label className="flex items-center gap-2 text-xs text-gray-400">
                        Threshold
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={cfg.threshold}
                          onChange={(e) =>
                            setFieldSurfacing((prev) => ({
                              ...prev,
                              [name]: { ...cfg, threshold: parseFloat(e.target.value) },
                            }))
                          }
                          className="w-24"
                        />
                        <span className="w-10 text-white">{cfg.threshold.toFixed(2)}</span>
                      </label>
                    )}
                    {surfacingMode === 'weighted-average' && (
                      <label className="flex items-center gap-2 text-xs text-gray-400">
                        Weight
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={cfg.weight}
                          onChange={(e) =>
                            setFieldSurfacing((prev) => ({
                              ...prev,
                              [name]: { ...cfg, weight: parseFloat(e.target.value) },
                            }))
                          }
                          className="w-24"
                        />
                        <span className="w-10 text-white">{cfg.weight.toFixed(2)}</span>
                        <span className="w-14 text-right text-gray-500">
                          {weightTotal > 0 ? `${Math.round((cfg.weight / weightTotal) * 100)}%` : '—'}
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {surfacingMode === 'weighted-average' && (
              <label className="flex items-center gap-3 text-sm text-gray-400">
                Combined threshold
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={combinedThreshold}
                  onChange={(e) => setCombinedThreshold(parseFloat(e.target.value))}
                  className="w-32"
                />
                <span className="text-white font-medium">{combinedThreshold.toFixed(2)}</span>
              </label>
            )}

            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-white">Which pairs get compared</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Decided before any threshold applies, so it bounds what the rule can ever surface.
                </p>
              </div>
              {([
                ['auto', 'Automatic', `Compare everything when the label is small enough, otherwise compare pairs sharing a word.`],
                ['exhaustive', 'Every pair', `Nothing is ruled out before scoring. Finds pairs that share no word — which token comparison can never offer — at roughly twice the time and several times the memory. ${labelNodes > 0 ? `${labelNodes.toLocaleString()} nodes is ${Math.round((labelNodes * (labelNodes - 1)) / 2).toLocaleString()} comparisons.` : ''}`],
                ['token-bucket', 'Pairs sharing a word', 'Only records with a word in common are compared. Fast on any label size, but two records spelled differently enough are never offered.'],
                ['prefix', 'Records starting the same way', seekable.length === 0
                  ? 'Needs an indexed property to look up by, and this label has none. Without an index the database scans every node for every node.'
                  : 'The database finds candidates instead of loading the label into memory — the only option that stays workable on millions of nodes. Only records whose chosen property starts identically are compared, and the comparison is case-sensitive.'],
              ] as [BlockingStrategy, string, string][]).map(([value, title, detail]) => (
                <label key={value} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="blocking"
                    className="mt-1"
                    checked={blocking === value}
                    disabled={value === 'prefix' && seekable.length === 0}
                    onChange={() => setBlocking(value)}
                  />
                  <span className="min-w-0">
                    <span className="text-sm text-gray-200">{title}</span>
                    <span className="block text-xs text-gray-500">{detail}</span>
                  </span>
                </label>
              ))}

              {blocking === 'prefix' && seekable.length > 0 && (
                <div className="border-t border-gray-800 pt-3 space-y-3">
                  <label className="flex items-center gap-3 text-xs text-gray-400">
                    <span className="w-28 shrink-0">Look up by</span>
                    <select
                      value={blockingField || seekable[0].name}
                      onChange={(e) => setBlockingField(e.target.value)}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
                    >
                      {seekable.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name} ({p.indexes!.join('/')})
                        </option>
                      ))}
                    </select>
                    <span className="text-gray-600">
                      only indexed properties are listed
                    </span>
                  </label>
                  <label className="flex items-center gap-3 text-xs text-gray-400">
                    <span className="w-28 shrink-0">Matching first</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={prefixLength}
                      onChange={(e) => setPrefixLength(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
                    />
                    <span className="text-gray-600">
                      characters — fewer finds more and costs more
                    </span>
                  </label>
                  <p className="text-xs text-gray-600">
                    Case-sensitive, because the lookup reads the property as stored — a value
                    beginning &ldquo;AC&rdquo; is not found by a search for &ldquo;ac&rdquo;.
                  </p>
                </div>
              )}

              {blocking === 'prefix' && setScoringMetrics.length > 0 && (
                <p className="text-xs text-amber-500 border-t border-gray-800 pt-3">
                  Semantic Cosine on {[...new Set(setScoringMetrics)].join(', ')} cannot be used with
                  this strategy — it compares whole sets of records at once rather than one pair at a
                  time, so those fields would go unscored. Remove it, or choose another strategy.
                </p>
              )}
            </div>

            {estimate?.projectedCandidates !== undefined &&
              estimate.projectedCandidates > MAX_CANDIDATE_PAIRS && (
                <div className="bg-amber-950 border border-amber-800 rounded-xl p-4 text-sm space-y-2">
                  <p className="text-amber-300 font-medium">Compute will refuse this configuration</p>
                  <p className="text-amber-700">
                    It would build about {roundSampled(estimate.projectedCandidates, undefined)} pairs to compare,
                    against a limit of {MAX_CANDIDATE_PAIRS.toLocaleString()}. That is every pair the
                    metrics would score, before any threshold — a different and much larger number than
                    the {estimate.count.toLocaleString()} that would reach the review queue.
                  </p>
                  <p className="text-amber-700">
                    Raising a threshold will not help, because thresholds are applied after these
                    pairs are built. Remove a field or a metric — or switch to prefix blocking,
                    which never builds a whole-label pair set: it walks the label in order and
                    captures a bounded batch per pass, so this ceiling does not apply to it.
                  </p>
                </div>
              )}

            {labelNodes >= HEAVY_LABEL_NODES && blocking === 'prefix' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm space-y-2">
                <p className="text-white font-medium">
                  {selectedLabel!.name} has {labelNodes.toLocaleString()} nodes
                </p>
                <p className="text-gray-400">
                  Prefix blocking is built for this. It walks the label in indexed order holding one
                  batch at a time rather than loading every node, and stops on a budget — so the
                  first pass returns a reviewable queue in seconds however large the label is. You
                  can capture more from the review screen, and each pass resumes where the last
                  stopped.
                </p>
              </div>
            )}

            {labelNodes >= HEAVY_LABEL_NODES && blocking !== 'prefix' && (
              <div className="bg-amber-950 border border-amber-800 rounded-xl p-4 text-sm space-y-2">
                <p className="text-amber-300 font-medium">
                  {selectedLabel!.name} has {labelNodes.toLocaleString()} nodes
                </p>
                <p className="text-amber-700">
                  This strategy loads every one of them into memory and holds them for the whole run
                  — about {projectedGb.toFixed(1)} GB for this label, before pair scores are counted.
                  {isExtremeLabel
                    ? ' That is past what the app can hold, so this run will most likely run out of memory and close the app.'
                    : ' Expect a long run and heavy memory use.'}
                </p>
                <p className="text-amber-700">
                  Prefix blocking avoids this entirely — it walks the label in batches instead of
                  loading it. Estimate Pair Count is safe at any size either way; it samples.
                </p>
                {isExtremeLabel && (
                  <label className="flex items-center gap-2 text-amber-300 pt-1">
                    <input
                      type="checkbox"
                      checked={acceptLargeLabel}
                      onChange={(e) => setAcceptLargeLabel(e.target.checked)}
                    />
                    Run compute anyway
                  </label>
                )}
              </div>
            )}

            {/* Estimate + Start */}
            <div className="flex items-center gap-4 pt-2">
              <button onClick={runEstimate} disabled={estimating} className="btn-secondary text-sm">
                {estimating ? 'Estimating…' : 'Estimate Pair Count'}
              </button>
              {estimate !== null && estimate.incremental && (
                <span className="text-sm text-gray-400">
                  ≈{' '}
                  <span className="text-white font-medium">
                    {roundSampled(estimate.count, estimate.observed)}
                  </span>{' '}
                  pairs in the next capture pass
                  <span className="text-gray-500">
                    {' '}— from {estimate.observed?.toLocaleString()}{' '}
                    {estimate.observed === 1 ? 'pair' : 'pairs'} in the{' '}
                    {estimate.sampledNodes?.toLocaleString()} nodes the walk reaches next. A pass
                    stops on its budget, so this is what one pass yields, not what the label holds.
                  </span>
                </span>
              )}
              {estimate !== null && !estimate.incremental && (
                <span className="text-sm text-gray-400">
                  {estimate.exact ? '' : '≈ '}
                  <span className="text-white font-medium">
                    {estimate.exact
                      ? estimate.count.toLocaleString()
                      : roundSampled(estimate.count, estimate.observed)}
                  </span>{' '}
                  {estimate.count === 1 ? 'pair' : 'pairs'} surfaced by this rule
                  {!estimate.exact && (
                    <span className="text-gray-500">
                      {' '}— projected from {estimate.observed?.toLocaleString()}{' '}
                      {estimate.observed === 1 ? 'pair' : 'pairs'} seen in a sample of{' '}
                      {estimate.sampledNodes?.toLocaleString()} of{' '}
                      {estimate.totalNodes?.toLocaleString()} nodes
                    </span>
                  )}
                </span>
              )}
              <div className="flex-1" />
              {isRerun && (
                <button
                  onClick={reapplyThresholds}
                  disabled={creating || reapplying}
                  className="btn-secondary px-4"
                  title="Re-apply thresholds and the surfacing rule to candidates already captured, without walking the label again"
                >
                  {reapplying ? 'Applying…' : 'Re-apply Thresholds'}
                </button>
              )}
              <button onClick={startCompute} disabled={creating || reapplying || blockedByLabelSize || blockedByStrategy} className="btn-primary px-6">
                {creating ? 'Starting…' : isRerun ? 'Re-run Compute →' : 'Start Compute →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
