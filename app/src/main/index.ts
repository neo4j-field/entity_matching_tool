import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'
import * as connection from './connection-service'
import * as schema from './schema-service'
import * as sessions from './session-service'
import * as mergeExec from './merge-executor'
import * as assistant from './assistant-service'
import { runMetrics, estimateSurfacedPairs } from './metric-runner'
import { getSettings, setSettings } from './settings-service'
import { getDb } from './db'
import * as neo4jStorage from './neo4j-storage'
import { toJsNumber } from './neo4j-int'
import * as usage from './usage-service'
import * as classify from './classify-service'
import { mapWithConcurrency, sleep } from './concurrency'
// Type-only: the runtime import stays lazy so the SDK isn't loaded at startup.
import type AnthropicClient from '@anthropic-ai/sdk'
import { listPricing, cacheFloorFor, modelsCachingAtOrBelow, normalizeModelId } from './pricing'
import { getCachedSchema } from './schema-service'
import type {
  Session,
  Verdict,
  CandidatePair,
  AISuggestion,
  AppSettings,
  ClassifyPlan,
  JobEstimate,
  LlmJobKind,
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let computeAbort: AbortController | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow!.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.neo4j.er-tool')
  app.on('browser-window-created', (_, win) => optimizer.watchWindowShortcuts(win))
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// Sampled rather than exhaustive: building every pair block just to size a
// preview would stall the UI on large queues.
const PROMPT_SAMPLE_SIZE = 25

function meanPairBlockChars(pairs: CandidatePair[]): number {
  if (pairs.length === 0) return 0
  const sample = pairs.slice(0, PROMPT_SAMPLE_SIZE)
  const total = sample.reduce((sum, p) => sum + classify.buildPairBlock(p, 'P00').length, 0)
  return Math.round(total / sample.length)
}

// Distinguishes prompt shapes whose per-unit token profile differs, so the
// estimator never mixes single-pair history into a batched run's forecast.
function classifyVariant(batchSize: number, cached: boolean): string {
  return `batch:${batchSize}${cached ? '+cache' : ''}`
}

const CHARS_PER_TOKEN_FALLBACK = 3.6

// Total attempts per batch, and the waits between them. The SDK already retries
// transient failures inside a single call, so these back off further rather
// than hammering.
const BATCH_ATTEMPTS = 3
const BATCH_RETRY_DELAYS_MS = [2000, 6000]

// Builds the run's cached prefix and everything derived from it. Returns the
// prefix text alongside the renderer-facing plan so the classify handler and
// the preview stay in lockstep — they must produce byte-identical prefixes.
async function buildClassifyPlan(
  client: AnthropicClient,
  sessionId: string,
  allPairs: CandidatePair[],
  settings: AppSettings
): Promise<{
  prefixText: string
  prefixTokens: number
  cacheRequested: boolean
  cacheEligible: boolean
  fewShotAvailable: number
  plan: ClassifyPlan
}> {
  const session = sessions.loadSession(sessionId)
  if (!session) throw new Error('Session not found')

  const model = settings.assistantModel
  const batchSize = Math.max(1, settings.classifyBatchSize)
  const pending = allPairs.filter((p) => p.verdict === 'pending')

  const { text: prefixText, fewShotUsed } = classify.buildPrefix({
    session,
    labelMeta: getCachedSchema()?.labels.find((l) => l.name === session.label) ?? null,
    allPairs,
    fewShotCount: settings.classifyFewShotCount,
  })

  // count_tokens is free and exact; fall back to a character ratio if it fails
  // so a network blip degrades the preview rather than breaking it.
  let prefixTokens: number
  let prefixTokensExact = true
  try {
    const counted = await client.messages.countTokens({
      model,
      system: [{ type: 'text', text: prefixText }],
      messages: [{ role: 'user', content: 'x' }],
    })
    prefixTokens = counted.input_tokens
  } catch {
    prefixTokens = Math.round(prefixText.length / CHARS_PER_TOKEN_FALLBACK)
    prefixTokensExact = false
  }

  const cacheFloor = cacheFloorFor(model)
  const cacheRequested = settings.classifyCachedPrefix
  const cacheEligible = prefixTokens >= cacheFloor
  const useCache = cacheRequested && cacheEligible

  // When the prefix misses the floor, work out what would actually fix it
  // rather than telling the user to "raise the count" and leaving them to guess
  // by how much, or whether they even have enough reviewed pairs to get there.
  const decidedPairCount = allPairs.filter((p) => p.verdict !== 'pending').length
  let suggestedFewShotCount: number | null = null
  let alternativeModel: ClassifyPlan['alternativeModel'] = null

  if (!cacheEligible) {
    const alt = modelsCachingAtOrBelow(prefixTokens, settings.pricingOverrides).find(
      (p) => p.modelId !== normalizeModelId(model)
    )
    alternativeModel = alt
      ? { id: alt.modelId, displayName: alt.displayName, cacheFloor: cacheFloorFor(alt.modelId) }
      : null

    if (fewShotUsed > 0 && decidedPairCount > fewShotUsed) {
      // Price one example by measuring the prefix without any, so the shortfall
      // converts to a concrete number of examples.
      const bare = classify.buildPrefix({
        session,
        labelMeta: getCachedSchema()?.labels.find((l) => l.name === session.label) ?? null,
        allPairs,
        fewShotCount: 0,
      })
      let baseTokens: number
      try {
        const counted = await client.messages.countTokens({
          model,
          system: [{ type: 'text', text: bare.text }],
          messages: [{ role: 'user', content: 'x' }],
        })
        baseTokens = counted.input_tokens
      } catch {
        baseTokens = Math.round(bare.text.length / CHARS_PER_TOKEN_FALLBACK)
      }
      const perExample = (prefixTokens - baseTokens) / fewShotUsed
      if (perExample > 0) {
        // Examples vary in size and the selection changes as the count changes,
        // so a straight extrapolation lands just under the floor as often as
        // over it. Aim past the floor rather than at it.
        const target = cacheFloor * 1.15
        const needed = Math.ceil((target - baseTokens) / perExample)
        if (needed <= decidedPairCount) suggestedFewShotCount = needed
      }
    }
  }

  const estimate = usage.estimateJob({
    kind: 'auto-classify',
    model,
    unitCount: pending.length,
    variant: classifyVariant(batchSize, useCache),
    concurrency: Math.max(1, settings.classifyConcurrency),
    promptCharsPerUnit: meanPairBlockChars(pending),
    // Two short lines per pair plus JSON scaffolding.
    outputTokensPerUnitHint: 55,
    batchSize,
    prefixTokens,
    prefixCacheable: useCache,
  })

  return {
    prefixText,
    prefixTokens,
    cacheRequested,
    cacheEligible,
    fewShotAvailable: fewShotUsed,
    plan: {
      estimate,
      batchSize,
      fewShotCount: settings.classifyFewShotCount,
      fewShotAvailable: fewShotUsed,
      prefixTokens,
      prefixTokensExact,
      cacheFloor,
      cacheRequested,
      cacheEligible,
      decidedPairCount,
      suggestedFewShotCount,
      alternativeModel,
    },
  }
}

// Schema-enforced shape for the field/metric suggestion, mirroring
// AISuggestion. Structured output removes the need to coax JSON out of prose
// and then strip markdown fences off it.
const SUGGEST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: '2-3 sentence summary of the strategy' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          propertyName: { type: 'string' },
          enabled: { type: 'boolean' },
          metrics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                metricId: { type: 'string' },
                threshold: { type: 'number' },
              },
              required: ['metricId', 'threshold'],
              additionalProperties: false,
            },
          },
          reason: {
            type: 'string',
            description: 'One sentence on why this field and these metrics',
          },
        },
        required: ['propertyName', 'enabled', 'metrics', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['explanation', 'fields'],
  additionalProperties: false,
}

