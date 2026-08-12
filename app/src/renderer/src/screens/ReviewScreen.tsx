import { useState, useEffect, useRef, useCallback } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '../store'
import AssistantPanel from '../components/AssistantPanel'
import NodeRelationships from '../components/NodeRelationships'
import SourcePassages from '../components/SourcePassages'
import {
  formatUsd,
  formatUsdRange,
  formatTokens,
  formatDuration,
  describeBasis,
  summarizeTokens,
} from '../lib/usage'
import type {
  MergeGroup,
  MergeApplyResult,
  Verdict,
  ClassifyPlan,
  JobEstimate,
  UsageTotals,
} from '../../../shared/types'

type VerdictFilter = 'all' | 'pending' | 'duplicate' | 'distinct'

const VERDICT_COLORS: Record<Verdict, string> = {
  pending: 'text-gray-500',
  duplicate: 'text-emerald-400',
  distinct: 'text-red-400',
}

function displayVal(props: Record<string, unknown>): string {
  const v = props.name ?? props.title ?? props.heading ?? props.summary ?? props.text
  if (v == null) return ''
  const s = String(v)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

function scoreColor(score: number, threshold: number): string {
  if (score >= threshold) return 'bg-emerald-500'
  if (score >= threshold * 0.8) return 'bg-amber-500'
  return 'bg-gray-600'
}

// ── Merge Modal ───────────────────────────────────────────────────────────────

interface MergeModalProps {
  sessionId: string
  onClose: () => void
  onApplied: () => void
  onGoToSessions: () => void
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void
}

function MergeModal({ sessionId, onClose, onApplied, onGoToSessions, addToast }: MergeModalProps) {
  const [groups, setGroups] = useState<MergeGroup[] | null>(null)
  const [strategy, setStrategy] = useState<'discard' | 'overwrite' | 'combine'>('discard')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<MergeApplyResult | null>(null)

  useEffect(() => {
    window.api.merge.dryRun(sessionId).then(setGroups).catch((err) => {
      addToast(`Dry run failed: ${(err as Error).message}`, 'error')
      onClose()
    })
  }, [sessionId])

  async function apply() {
    setApplying(true)
    try {
      const r = await window.api.merge.apply(sessionId, strategy)
      setResult(r)
      addToast(`Merged ${r.groupsApplied} groups`, 'success')
      onApplied()
    } catch (err) {
      addToast(`Merge failed: ${(err as Error).message}`, 'error')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white">Apply Merges</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {groups === null && <p className="text-gray-500 text-sm">Loading dry run…</p>}

          {groups !== null && groups.length === 0 && (
            <p className="text-gray-400 text-sm">No duplicate-verdict pairs to merge.</p>
          )}

          {groups !== null && groups.length > 0 && !result && (
            <>
              <p className="text-sm text-gray-400">
                {groups.length} merge group{groups.length > 1 ? 's' : ''} from marked duplicates.
              </p>

              {groups.map((g, i) => (
                <div key={i} className="bg-gray-950 rounded-xl border border-gray-800 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-emerald-400 font-medium">Survivor</span>
                    <span className="text-gray-500 font-mono text-xs">{g.survivorId.slice(-12)}</span>
                  </div>
                  <div className="space-y-1">
                    {g.memberIds.map((id, j) => (
                      <div key={id} className="flex items-center gap-2 text-xs text-gray-400">
                        {id === g.survivorId ? (
                          <span className="w-3 h-3 rounded-full bg-emerald-500 shrink-0" />
                        ) : (
                          <span className="w-3 h-3 rounded-full bg-gray-700 shrink-0" />
                        )}
                        <span className="truncate">{g.memberTexts[j] || id.slice(-12)}</span>
                        {g.transitivePairs.some(([a, b]) => a === id || b === id) && (
                          <span className="text-amber-400 shrink-0">⚠ transitive</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Conflict strategy */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Property conflict strategy</p>
                {(['discard', 'overwrite', 'combine'] as const).map((s) => (
                  <label key={s} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="strategy"
                      value={s}
                      checked={strategy === s}
                      onChange={() => setStrategy(s)}
                      className="accent-emerald-500"
                    />
                    <div>
                      <span className="text-sm text-white capitalize">{s}</span>
                      <span className="text-xs text-gray-500 ml-2">
                        {s === 'discard' && '— keep survivor properties only'}
                        {s === 'overwrite' && '— absorbed node properties overwrite survivor'}
                        {s === 'combine' && '— merge lists (available on Aura; requires APOC on self-managed)'}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {result && (
            <div className="bg-emerald-950 border border-emerald-800 rounded-xl p-5 space-y-2 text-sm">
              <p className="font-medium text-emerald-300">Merge pass complete</p>
              <div className="grid grid-cols-3 gap-3 text-center mt-2">
                <div>
                  <div className="text-2xl font-bold text-emerald-400">{result.groupsApplied}</div>
                  <div className="text-xs text-emerald-700">applied</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-400">{result.groupsSkipped}</div>
                  <div className="text-xs text-gray-600">skipped</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-400">{result.groupsFailed}</div>
                  <div className="text-xs text-red-700">failed</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-800">
          {!result ? (
            <>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
              {groups !== null && groups.length > 0 && (
                <button onClick={apply} disabled={applying} className="btn-primary px-6">
                  {applying ? 'Applying…' : `Apply ${groups.length} Group${groups.length > 1 ? 's' : ''}`}
                </button>
              )}
            </>
          ) : (
            <>
              <button onClick={onClose} className="btn-secondary">Stay in Review</button>
              <button onClick={onGoToSessions} className="btn-primary px-6">Back to Sessions →</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Cost estimate / spend readouts ────────────────────────────────────────────

function EstimatePanel({ plan, loading }: { plan: ClassifyPlan | null; loading: boolean }): ReactElement {
  if (loading) {
    return <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 text-xs text-gray-500">Planning run…</div>
  }
  if (!plan || plan.estimate.unitCount === 0) {
    return (
      <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 text-xs text-gray-500">
        Nothing to classify.
      </div>
    )
  }

  const { estimate } = plan
  const cacheOff = !plan.cacheRequested
  const cacheBlocked = plan.cacheRequested && !plan.cacheEligible

  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-gray-500">Estimated cost</span>
        <span className="text-lg font-semibold text-white">
          {estimate.priced && estimate.basis !== 'none'
            ? formatUsdRange(estimate.costLowUsd, estimate.costHighUsd)
            : '—'}
        </span>
      </div>

      <div className="text-xs text-gray-500 space-y-0.5">
        <p>
          {estimate.unitCount} pair{estimate.unitCount === 1 ? '' : 's'} in{' '}
          <span className="text-gray-400">
            {estimate.callCount} call{estimate.callCount === 1 ? '' : 's'}
          </span>{' '}
          of {plan.batchSize} on <span className="text-gray-400">{estimate.model}</span>
        </p>
        {estimate.basis !== 'none' && (
          <p>
            ~{formatTokens(estimate.inputTokens)} input · ~{formatTokens(estimate.outputTokens)}{' '}
            output
            {estimate.cacheReadInputTokens > 0 &&
              ` · ~${formatTokens(estimate.cacheReadInputTokens)} cache read`}
          </p>
        )}
        {estimate.durationMsEstimate !== null && (
          <p>~{formatDuration(estimate.durationMsEstimate)} to run</p>
        )}
        <p className="text-gray-600">{describeBasis(estimate)}</p>
      </div>

      <div className="text-xs border-t border-gray-800 pt-2 space-y-0.5">
        <p className="text-gray-500">
          Shared prefix: {formatTokens(plan.prefixTokens)} tokens
          {!plan.prefixTokensExact && ' (approx.)'}
          {plan.fewShotAvailable > 0
            ? ` · ${plan.fewShotAvailable} worked example${plan.fewShotAvailable === 1 ? '' : 's'}`
            : ' · no worked examples yet'}
        </p>
        {plan.cacheRequested && plan.cacheEligible && (
          <p className="text-emerald-500">
            Prefix is cached — re-read at 10% of input price on every call after the first.
          </p>
        )}
        {cacheBlocked && (
          <div className="text-amber-500 space-y-1">
            <p>
              Prefix is {formatTokens(plan.prefixTokens)} tokens, below the{' '}
              {formatTokens(plan.cacheFloor)}-token cache minimum for {estimate.model} — it will be
              re-sent in full on every call.
            </p>
            <p className="text-amber-600">
              To fix, in <span className="text-amber-400">Settings → AI Auto-classify</span>:
            </p>
            <ul className="text-amber-600 list-disc list-inside space-y-0.5">
              {plan.suggestedFewShotCount !== null ? (
                <li>
                  raise <span className="text-amber-400">Worked examples</span> from{' '}
                  {plan.fewShotAvailable} to about {plan.suggestedFewShotCount} — you have{' '}
                  {plan.decidedPairCount} reviewed pair
                  {plan.decidedPairCount === 1 ? '' : 's'} to draw from
                </li>
              ) : (
                <li>
                  review more pairs by hand — {plan.decidedPairCount} decided so far, not enough to
                  reach the minimum on their own
                </li>
              )}
              {plan.alternativeModel && (
                <li>
                  or set <span className="text-amber-400">Model</span> to{' '}
                  {plan.alternativeModel.displayName}, whose{' '}
                  {formatTokens(plan.alternativeModel.cacheFloor)}-token minimum this prefix already
                  clears
                </li>
              )}
            </ul>
          </div>
        )}
        {cacheOff && <p className="text-gray-600">Prefix caching is disabled in Settings.</p>}
        {!estimate.priced && (
          <p className="text-amber-500">
            No pricing on record for this model — set a rate in Settings to see cost.
          </p>
        )}
        {plan.fewShotAvailable === 0 && (
          <p className="text-gray-600">
            Review a few pairs by hand first — decided pairs become worked examples and measurably
            improve accuracy.
          </p>
        )}
      </div>
    </div>
  )
}

function SpendRow({
  spend,
  estimate,
  label,
}: {
  spend: UsageTotals | null
  estimate: JobEstimate | null
  label: string
}): ReactElement | null {
  if (!spend || spend.callCount === 0) return null
  return (
    <div className="flex items-baseline justify-between border-t border-gray-800 pt-3 text-xs">
      <div className="text-gray-500">
        <span className="text-gray-400">{label}</span>
        <span className="ml-2">{summarizeTokens(spend)}</span>
      </div>
      <div className="text-right">
        <span className="text-sm font-semibold text-white">{formatUsd(spend.costUsd)}</span>
        {estimate?.priced && estimate.costUsd > 0 && (
          <span className="ml-2 text-gray-600">est. {formatUsd(estimate.costUsd)}</span>
        )}
      </div>
    </div>
  )
}

// ── AI Auto-classify Modal ────────────────────────────────────────────────────

interface AutoClassifyModalProps {
  sessionId: string
  pendingCount: number
  onClose: () => void
  onDone: () => void
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void
}

function AutoClassifyModal({ sessionId, pendingCount, onClose, onDone, addToast }: AutoClassifyModalProps) {
  const [progress, setProgress] = useState<{ completed: number; total: number; lastVerdict: string | null }>({
    completed: 0, total: pendingCount, lastVerdict: null,
  })
  const [phase, setPhase] = useState<'estimating' | 'ready' | 'running' | 'done'>('estimating')
  const [plan, setPlan] = useState<ClassifyPlan | null>(null)
  const [spend, setSpend] = useState<UsageTotals | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [classified, setClassified] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const startedRef = useRef(false)

  useEffect(() => {
    // Register listener unconditionally so StrictMode's mount→cleanup→remount cycle
    // doesn't leave us without a listener when progress events arrive.
    const off = window.api.pairs.onAutoClassifyProgress((data) => {
      setProgress({ completed: data.completed, total: data.total, lastVerdict: data.verdict })
      setSpend(data.usage)
    })
    return () => { off() }
  }, [])

  useEffect(() => {
    window.api.classify.plan(sessionId)
      .then((p) => { setPlan(p); setPhase('ready') })
      .catch((err) => { addToast((err as Error).message, 'error'); setPhase('ready') })
  }, [sessionId])

  function handleStart(): void {
    if (startedRef.current) return
    startedRef.current = true
    setPhase('running')
    window.api.pairs.autoClassify(sessionId)
      .then((result) => {
        setClassified(result.classified)
        setCancelled(result.cancelled)
        setSpend(result.usage)
        setPhase('done')
        if (result.cancelled) {
          addToast(`Cancelled after classifying ${result.classified} pairs`, 'info')
        } else {
          addToast(`AI classified ${result.classified} of ${pendingCount} pairs`, 'success')
        }
      })
      .catch((err) => {
        addToast((err as Error).message, 'error')
        onClose()
      })
  }

  function handleCancel() {
    setCancelling(true)
    window.api.pairs.cancelAutoClassify()
  }

  const done = phase === 'done'
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white">AI Auto-classify</h2>
          {done && <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none">×</button>}
        </div>

        <div className="px-6 py-5 space-y-5">
          {phase === 'estimating' || phase === 'ready' ? (
            <>
              <p className="text-sm text-gray-400">
                {pendingCount} pending pair{pendingCount === 1 ? '' : 's'} to classify. Pairs are
                sent in batches behind a shared prompt, with your reviewed pairs included as
                worked examples.
              </p>
              <EstimatePanel plan={plan} loading={phase === 'estimating'} />
            </>
          ) : !done ? (
            <>
              <p className="text-sm text-gray-400">
                {cancelling
                  ? 'Finishing current pair then stopping…'
                  : `Classifying ${progress.total} pending pairs with Claude…`}
              </p>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-gray-500">
                  <span>{progress.completed} / {progress.total}</span>
                  <span>{pct}%</span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${cancelling ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              {progress.lastVerdict && (
                <p className="text-xs text-gray-500">
                  Last verdict:{' '}
                  <span className={progress.lastVerdict === 'duplicate' ? 'text-emerald-400' : 'text-red-400'}>
                    {progress.lastVerdict}
                  </span>
                </p>
              )}
              <SpendRow spend={spend} estimate={plan?.estimate ?? null} label="Spent so far" />
            </>
          ) : cancelled ? (
            <>
              <div className="bg-amber-950 border border-amber-800 rounded-xl p-4 text-sm space-y-1">
                <p className="text-amber-300 font-medium">Classification stopped</p>
                <p className="text-amber-700">
                  {classified} of {pendingCount} pairs classified before cancellation
                </p>
              </div>
              <p className="text-xs text-gray-500">
                Partial results are saved. You can review them now or run AI classify again to continue.
              </p>
              <SpendRow spend={spend} estimate={plan?.estimate ?? null} label="Total spend" />
            </>
          ) : (
            <>
              <div className="bg-emerald-950 border border-emerald-800 rounded-xl p-4 text-sm space-y-1">
                <p className="text-emerald-300 font-medium">Classification complete</p>
                <p className="text-emerald-600">
                  {classified} of {pendingCount} pairs classified · review AI notes before merging
                </p>
              </div>
              <p className="text-xs text-gray-500">
                Each pair has been given a verdict and an <span className="text-gray-400">[AI]</span> note
                explaining the reasoning. You can override any decision by clicking Duplicate / Distinct.
              </p>
              <SpendRow spend={spend} estimate={plan?.estimate ?? null} label="Total spend" />
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-800">
          {(phase === 'estimating' || phase === 'ready') && (
            <>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
              <button
                onClick={handleStart}
                disabled={phase !== 'ready' || pendingCount === 0}
                className="btn-primary disabled:opacity-40"
              >
                Start classification
              </button>
            </>
          )}
          {phase === 'running' && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="btn-secondary text-xs disabled:opacity-50"
            >
              {cancelling ? 'Stopping after current…' : 'Cancel'}
            </button>
          )}
          {done && (
            <>
              <button onClick={onClose} className="btn-secondary">Review later</button>
              <button onClick={onDone} className="btn-primary">Refresh & review →</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Shortcut overlay ──────────────────────────────────────────────────────────

function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 rounded-2xl border border-gray-700 p-6 space-y-3 w-72" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-white">Keyboard Shortcuts</h3>
        {[
          ['D', 'Mark as Duplicate'],
          ['X', 'Mark as Distinct'],
          ['J / →', 'Next pair'],
          ['K / ←', 'Previous pair'],
          ['N', 'Add / edit note'],
          ['Esc', 'Close overlays'],
          ['?', 'Toggle this overlay'],
        ].map(([key, desc]) => (
          <div key={key} className="flex items-center gap-3">
            <kbd className="px-2 py-0.5 bg-gray-800 rounded text-xs font-mono text-gray-300 min-w-[2.5rem] text-center">
              {key}
            </kbd>
            <span className="text-sm text-gray-400">{desc}</span>
          </div>
        ))}
        <button onClick={onClose} className="btn-secondary w-full text-sm mt-2">Close</button>
      </div>
    </div>
  )
}

// ── Main ReviewScreen ─────────────────────────────────────────────────────────

export default function ReviewScreen() {
  const { session, pairs, setPairs, updatePairVerdict, addToast, setSession, setScreen, settings } = useStore()
  const [filter, setFilter] = useState<VerdictFilter>('all')
  const [sort, setSort] = useState<'pending-first' | 'score-desc' | 'score-asc'>('pending-first')
  // The pair being reviewed is tracked by id, not by position.
  //
  // filteredPairs is re-sorted on every render, and deciding a pair changes
  // where it sorts: under "Pending first" it moves to the end, so every pair
  // after it shifts down one. Advancing an index then lands two along, and
  // marking a queue of eight verdicts reviewed four of them — p0, p2, p4, p6 —
  // before running off the end and reporting itself done with four still
  // pending. An id survives the reshuffle; an index does not.
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  const [showAutoClassify, setShowAutoClassify] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [editingNote, setEditingNote] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const hasApiKey = Boolean(settings?.anthropicApiKey)
  const pendingCount = pairs.filter((p) => p.verdict === 'pending').length

  // Filtered + sorted pairs
  const filteredPairs = (() => {
    let list = pairs
    if (filter !== 'all') list = list.filter((p) => p.verdict === filter)
    if (sort === 'pending-first') list = [...list].sort((a, b) => {
      if (a.verdict === 'pending' && b.verdict !== 'pending') return -1
      if (a.verdict !== 'pending' && b.verdict === 'pending') return 1
      return 0
    })
    if (sort === 'score-desc' || sort === 'score-asc') {
      list = [...list].sort((a, b) => {
        const sa = a.scores.reduce((max, s) => Math.max(max, s.score), 0)
        const sb = b.scores.reduce((max, s) => Math.max(max, s.score), 0)
        return sort === 'score-desc' ? sb - sa : sa - sb
      })
    }
    return list
  })()

  const foundIdx = currentId === null ? -1 : filteredPairs.findIndex((p) => p.id === currentId)
  const currentIdx = foundIdx === -1 ? 0 : foundIdx
  const currentPair = filteredPairs[currentIdx] ?? null
  const pending = pairs.filter((p) => p.verdict === 'pending').length
  const decided = pairs.length - pending

  useEffect(() => {
    if (currentPair) {
      setNoteText(currentPair.note ?? '')
      setEditingNote(false)
    }
  }, [currentPair?.id])

  const goNext = useCallback(() => {
    const next = filteredPairs[currentIdx + 1]
    if (next) setCurrentId(next.id)
  }, [filteredPairs, currentIdx])

  const goPrev = useCallback(() => {
    const prev = filteredPairs[currentIdx - 1]
    if (prev) setCurrentId(prev.id)
  }, [filteredPairs, currentIdx])

  const markVerdict = useCallback(async (verdict: Verdict) => {
    if (!currentPair) return
    // Read the next pair from the list as it stands now. Applying the verdict
    // re-sorts it, so anything derived afterwards points at the wrong row.
    const nextId = filteredPairs[currentIdx + 1]?.id ?? null
    updatePairVerdict(currentPair.id, verdict)
    await window.api.pairs.setVerdict(currentPair.id, verdict)
    if (nextId !== null) setCurrentId(nextId)
  }, [currentPair, filteredPairs, currentIdx, updatePairVerdict])

  async function saveNote() {
    if (!currentPair) return
    setSaving(true)
    await window.api.pairs.setNote(currentPair.id, noteText)
    setSaving(false)
    setEditingNote(false)
  }

  async function exportPairs(format: 'csv' | 'json') {
    if (!session) return
    setExporting(true)
    try {
      const data = await window.api.pairs.export(session.id, format, filter)
      const blob = new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `er-pairs-${session.label}-${Date.now()}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      addToast(`Export failed: ${(err as Error).message}`, 'error')
    } finally {
      setExporting(false)
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      switch (e.key) {
        case 'd': case 'D': markVerdict('duplicate'); break
        case 'x': case 'X': markVerdict('distinct'); break
        case 'j': case 'ArrowRight': goNext(); break
        case 'k': case 'ArrowLeft': goPrev(); break
        case 'n': case 'N': setEditingNote(true); setTimeout(() => noteRef.current?.focus(), 50); break
        case '?': setShowShortcuts((s) => !s); break
        case 'Escape': setShowShortcuts(false); setEditingNote(false); break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [markVerdict, goNext, goPrev])

  function handleMergeApplied() {
    if (session) window.api.session.load(session.id).then(setSession)
  }

  async function handleAutoClassifyDone() {
    setShowAutoClassify(false)
    if (session) {
      const refreshed = await window.api.pairs.list(session.id)
      setPairs(refreshed)
    }
  }

  if (!session) return null

  return (
    <div className="h-full flex overflow-hidden">

      {/* ── Left queue panel ── */}
      <div className="w-56 flex flex-col bg-gray-900 border-r border-gray-800 shrink-0">
        {/* Stats */}
        <div className="px-4 py-3 border-b border-gray-800">
          <div className="text-xs text-gray-500">
            <span className="text-white font-medium">{pending}</span> pending ·{' '}
            <span className="text-gray-300">{decided}</span> decided
          </div>
          <div className="mt-1 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-600"
              style={{ width: `${pairs.length > 0 ? (decided / pairs.length) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Filter */}
        <div className="px-3 py-2 border-b border-gray-800">
          <select
            value={filter}
            onChange={(e) => { setFilter(e.target.value as VerdictFilter); setCurrentId(null) }}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
          >
            <option value="all">All ({pairs.length})</option>
            <option value="pending">Pending ({pairs.filter((p) => p.verdict === 'pending').length})</option>
            <option value="duplicate">Duplicate ({pairs.filter((p) => p.verdict === 'duplicate').length})</option>
            <option value="distinct">Distinct ({pairs.filter((p) => p.verdict === 'distinct').length})</option>
          </select>
        </div>

        {/* Pair list */}
        <div className="flex-1 overflow-y-auto">
          {filteredPairs.map((pair, i) => {
            const display = displayVal(pair.nodeA.properties) || pair.nodeA.id.slice(-8)
            const displayB = displayVal(pair.nodeB.properties) || pair.nodeB.id.slice(-8)
            return (
              <button
                key={pair.id}
                onClick={() => setCurrentId(pair.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-gray-800/50 hover:bg-gray-800/50 transition-colors ${i === currentIdx ? 'bg-gray-800' : ''}`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-gray-300 truncate">{display}</div>
                    <div className="text-xs text-gray-600 truncate">{displayB}</div>
                  </div>
                  <span className="flex items-center gap-1 shrink-0 mt-0.5">
                    {pair.decidedBy === 'ai' && (
                      <span className="text-[10px] text-indigo-400" title="Decided by AI">✦</span>
                    )}
                    <span className={`text-xs ${VERDICT_COLORS[pair.verdict]}`}>
                      {pair.verdict === 'duplicate' ? '✓' : pair.verdict === 'distinct' ? '✗' : '·'}
                    </span>
                  </span>
                </div>
              </button>
            )
          })}
          {filteredPairs.length === 0 && (
            <p className="text-xs text-gray-600 text-center mt-8 px-4">No pairs match the current filter.</p>
          )}
        </div>

        {/* Export */}
        <div className="px-3 py-3 border-t border-gray-800 space-y-1">
          <button onClick={() => exportPairs('csv')} disabled={exporting} className="w-full btn-ghost text-xs">
            Export CSV
          </button>
          <button onClick={() => exportPairs('json')} disabled={exporting} className="w-full btn-ghost text-xs">
            Export JSON
          </button>
        </div>
      </div>

      {/* ── Main pair review ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-800 bg-gray-950 shrink-0">
          <span className="text-xs text-gray-500">
            {filteredPairs.length > 0 ? `${currentIdx + 1} / ${filteredPairs.length}` : '0 / 0'}
          </span>
          <select
            value={sort}
            onChange={(e) => { setSort(e.target.value as typeof sort); setCurrentId(null) }}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
          >
            <option value="pending-first">Pending first</option>
            <option value="score-desc">Score ↓</option>
            <option value="score-asc">Score ↑</option>
          </select>
          <div className="flex-1" />
          <button onClick={() => setShowShortcuts(true)} className="btn-ghost text-xs">?</button>
          <div
            title={!hasApiKey ? 'Set an Anthropic API key in Settings to enable AI classification' : undefined}
            className="inline-flex"
          >
            <button
              onClick={() => setShowAutoClassify(true)}
              disabled={!hasApiKey || pendingCount === 0}
              className="btn-secondary text-xs px-3 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ✦ AI Classify…
            </button>
          </div>
          <button onClick={() => setScreen('configure')} className="btn-secondary text-xs px-3">
            Re-run Compute →
          </button>
          <button onClick={() => setShowMerge(true)} className="btn-primary text-xs px-3">
            Apply Merges…
          </button>
        </div>

        {/* Pair content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {!currentPair ? (
            <div className="text-center py-20 text-gray-600">
              <p className="text-lg">All done!</p>
              <p className="text-sm mt-1">No pairs match the current filter.</p>
            </div>
          ) : (
            <>
              {/* Property comparison table */}
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <div className="grid grid-cols-[1fr_1fr_1fr] bg-gray-950 px-4 py-2 text-xs font-medium text-gray-400 border-b border-gray-800">
                  <div>Property</div>
                  <div>Node A</div>
                  <div>Node B</div>
                </div>
                <div className="divide-y divide-gray-800/50">
                  {(() => {
                    const allKeys = new Set([
                      ...Object.keys(currentPair.nodeA.properties),
                      ...Object.keys(currentPair.nodeB.properties),
                    ])
                    return Array.from(allKeys).map((key) => {
                      const va = currentPair.nodeA.properties[key]
                      const vb = currentPair.nodeB.properties[key]
                      const differs = JSON.stringify(va) !== JSON.stringify(vb)
                      return (
                        <div
                          key={key}
                          className={`grid grid-cols-[1fr_1fr_1fr] px-4 py-2 text-xs ${differs ? 'bg-amber-950/20' : ''}`}
                        >
                          <div className="text-gray-500 font-mono">{key}</div>
                          <div className={`text-gray-200 break-words pr-4 ${differs ? 'text-amber-200' : ''}`}>
                            {va == null ? <span className="text-gray-700">—</span> : String(va).slice(0, 200)}
                          </div>
                          <div className={`text-gray-200 break-words ${differs ? 'text-amber-200' : ''}`}>
                            {vb == null ? <span className="text-gray-700">—</span> : String(vb).slice(0, 200)}
                          </div>
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>

              {/* Scores */}
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">Scores</h3>
                {currentPair.scores.map((s) => {
                  const threshold = session.fields
                    .find((f) => f.propertyName === s.fieldName)
                    ?.metrics.find((m) => m.metricId === s.metricId)
                    ?.threshold ?? 0.8
                  return (
                    <div key={`${s.fieldName}:${s.metricId}`} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span>
                          <span className="text-gray-300">{s.fieldName}</span>
                          <span className="text-gray-600 mx-1">·</span>
                          <span className="text-gray-500">{s.metricId}</span>
                        </span>
                        <span className={`font-mono font-medium ${s.aboveThreshold ? 'text-emerald-400' : 'text-gray-400'}`}>
                          {s.score.toFixed(3)}
                          {s.aboveThreshold && <span className="ml-1 text-emerald-600">✓</span>}
                        </span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${scoreColor(s.score, threshold)}`}
                          style={{ width: `${s.score * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Node relationships + source passages (per node) */}
              {(['A', 'B'] as const).map((side) => {
                const node = side === 'A' ? currentPair.nodeA : currentPair.nodeB
                return (
                  <div key={side} className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                    <div className="px-4 py-2.5 bg-gray-950 text-xs font-medium text-gray-400">
                      Node {side}
                    </div>
                    <NodeRelationships key={`rel-${node.id}`} nodeId={node.id} />
                    <SourcePassages key={`src-${node.id}`} nodeId={node.id} />
                  </div>
                )
              })}

              {/* Note */}
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">Note</h3>
                  {!editingNote && (
                    <button
                      onClick={() => { setEditingNote(true); setTimeout(() => noteRef.current?.focus(), 50) }}
                      className="text-xs text-gray-500 hover:text-gray-300"
                    >
                      {currentPair.note ? 'Edit' : '+ Add note'}
                    </button>
                  )}
                </div>
                {editingNote ? (
                  <div className="space-y-2">
                    <textarea
                      ref={noteRef}
                      rows={3}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 resize-none"
                      placeholder="Add a note about this pair…"
                    />
                    <div className="flex gap-2">
                      <button onClick={saveNote} disabled={saving} className="btn-primary text-xs px-3">
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => { setEditingNote(false); setNoteText(currentPair.note ?? '') }} className="btn-ghost text-xs">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">
                    {currentPair.note || <span className="text-gray-700">No note</span>}
                  </p>
                )}
              </div>

              {/* Verdict actions */}
              <div className="flex items-center gap-3 pb-6">
                <button onClick={() => markVerdict('duplicate')} className="flex-1 py-3 rounded-xl font-semibold text-sm bg-emerald-900 hover:bg-emerald-800 text-emerald-300 border border-emerald-800 transition-colors">
                  Duplicate (D)
                </button>
                <button onClick={() => markVerdict('distinct')} className="flex-1 py-3 rounded-xl font-semibold text-sm bg-red-900 hover:bg-red-800 text-red-300 border border-red-800 transition-colors">
                  Distinct (X)
                </button>
                <div className="flex flex-col gap-2">
                  <button onClick={goPrev} disabled={currentIdx === 0} className="btn-ghost text-xs px-4">
                    ← Prev
                  </button>
                  <button onClick={goNext} disabled={currentIdx >= filteredPairs.length - 1} className="btn-ghost text-xs px-4">
                    Next →
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Current verdict status bar */}
        {currentPair && (
          <div className={`shrink-0 px-5 py-2 text-xs text-center font-medium border-t border-gray-800 ${
            currentPair.verdict === 'duplicate' ? 'bg-emerald-950 text-emerald-400' :
            currentPair.verdict === 'distinct' ? 'bg-red-950 text-red-400' :
            'bg-gray-950 text-gray-500'
          }`}>
            {currentPair.verdict === 'pending' ? 'Pending review' :
             currentPair.verdict === 'duplicate' ? '✓ Marked as Duplicate' :
             '✗ Marked as Distinct'}
          </div>
        )}
      </div>

      {/* ── Assistant sidebar ── */}
      {session && (
        <AssistantPanel
          sessionId={session.id}
          pairId={currentPair?.id}
          suggestedPrompts={[
            'Explain the similarity scores for this pair',
            'What threshold should I use for this metric?',
            'Should I mark this pair as a duplicate?',
            'Summarize the review progress',
          ]}
        />
      )}

      {/* Overlays */}
      {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
      {showMerge && (
        <MergeModal
          sessionId={session.id}
          onClose={() => setShowMerge(false)}
          onApplied={handleMergeApplied}
          onGoToSessions={() => { setShowMerge(false); setScreen('sessions') }}
          addToast={addToast}
        />
      )}

      {showAutoClassify && (
        <AutoClassifyModal
          sessionId={session.id}
          pendingCount={pendingCount}
          onClose={() => setShowAutoClassify(false)}
          onDone={handleAutoClassifyDone}
          addToast={addToast}
        />
      )}
    </div>
  )
}
