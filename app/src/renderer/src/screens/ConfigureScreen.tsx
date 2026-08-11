import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { METRICS, suggestMetrics, getMetricDef } from '../lib/metrics'
import { formatUsd, summarizeTokens } from '../lib/usage'
import type {
  LabelMeta,
  FieldConfig,
  MetricConfig,
  SurfacingRule,
  LlmCallRecord,
  PropertyKind,
  PairEstimate,
} from '../../../shared/types'

type Step = 'label' | 'fields' | 'surfacing'

interface DraftMetric {
  metricId: string
  params: Record<string, unknown>
  threshold: number
}

interface DraftField {
  propertyName: string
  enabled: boolean
  metrics: DraftMetric[]
  kind: string
}

const SKIP_KINDS = ['boolean']

// Compute holds every node of the label in memory for the whole run — measured
// at roughly 1KB per node, before pair scores. Warn past the point where that
// gets uncomfortable, and require an explicit choice past the point where V8's
// ~4GB heap ceiling makes failure the likely outcome.
const HEAVY_LABEL_NODES = 500_000
const EXTREME_LABEL_NODES = 2_000_000
const BYTES_PER_NODE = 1000

// A sampled count is an extrapolation, sometimes from well under 1% of the
// label. Printing every digit of it claims a precision the method does not have.
function roundSampled(n: number): string {
  if (n < 1000) return n.toLocaleString()
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1)
  return (Math.round(n / mag) * mag).toLocaleString()
}