// Pushes a completed call to the renderer so single-call features can show what
// they just spent. Loop-driven jobs report through their own progress channel.
function emitCall(record: import('../shared/types').LlmCallRecord): void {
  mainWindow?.webContents.send(IPC.USAGE_CALL, record)
}

// ── IPC Registration ──────────────────────────────────────────────────────────

function registerIpc() {
  // Connection
  ipcMain.handle(IPC.CONNECTION_SAVE, (_, p) => connection.saveProfile(p))
  ipcMain.handle(IPC.CONNECTION_LIST, () => connection.listProfiles())
  ipcMain.handle(IPC.CONNECTION_DELETE, (_, id: string) => connection.deleteProfile(id))
  ipcMain.handle(IPC.CONNECTION_TEST, (_, id: string) => connection.testConnection(id))
  ipcMain.handle(IPC.CONNECTION_CONNECT, async (_, id: string) => {
    await connection.connect(id)
    return schema.discoverSchema()
  })
  ipcMain.handle(IPC.CONNECTION_DISCONNECT, () => connection.disconnect())

  // Schema
  ipcMain.handle(IPC.SCHEMA_DISCOVER, () => schema.discoverSchema())
  ipcMain.handle(IPC.SCHEMA_ESTIMATE_PAIRS, async (_, sessionId: string) => {
    const session = sessions.loadSession(sessionId)
    if (!session) return { count: 0, exact: true, candidates: 0 }
    return estimateSurfacedPairs(session)
  })

  // Sessions
  ipcMain.handle(IPC.SESSION_LIST, (_, connectionId?: string) =>
    sessions.listSessions(connectionId)
  )
  ipcMain.handle(IPC.SESSION_CREATE, (_, partial: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>) =>
    sessions.createSession(partial)
  )
  ipcMain.handle(IPC.SESSION_LOAD, (_, id: string) => sessions.loadSession(id))
  ipcMain.handle(IPC.SESSION_SAVE, (_, session: Session) => sessions.saveSession(session))
  ipcMain.handle(IPC.SESSION_DELETE, (_, id: string) => sessions.deleteSession(id))

  // Compute
  ipcMain.handle(IPC.COMPUTE_START, async (event, sessionId: string) => {
    computeAbort?.abort()
    computeAbort = new AbortController()
    const session = sessions.loadSession(sessionId)
    if (!session) throw new Error('Session not found')
    const priorStatus = session.status
    sessions.saveSession({ ...session, status: 'computing' })

    try {
      const distributions = await runMetrics(
        session,
        (progress) => event.sender.send(IPC.COMPUTE_PROGRESS, progress),
        computeAbort.signal
      )
      sessions.saveSession({ ...sessions.loadSession(sessionId)!, status: 'reviewing' })
      event.sender.send(IPC.COMPUTE_DONE, distributions)
    } catch (err) {
      // A run that fails leaves the session marked 'computing' otherwise, which
      // it will still claim to be on the next launch. Compute can now refuse a
      // configuration outright — over the candidate-pair ceiling — so this is a
      // path the user can reach on purpose, not only through a driver error.
      sessions.saveSession({ ...sessions.loadSession(sessionId)!, status: priorStatus })
      if ((err as Error).name !== 'AbortError') throw err
    }
  })
  ipcMain.handle(IPC.COMPUTE_CANCEL, () => { computeAbort?.abort() })

  // Pairs
  ipcMain.handle(IPC.PAIRS_LIST, (_, sessionId: string) => sessions.listPairs(sessionId))
  ipcMain.handle(IPC.PAIRS_SET_VERDICT, async (_, pairId: string, verdict: Verdict) => {
    sessions.setVerdict(pairId, verdict, 'human')
    // Best-effort Neo4j write — never blocks or fails the verdict
    const pair = sessions.getPair(pairId)
    if (pair) neo4jStorage.writePairVerdict({ ...pair, verdict, decidedBy: 'human' }).catch(() => {})
  })
  ipcMain.handle(IPC.PAIRS_SET_NOTE, (_, pairId: string, note: string) =>
    sessions.setNote(pairId, note)
  )
  ipcMain.handle(IPC.PAIRS_EXPORT, async (_, sessionId: string, format: 'csv' | 'json', verdictFilter: string) => {
    const pairs = sessions.listPairs(sessionId)
    const filtered = verdictFilter === 'all' ? pairs : pairs.filter((p) => p.verdict === verdictFilter)
    if (format === 'json') return JSON.stringify(filtered, null, 2)
    // CSV
    const allMetricKeys = [...new Set(filtered.flatMap((p) => p.scores.map((s) => `${s.metricId}_${s.fieldName}`)))]
    const header = ['pair_id', 'node_a_id', 'node_a_display', 'node_b_id', 'node_b_display', 'verdict', 'decided_at', 'note', ...allMetricKeys]
    const displayVal = (props: Record<string, unknown>) =>
      String(props.name ?? props.title ?? props.heading ?? props.summary ?? props.text ?? '')
    const rows = filtered.map((p) => {
      const scoreMap = Object.fromEntries(p.scores.map((s) => [`${s.metricId}_${s.fieldName}`, s.score]))
      return [
        p.id, p.nodeA.id, displayVal(p.nodeA.properties),
        p.nodeB.id, displayVal(p.nodeB.properties),
        p.verdict, p.decidedAt ?? '', p.note ?? '',
        ...allMetricKeys.map((k) => scoreMap[k] ?? ''),
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
    })
    return [header.join(','), ...rows].join('\n')
  })

  // Merge
  ipcMain.handle(IPC.MERGE_DRY_RUN, (_, sessionId: string) =>
    mergeExec.buildMergeGroups(sessionId)
  )
  ipcMain.handle(IPC.MERGE_APPLY, async (_, sessionId: string, strategy: 'discard' | 'overwrite' | 'combine') => {
    const schemaModel = schema.getCachedSchema()
    const result = await mergeExec.applyMerges(sessionId, strategy, schemaModel?.apocAvailable ?? false)
    const session = sessions.loadSession(sessionId)!
    sessions.saveSession({
      ...session,
      status: 'merges-applied',
      mergePasses: [...session.mergePasses, {
        id: result.passId,
        appliedAt: new Date().toISOString(),
        groupsApplied: result.groupsApplied,
        groupsSkipped: result.groupsSkipped,
        groupsFailed: result.groupsFailed,
      }],
    })
    return result
  })

  // Audit
  ipcMain.handle(IPC.AUDIT_LIST, (_, sessionId: string) => {
    const rows = getDb()
      .prepare('SELECT * FROM audit_records WHERE session_id = ? ORDER BY timestamp DESC')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      mergePassId: r.merge_pass_id,
      timestamp: new Date(r.timestamp as number).toISOString(),
      label: r.label,
      survivorId: r.survivor_id,
      survivorProperties: JSON.parse(r.survivor_props as string),
      absorbedIds: JSON.parse(r.absorbed_ids as string),
      absorbedProperties: JSON.parse(r.absorbed_props as string),
      scores: JSON.parse(r.scores_json as string),
      conflictStrategy: r.conflict_strategy,
      // Records written before provenance existed have no attribution; report
      // that honestly rather than implying a human reviewed them.
      decidedBy: JSON.parse((r.decided_by_json as string) || '{}'),
      capture: r.capture_json ? JSON.parse(r.capture_json as string) : undefined,
    }))
  })

  // Assistant
  ipcMain.handle(IPC.ASSISTANT_SEND, async (event, sessionId: string, pairId: string | null, message: string) => {
    await assistant.sendMessage(
      sessionId, pairId, message,
      (chunk) => event.sender.send(IPC.ASSISTANT_CHUNK, chunk),
      () => event.sender.send(IPC.ASSISTANT_DONE),
      (record) => event.sender.send(IPC.USAGE_CALL, record)
    )
  })

  // Node detail
  ipcMain.handle(IPC.NODE_NEIGHBORS, async (_, nodeId: string) => {
    const driver = connection.getDriver()
    const neo4jSession = driver.session()
    try {
      const result = await neo4jSession.run(
        `MATCH (n) WHERE elementId(n) = $id
         OPTIONAL MATCH (n)-[r]->(target)
         WITH type(r) AS relType, 'out' AS dir,
              coalesce(target.name, target.title, target.text, elementId(target)) AS targetText,
              elementId(target) AS targetId
         WHERE relType IS NOT NULL
         RETURN relType, dir, targetId, targetText
         UNION ALL
         MATCH (n) WHERE elementId(n) = $id
         OPTIONAL MATCH (source)-[r]->(n)
         WITH type(r) AS relType, 'in' AS dir,
              coalesce(source.name, source.title, source.text, elementId(source)) AS targetText,
              elementId(source) AS targetId
         WHERE relType IS NOT NULL
         RETURN relType, dir, targetId, targetText`,
        { id: nodeId }
      )
      return result.records.map((r) => ({
        relType: r.get('relType') as string,
        direction: r.get('dir') as 'in' | 'out',
        targetId: r.get('targetId') as string,
        targetText: r.get('targetText') as string,
      }))
    } finally {
      await neo4jSession.close()
    }
  })

  ipcMain.handle(IPC.NODE_SOURCE_PASSAGES, async (_, nodeId: string) => {
    const driver = connection.getDriver()
    const neo4jSession = driver.session()
    try {
      const result = await neo4jSession.run(
        `MATCH (n) WHERE elementId(n) = $id
         OPTIONAL MATCH (n)-[:FROM_CHUNK]->(chunk:Chunk)
         WHERE chunk.text IS NOT NULL
         RETURN chunk.text AS text, coalesce(chunk.index, 0) AS chunkIndex
         ORDER BY chunkIndex`,
        { id: nodeId }
      )
      return result.records.map((r) => ({
        chunkIndex: toJsNumber(r.get('chunkIndex') ?? 0),
        text: r.get('text') as string,
      }))
    } finally {
      await neo4jSession.close()
    }
  })

  // AI auto-classify
  let autoClassifyCancelled = false

  ipcMain.handle(IPC.PAIRS_AUTO_CLASSIFY_CANCEL, () => { autoClassifyCancelled = true })

  ipcMain.handle(IPC.PAIRS_AUTO_CLASSIFY, async (event, sessionId: string) => {
    const settings = getSettings()
    if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set. Add it in Settings.')

    autoClassifyCancelled = false

    const allPairs = sessions.listPairs(sessionId)
    const pending = allPairs.filter((p) => p.verdict === 'pending')
    const total = pending.length

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: settings.anthropicApiKey })
    const model = settings.assistantModel
    const batchSize = Math.max(1, settings.classifyBatchSize)
    const concurrency = Math.max(1, settings.classifyConcurrency)

    const plan = await buildClassifyPlan(client, sessionId, allPairs, settings)
    // Snapshot the prefix for the whole run. Rebuilding it as verdicts land
    // would change its bytes and cold-start the cache on every call.
    const prefix = plan.prefixText
    const useCache = plan.cacheRequested && plan.cacheEligible

    const jobId = usage.startJob({
      kind: 'auto-classify',
      model,
      sessionId,
      unitCount: total,
      variant: classifyVariant(batchSize, useCache),
      features: {
        label: sessions.loadSession(sessionId)?.label ?? '',
        batchSize,
        prefixTokens: plan.prefixTokens,
        fewShotUsed: plan.fewShotAvailable,
        cacheEnabled: useCache ? 1 : 0,
        concurrency,
      },
    })

    const systemBlocks = useCache
      ? [{ type: 'text' as const, text: prefix, cache_control: { type: 'ephemeral' as const } }]
      : [{ type: 'text' as const, text: prefix }]

    let classified = 0
    let attempted = 0
    const decided = new Map<string, { verdict: Verdict; note: string }>()

    // Resolves one group of pairs, returning the pairs it could not classify.
    async function runBatch(batch: CandidatePair[], attempt = 1): Promise<CandidatePair[]> {
      const { text, tagToPairId } = classify.buildBatchMessage(batch)
      const startedAt = Date.now()
      const featureBase = { batchPairs: batch.length, promptChars: text.length, attempt }

      try {
        const msg = await client.messages.create({
          model,
          // Two short lines per pair, plus schema overhead.
          max_tokens: Math.min(8192, 120 * batch.length + 256),
          system: systemBlocks,
          messages: [{ role: 'user', content: text }],
          output_config: { format: { type: 'json_schema', schema: classify.BATCH_OUTPUT_SCHEMA } },
        })

        usage.recordCall({
          jobId,
          sessionId,
          kind: 'auto-classify',
          model: msg.model,
          startedAt,
          tokens: usage.tokensFromUsage(msg.usage),
          ok: true,
          stopReason: msg.stop_reason,
          features: featureBase,
        })

        const raw = msg.content.find((b) => b.type === 'text')
        const { results, unresolvedTags } = classify.parseBatchResponse(
          raw?.type === 'text' ? raw.text : '',
          tagToPairId
        )

        const written: CandidatePair[] = []
        for (const r of results) {
          const note = `[AI] ${r.reason}`
          sessions.setVerdict(r.pairId, r.verdict, 'ai')
          sessions.setNote(r.pairId, note)
          classified++
          decided.set(r.pairId, { verdict: r.verdict, note })
          const pair = batch.find((p) => p.id === r.pairId)
          if (pair) written.push({ ...pair, verdict: r.verdict, note, decidedBy: 'ai' })
        }

        // Batched, and best-effort: a Neo4j write must never fail a verdict
        // already committed to SQLite. Writing per pair here would open a
        // session per pair and exhaust the driver pool under concurrency.
        if (written.length > 0) neo4jStorage.writePairVerdicts(written).catch(() => {})

        const unresolvedIds = new Set(
          unresolvedTags.map((t) => tagToPairId.get(t)).filter((id): id is string => Boolean(id))
        )
        return batch.filter((p) => unresolvedIds.has(p.id))
      } catch (err) {
        // A failed call still consumed the request; log it so the ledger and the
        // failure rate stay honest.
        usage.recordCall({
          jobId,
          sessionId,
          kind: 'auto-classify',
          model,
          startedAt,
          tokens: usage.emptyTokens(),
          ok: false,
          error: (err as Error).message,
          features: featureBase,
        })

        // The SDK already retried transient errors within this call, so retry
        // the batch on a delay rather than immediately — over a multi-hour run
        // the losses are network blips, and without this each one silently
        // drops a whole batch of pairs.
        if (attempt < BATCH_ATTEMPTS && !autoClassifyCancelled) {
          await sleep(BATCH_RETRY_DELAYS_MS[attempt - 1] ?? 5000)
          if (autoClassifyCancelled) return batch
          return runBatch(batch, attempt + 1)
        }
        return batch
      }
    }

    // Processes one batch end to end: the call, the per-pair retry for
    // stragglers, and the progress events for every pair in it.
    async function processBatch(batch: CandidatePair[]): Promise<void> {
      // Cancellation is checked per batch, so cancelling costs up to
      // batchSize - 1 pairs of in-flight work per worker.
      if (autoClassifyCancelled) return
      attempted += batch.length

      let unresolved = await runBatch(batch)

      // Retry stragglers individually. A batch that failed wholesale is far more
      // likely to be a transport error than a per-pair one, so only retry
      // partial failures — otherwise one outage costs a second full pass.
      if (unresolved.length > 0 && unresolved.length < batch.length) {
        for (const pair of unresolved) {
          if (autoClassifyCancelled) break
          await runBatch([pair])
        }
        unresolved = []
      }

      const totals = usage.getJobTotals(jobId)
      for (const pair of batch) {
        const outcome = decided.get(pair.id)
        event.sender.send(IPC.PAIRS_AUTO_CLASSIFY_PROGRESS, {
          pairId: pair.id,
          verdict: outcome?.verdict ?? null,
          note: outcome?.note ?? null,
          completed: classified,
          total,
          usage: totals,
        })
      }
    }

    const batches: CandidatePair[][] = []
    for (let i = 0; i < pending.length; i += batchSize) {
      batches.push(pending.slice(i, i + batchSize))
    }

    // Run the first batch alone before fanning out. A cache entry only becomes
    // readable once the writing response has started coming back, so N parallel
    // calls at a cold start would each pay the write premium instead of one
    // writing and the rest reading.
    if (useCache && batches.length > 1) {
      await processBatch(batches[0])
      await mapWithConcurrency(batches.slice(1), concurrency, processBatch)
    } else {
      await mapWithConcurrency(batches, concurrency, processBatch)
    }

    usage.finishJob(jobId, autoClassifyCancelled ? 'cancelled' : 'complete', attempted)

    return {
      classified,
      cancelled: autoClassifyCancelled,
      usage: usage.getSessionUsage(sessionId).totals,
    }
  })

  ipcMain.handle(IPC.CLASSIFY_PLAN, async (_, sessionId: string): Promise<ClassifyPlan> => {
    const settings = getSettings()
    if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set. Add it in Settings.')

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: settings.anthropicApiKey })
    const allPairs = sessions.listPairs(sessionId)
    const plan = await buildClassifyPlan(client, sessionId, allPairs, settings)
    return plan.plan
  })

  // Settings
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_, partial) => setSettings(partial))

  // Usage, cost, and estimation
  ipcMain.handle(IPC.USAGE_SESSION, (_, sessionId: string) => usage.getSessionUsage(sessionId))
  ipcMain.handle(IPC.USAGE_LIFETIME, () => usage.getLifetimeUsage())
  ipcMain.handle(IPC.USAGE_PRICING, () => listPricing(getSettings().pricingOverrides))

  // Auto-classify estimates go through IPC.CLASSIFY_PLAN instead — they need the
  // prefix built to size it.
  ipcMain.handle(
    IPC.USAGE_ESTIMATE,
    (_, kind: LlmJobKind): JobEstimate => {
      const model = getSettings().assistantModel
      return usage.estimateJob({ kind, model, unitCount: 1 })
    }
  )

  // AI configuration suggestion
  ipcMain.handle(IPC.CONFIGURE_SUGGEST, async (_, labelName: string, properties: { name: string; kind: string; sampleValues: string[] }[]): Promise<AISuggestion> => {
    const { anthropicApiKey, assistantModel } = getSettings()
    if (!anthropicApiKey) throw new Error('Anthropic API key not set. Add it in Settings.')

    const propLines = properties
      .map((p) => `  - ${p.name} (kind: ${p.kind}${p.sampleValues.length ? `; e.g. ${p.sampleValues.slice(0, 3).join(', ')}` : ''})`)
      .join('\n')

    const prompt = `You are configuring an entity deduplication system for a Neo4j knowledge graph.

The goal is to find duplicate "${labelName}" nodes. Here are the available properties:
${propLines}

Available metrics (id · description · applicable kinds · default threshold):
  - exact-match · Normalized exact string equality · name, identifier, text · 1.0
  - edit-distance · Levenshtein ratio · name, identifier, text · 0.85
  - jaro-winkler · Jaro-Winkler similarity, best for short names · name, identifier · 0.88
  - token-jaccard · Token set Jaccard, order-insensitive · name, text · 0.5
  - token-sort-ratio · Sort tokens then LCS ratio, handles reordered names · name, text · 0.85
  - phonetic · Double Metaphone sounds-alike · name · 1.0
  - numeric-proximity · Fractional closeness for numbers · numeric · 0.95
  - semantic-cosine · Sentence embedding cosine similarity · name, text · 0.92

Rules:
- Only suggest metrics that match the property's kind (e.g. do not suggest jaro-winkler for a "text" kind property).
- Prefer 2-3 complementary metrics per field rather than using all available ones.
- Disable fields that are administrative (IDs, timestamps, internal keys) or too sparse to be useful.
- Threshold adjustments: lower thresholds surface more pairs (higher recall), higher thresholds are more precise. Suggest adjustments only when the default is clearly wrong for the data.

Return one entry per property listed above, with a short explanation of the overall deduplication strategy.`

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: anthropicApiKey })
    const model = assistantModel
    const startedAt = Date.now()

    let msg: Awaited<ReturnType<typeof client.messages.create>>
    try {
      msg = await client.messages.create({
        model,
        // max_tokens caps thinking *plus* the response. Models that think by
        // default (Sonnet 5, Opus 5) spend part of this budget before writing
        // any JSON, so leave headroom or the object arrives truncated.
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: { type: 'json_schema', schema: SUGGEST_OUTPUT_SCHEMA } },
      })
    } catch (err) {
      emitCall(
        usage.recordCall({
          jobId: null,
          sessionId: null,
          kind: 'configure-suggest',
          model,
          startedAt,
          tokens: usage.emptyTokens(),
          ok: false,
          error: (err as Error).message,
          features: { promptChars: prompt.length, label: labelName },
        })
      )
      throw err
    }

    emitCall(
      usage.recordCall({
        jobId: null,
        sessionId: null,
        kind: 'configure-suggest',
        model: msg.model,
        startedAt,
        tokens: usage.tokensFromUsage(msg.usage),
        ok: true,
        stopReason: msg.stop_reason,
        features: {
          promptChars: prompt.length,
          label: labelName,
          propertyCount: properties.length,
        },
      })
    )

    // Find the text block rather than assuming index 0. On models that think by
    // default the first block is a thinking block, which made this read '' and
    // fail in JSON.parse with a misleading "invalid JSON" error.
    const textBlock = msg.content.find((b) => b.type === 'text')
    const raw = textBlock?.type === 'text' ? textBlock.text.trim() : ''

    if (msg.stop_reason === 'max_tokens') {
      throw new Error(
        'The suggestion was cut off before it finished. Try again, or reduce the number of properties.'
      )
    }
    if (!raw) {
      throw new Error(`${model} returned no suggestion text (stop reason: ${msg.stop_reason}).`)
    }

    try {
      return JSON.parse(raw) as AISuggestion
    } catch {
      throw new Error(`Could not read the suggestion from ${model}. Response began: ${raw.slice(0, 120)}`)
    }
  })
}
