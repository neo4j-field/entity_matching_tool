import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import ScoreHistogram from '../components/ScoreHistogram'
import type { ScoreDistributions, Session } from '../../../shared/types'

interface ProgressEntry {
  metricId: string
  fieldName: string
  pct: number
  pairsAbove: number
}

export default function ComputeScreen() {
  const { session, setSession, setScreen, setPairs, setDistributions, addToast, schema } = useStore()
  const [progress, setProgress] = useState<Map<string, ProgressEntry>>(new Map())
  const [done, setDone] = useState(false)
  const [dists, setDists] = useState<ScoreDistributions | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const startedRef = useRef(false)

  // Per-metric threshold overrides (for "adjust thresholds" UI)
  const [thresholds, setThresholds] = useState<Record<string, number>>({})

  useEffect(() => {
    // Register listeners unconditionally so StrictMode's mount→cleanup→remount cycle
    // doesn't leave us with no listeners when the main process sends COMPUTE_DONE.
    const offProgress = window.api.compute.onProgress((data) => {
      setProgress((prev) => {
        const next = new Map(prev)
        next.set(`${data.fieldName}:${data.metricId}`, data)
        return next
      })
    })

    const offDone = window.api.compute.onDone((d) => {
      setDists(d)
      setDone(true)
      // Compute persists the capture cursor itself, so the copy in the store is
      // now stale. proceed() spreads that copy over a save — without this reload
      // it writes the pre-run cursor back and the next capture starts over.
      if (session) window.api.session.load(session.id).then(setSession)
      if (session) {
        const init: Record<string, number> = {}
        for (const f of session.fields) {
          for (const m of f.metrics) {
            init[`${f.propertyName}:${m.metricId}`] = m.threshold
          }
        }
        setThresholds(init)
      }
    })

    // Only start compute once — startedRef survives the StrictMode remount
    if (session && !startedRef.current) {
      startedRef.current = true
      window.api.compute.start(session.id).catch((err) => {
        addToast(`Compute failed: ${(err as Error).message}`, 'error')
      })
    }

    return () => { offProgress(); offDone() }
  }, [session])

  async function cancel() {
    setCancelling(true)
    await window.api.compute.cancel()
    setScreen('sessions')
  }

  async function proceed() {
    if (!session || !dists) return

    // Save adjusted thresholds back to session if changed
    const updatedSession: Session = {
      ...session,
      status: 'reviewing',
      fields: session.fields.map((f) => ({
        ...f,
        metrics: f.metrics.map((m) => ({
          ...m,
          threshold: thresholds[`${f.propertyName}:${m.metricId}`] ?? m.threshold,
        })),
      })),
    }
    await window.api.session.save(updatedSession)
    setSession(updatedSession)
    setDistributions(dists)
    const pairs = await window.api.pairs.list(session.id)
    setPairs(pairs)
    setScreen('review')
  }

  const capture = session?.capture
  const labelCount = schema?.labels.find((l) => l.name === session?.label)?.count ?? 0
  // A node is compared against every partner sharing its prefix, so walking it
  // covers pairs on both sides. After k of N nodes the reachable share of pairs
  // is 1 - (1 - k/N)^2 — well ahead of k/N, which is why a partial capture is
  // worth reviewing rather than a fraction of an answer.
  const coveragePct =
    labelCount && capture
      ? (100 * (1 - Math.pow(1 - capture.nodesWalked / labelCount, 2))).toFixed(1)
      : '0'

  const entries = Array.from(progress.values())
  const overallPct =
    entries.length > 0
      ? Math.round(entries.reduce((sum, e) => sum + e.pct, 0) / entries.length)
      : 0

  return (
    <div className="h-full flex items-start justify-center overflow-y-auto">
      <div className="w-full max-w-2xl py-12 px-6 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Computing Scores</h1>
          <p className="text-gray-400 text-sm mt-1">
            {session?.label} · Evaluating pairwise similarity metrics…
          </p>
        </div>

        {/* Overall progress */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Overall</span>
            <span>{overallPct}%</span>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${overallPct}%` }}
            />
          </div>
        </div>

        {/* Per-metric progress */}
        {!done && entries.length > 0 && (
          <div className="space-y-3">
            {entries.map((e) => (
              <div key={`${e.fieldName}:${e.metricId}`} className="space-y-1">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>
                    <span className="text-gray-300">{e.fieldName}</span>
                    <span className="text-gray-600 mx-1">·</span>
                    {e.metricId}
                  </span>
                  <span>{Math.round(e.pct)}%</span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-700 transition-all duration-200"
                    style={{ width: `${e.pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* How candidates were chosen — the largest single determinant of what
            reaches the queue, and previously not reported at all. */}
        {done && dists?.candidates && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 space-y-1">
            <p className="text-sm text-white">
              {dists.candidates.strategy === 'exhaustive'
                ? 'Every pair was compared'
                : 'Pairs sharing a word were compared'}
            </p>
            <p className="text-xs text-gray-400">
              {dists.candidates.strategy === 'exhaustive' ? (
                <>
                  {dists.candidates.nodes.toLocaleString()} nodes,{' '}
                  {dists.candidates.pairs.toLocaleString()} pairs — small enough to compare
                  completely, so nothing was ruled out before scoring.
                </>
              ) : (
                <>
                  {dists.candidates.pairs.toLocaleString()} pairs scored across{' '}
                  {dists.candidates.nodes.toLocaleString()} nodes. Two records that share no word on
                  any field were never compared, so duplicates spelled differently enough will not
                  appear here.
                </>
              )}
            </p>
          </div>
        )}

        {done && dists?.candidates?.strategy === 'prefix' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 space-y-1">
            <p className="text-sm text-white">
              {dists.candidates.complete
                ? 'The whole label was walked'
                : 'Part of the label was walked'}
            </p>
            <p className="text-xs text-gray-400">
              {dists.candidates.nodes.toLocaleString()} nodes compared against everything sharing
              their first {session?.blockingPrefixLength ?? 8} characters of{' '}
              <span className="text-gray-300">{session?.blockingField}</span>, surfacing{' '}
              {dists.candidates.pairs.toLocaleString()} pairs.
              {!dists.candidates.complete && (
                <>
                  {' '}This pass stopped on its budget rather than at the end of the label. Review
                  what it found, then capture more — the next pass resumes where this one stopped
                  and adds to the same queue.
                </>
              )}
            </p>
            {!dists.candidates.complete && capture && (
              <p className="text-xs text-gray-500 pt-0.5">
                {capture.nodesWalked.toLocaleString()} of{' '}
                {labelCount ? labelCount.toLocaleString() : '?'} nodes walked
                {labelCount ? ` · ${coveragePct}% of pairs reachable so far` : ''}
              </p>
            )}
          </div>
        )}

        {/* Score distributions with histograms */}
        {done && dists && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-white">Score Distributions</h3>
                <p className="text-xs text-gray-500">
                  Click or drag the red threshold marker to adjust before proceeding.
                </p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">
                  These are the same thresholds you set on{' '}
                  <span className="text-gray-300">Fields &amp; Metrics</span>, now shown against the
                  scores your data actually produced — so you can place each one where the
                  distribution suggests rather than guessing up front. Changes are saved back to the
                  session when you proceed.
                </p>
                <p className="text-xs text-gray-500 mt-1.5">
                  As before, these mark a score as a match for review and for the AI. They do not
                  change which pairs are in the queue — that was fixed by the Surfacing Rule when
                  compute ran.
                </p>
              </div>
            </div>

            {dists.all.map((d) => {
              const key = `${d.fieldName}:${d.metricId}`
              const currentThreshold = thresholds[key] ?? 0.8
              const above = (() => {
                // estimate from percentiles
                const t = currentThreshold
                if (t <= 0) return 1
                if (t > d.max) return 0
                const pts: [number, number][] = [
                  [0, 0], [d.p50, 0.5], [d.p75, 0.75], [d.p90, 0.9], [d.p95, 0.95], [d.max, 1.0],
                ]
                for (let i = 0; i < pts.length - 1; i++) {
                  const [x0, y0] = pts[i]
                  const [x1, y1] = pts[i + 1]
                  if (t >= x0 && t <= x1) {
                    const frac = x1 === x0 ? y1 : y0 + ((t - x0) / (x1 - x0)) * (y1 - y0)
                    return Math.max(0, 1 - frac)
                  }
                }
                return 0
              })()

              return (
                <div key={key} className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">
                      <span className="text-white font-medium">{d.fieldName}</span>
                      <span className="text-gray-600 mx-1">·</span>
                      <span className="text-gray-400">{d.metricId}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>p50={d.p50.toFixed(2)}</span>
                      <span>p90={d.p90.toFixed(2)}</span>
                      <span>max={d.max.toFixed(2)}</span>
                    </div>
                  </div>

                  <ScoreHistogram
                    p50={d.p50}
                    p75={d.p75}
                    p90={d.p90}
                    p95={d.p95}
                    max={d.max}
                    threshold={currentThreshold}
                    onThresholdChange={(v) => setThresholds((prev) => ({ ...prev, [key]: v }))}
                  />

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">
                      Threshold:{' '}
                      <span className="text-red-400 font-mono">{currentThreshold.toFixed(2)}</span>
                    </span>
                    <span className={`font-medium ${above > 0.1 ? 'text-emerald-400' : above > 0 ? 'text-amber-400' : 'text-gray-500'}`}>
                      ≈{Math.round(above * 100)}% of pairs above threshold
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {!done && (
            <button onClick={cancel} disabled={cancelling} className="btn-secondary">
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {done && (
            <button onClick={proceed} className="btn-primary px-8">
              Proceed to Review →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
