import { useState, useEffect } from 'react'
import { useStore } from '../store'
import type { Session } from '../../../shared/types'

const STATUS_LABEL: Record<Session['status'], string> = {
  configuring: 'Configuring',
  computing: 'Computing',
  reviewing: 'Reviewing',
  'merges-applied': 'Merged',
}

const STATUS_COLOR: Record<Session['status'], string> = {
  configuring: 'bg-gray-700 text-gray-300',
  computing: 'bg-blue-900 text-blue-300',
  reviewing: 'bg-amber-900 text-amber-300',
  'merges-applied': 'bg-emerald-900 text-emerald-300',
}

function displayDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SessionListScreen() {
  const { connection, schema, setSession, setPairs, setScreen, setDistributions, addToast } = useStore()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)

  async function loadSessions() {
    // Never fall back to listing every connection's sessions — one SQLite file
    // holds them all, so an unfiltered list mixes databases together.
    if (!connection) {
      setSessions([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const list = await window.api.session.list(connection.id)
      setSessions([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    } finally {
      setLoading(false)
    }
  }

  // Re-runs when the connection changes; without the dependency the list would
  // keep showing the previous database's sessions.
  useEffect(() => { loadSessions() }, [connection?.id])

  async function resumeSession(s: Session) {
    setResumingId(s.id)
    try {
      const fresh = await window.api.session.load(s.id)
      setSession(fresh)
      if (fresh.status === 'reviewing' || fresh.status === 'merges-applied') {
        const pairs = await window.api.pairs.list(fresh.id)
        setPairs(pairs)
        setScreen('review')
      } else if (fresh.status === 'configuring') {
        setScreen('configure')
      } else {
        setScreen('review')
      }
    } catch (err) {
      addToast(`Failed to resume: ${(err as Error).message}`, 'error')
    } finally {
      setResumingId(null)
    }
  }

  async function deleteSession(id: string) {
    if (!confirm('Delete this session and all its pair data?')) return
    setDeletingId(id)
    try {
      await window.api.session.delete(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      addToast('Session deleted')
    } catch (err) {
      addToast(`Delete failed: ${(err as Error).message}`, 'error')
    } finally {
      setDeletingId(null)
    }
  }

  function newSession() {
    setSession(null)
    setPairs([])
    setDistributions(null)
    setScreen('configure')
  }

  // Pair counts summary for a session
  function pairSummary(s: Session) {
    // We don't load pairs here — show merge pass info if available
    if (s.mergePasses.length > 0) {
      const last = s.mergePasses[s.mergePasses.length - 1]
      return `${last.groupsApplied} groups merged`
    }
    return null
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto py-12 px-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Sessions</h1>
            {connection && (
              <p className="text-gray-400 text-sm mt-0.5">
                {connection.name} · {schema?.labels.length ?? 0} labels
              </p>
            )}
          </div>
          <button onClick={newSession} className="btn-primary">
            + New Session
          </button>
        </div>

        {/* Schema summary chips */}
        {schema && (
          <div className="flex flex-wrap gap-2">
            {schema.labels.slice(0, 8).map((l) => (
              <span key={l.name} className="px-2 py-0.5 bg-gray-800 rounded-full text-xs text-gray-400">
                {l.name} <span className="text-gray-600">({l.count.toLocaleString()})</span>
              </span>
            ))}
            {schema.labels.length > 8 && (
              <span className="px-2 py-0.5 text-xs text-gray-600">+{schema.labels.length - 8} more</span>
            )}
          </div>
        )}

        {/* Session list */}
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : !connection ? (
          <div className="text-center py-16 text-gray-600">
            <p className="text-lg">Not connected</p>
            <p className="text-sm mt-1">
              Connect to a Neo4j instance to see the sessions saved for it.
            </p>
            <button onClick={() => setScreen('connect')} className="btn-secondary text-xs mt-4">
              Choose a connection
            </button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-16 text-gray-600">
            <p className="text-lg">No sessions yet</p>
            <p className="text-sm mt-1">
              Create a new session to start deduplicating entities in {connection.name}.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((s) => {
              const summary = pairSummary(s)
              return (
                <div key={s.id} className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{s.label}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[s.status]}`}>
                          {STATUS_LABEL[s.status]}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {s.fields.map((f) => f.propertyName).join(', ')} · Updated {displayDate(s.updatedAt)}
                      </div>
                      {summary && <div className="text-xs text-emerald-400">{summary}</div>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => deleteSession(s.id)}
                        disabled={deletingId === s.id}
                        className="btn-ghost text-xs text-red-400 hover:text-red-300"
                      >
                        {deletingId === s.id ? '…' : 'Delete'}
                      </button>
                      <button
                        onClick={() => resumeSession(s)}
                        disabled={resumingId === s.id}
                        className="btn-primary text-xs px-4"
                      >
                        {resumingId === s.id ? 'Loading…' : s.status === 'configuring' ? 'Configure' : 'Resume'}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