export default function ConfigureScreen() {
  const { schema, connection, session, settings, setSession, setScreen, setPairs, setDistributions, addToast } = useStore()
  const [step, setStep] = useState<Step>('label')
  const [selectedLabel, setSelectedLabel] = useState<LabelMeta | null>(null)
  const [fields, setFields] = useState<DraftField[]>([])
  const [surfacingMode, setSurfacingMode] = useState<'any' | 'all' | 'weighted-average'>('any')
  const [fieldSurfacing, setFieldSurfacing] = useState<Record<string, { threshold: number; weight: number }>>({})
  const [combinedThreshold, setCombinedThreshold] = useState(0.85)
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

  const labelNodes = selectedLabel?.count ?? 0
  const projectedGb = (labelNodes * BYTES_PER_NODE) / 1_073_741_824
  const isExtremeLabel = labelNodes >= EXTREME_LABEL_NODES
  const blockedByLabelSize = isExtremeLabel && !acceptLargeLabel

  useEffect(() => {
    const off = window.api.usage.onCall((record) => {
      if (record.kind === 'configure-suggest') setAiCall(record)
    })
    return () => { off() }
  }, [])

  // Pre-populate from an existing session when coming from the review screen for a re-run
  const isRerun = Boolean(session && (session.status === 'reviewing' || session.status === 'merges-applied'))

  useEffect(() => {
    if (!isRerun || !schema) return
    const labelMeta = schema.labels.find((l) => l.name === session!.label)
    if (!labelMeta) return

    setSelectedLabel(labelMeta)

    // Show every comparable property, not just the ones the session kept —
    // otherwise a field deselected on an earlier pass can never be selected again.
    const saved = new Map(session!.fields.map((fc) => [fc.propertyName, fc]))
    const fromSaved = (fc: FieldConfig, kind: PropertyKind): DraftField => ({
      propertyName: fc.propertyName,
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

    // A saved field the schema no longer reports still has verdicts riding on it.
    for (const fc of session!.fields) {
      if (!draft.some((d) => d.propertyName === fc.propertyName)) draft.push(fromSaved(fc, 'name'))
    }
    setFields(draft)

    const sf: Record<string, { threshold: number; weight: number }> = {}
    for (const f of session!.surfacingRule.fields) {
      sf[f.propertyName] = { threshold: f.threshold, weight: f.weight ?? (1 / session!.surfacingRule.fields.length) }
    }
    setFieldSurfacing(sf)
    setSurfacingMode(session!.surfacingRule.mode)
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
      sf[f.propertyName] = { threshold: 0.8, weight: 1 / Math.max(draft.length, 1) }
    }
    setFieldSurfacing(sf)
    setStep('fields')
  }

  function toggleField(name: string) {
    setFields((prev) => prev.map((f) => f.propertyName === name ? { ...f, enabled: !f.enabled } : f))
  }

  function toggleMetric(fieldName: string, metricId: string) {
    setFields((prev) => prev.map((f) => {
      if (f.propertyName !== fieldName) return f
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
      if (f.propertyName !== fieldName) return f
      return {
        ...f,
        metrics: f.metrics.map((m) => m.metricId === metricId ? { ...m, params: { ...m.params, [key]: value } } : m),
      }
    }))
  }

  function setMetricThreshold(fieldName: string, metricId: string, threshold: number) {
    setFields((prev) => prev.map((f) => {
      if (f.propertyName !== fieldName) return f
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
    const priorTotal = enabled.reduce((sum, f) => sum + (fieldSurfacing[f.propertyName]?.weight ?? 0), 0)
    const sf: Record<string, { threshold: number; weight: number }> = {}
    for (const f of enabled) {
      const cfg = fieldSurfacing[f.propertyName]
      sf[f.propertyName] = {
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
      metrics: f.metrics as MetricConfig[],
    }))

    const sfFields = enabledFields.map((f) => ({
      propertyName: f.propertyName,
      threshold: fieldSurfacing[f.propertyName]?.threshold ?? 0.8,
      weight: fieldSurfacing[f.propertyName]?.weight ?? (1 / enabledFields.length),
    }))

    const surfacingRule: SurfacingRule = {
      mode: surfacingMode,
      fields: sfFields,
      combinedThreshold: surfacingMode === 'weighted-average' ? combinedThreshold : undefined,
    }

    return {
      connectionId: connection!.id,
      label: selectedLabel!.name,
      fields: fieldConfigs,
      surfacingRule,
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

  async function startCompute() {
    setCreating(true)
    try {
      let activeSession
      if (isRerun && session) {
        // Update the existing session in-place — preserves all pair verdicts
        const partial = buildSessionPartial()
        activeSession = {
          ...session,
          fields: partial.fields,
          surfacingRule: partial.surfacingRule,
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
              const propMeta = selectedLabel.properties.find((p) => p.name === field.propertyName)
              // For properties whose kind couldn't be determined, fall back to name-applicable metrics
              const applicableMetrics = METRICS.filter((m) =>
                m.applicableTo.includes((field.kind === 'other' ? 'name' : field.kind) as never)
              )
              return (
                <div key={field.propertyName} className={`bg-gray-900 rounded-xl border transition-colors ${field.enabled ? 'border-gray-700' : 'border-gray-800 opacity-60'}`}>
                  <div className="flex items-center gap-3 px-5 py-4">
                    <input
                      type="checkbox"
                      checked={field.enabled}
                      onChange={() => toggleField(field.propertyName)}
                      className="w-4 h-4 accent-emerald-500"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
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
                        const key = `${field.propertyName}:${fm.metricId}`
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
              {(['any', 'all', 'weighted-average'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSurfacingMode(mode)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    surfacingMode === mode
                      ? 'bg-emerald-900 border-emerald-700 text-emerald-300'
                      : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {mode === 'any' ? 'Any field' : mode === 'all' ? 'All fields' : 'Weighted average'}
                </button>
              ))}
            </div>

            <div className="text-xs text-gray-500 space-y-1.5">
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

            {/* Per-field thresholds / weights */}
            <div className="space-y-3">
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

            {labelNodes >= HEAVY_LABEL_NODES && (
              <div className="bg-amber-950 border border-amber-800 rounded-xl p-4 text-sm space-y-2">
                <p className="text-amber-300 font-medium">
                  {selectedLabel!.name} has {labelNodes.toLocaleString()} nodes
                </p>
                <p className="text-amber-700">
                  Compute loads every one of them into memory and holds them for the whole run —
                  about {projectedGb.toFixed(1)} GB for this label, before pair scores are counted.
                  {isExtremeLabel
                    ? ' That is past what the app can hold, so this run will most likely run out of memory and close the app.'
                    : ' Expect a long run and heavy memory use.'}
                </p>
                <p className="text-amber-700">
                  Estimate Pair Count is safe at any size — it samples rather than loading the label.
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
              {estimate !== null && (
                <span className="text-sm text-gray-400">
                  {estimate.exact ? '' : '≈ '}
                  <span className="text-white font-medium">
                    {estimate.exact ? estimate.count.toLocaleString() : roundSampled(estimate.count)}
                  </span>{' '}
                  {estimate.count === 1 ? 'pair' : 'pairs'} surfaced by this rule
                  {!estimate.exact && (
                    <span className="text-gray-500">
                      {' '}— sampled {estimate.sampledNodes?.toLocaleString()} of{' '}
                      {estimate.totalNodes?.toLocaleString()} nodes
                    </span>
                  )}
                </span>
              )}
              <div className="flex-1" />
              <button onClick={startCompute} disabled={creating || blockedByLabelSize} className="btn-primary px-6">
                {creating ? 'Starting…' : isRerun ? 'Re-run Compute →' : 'Start Compute →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
