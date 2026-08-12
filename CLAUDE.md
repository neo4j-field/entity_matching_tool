# CLAUDE.md — Entity Matching Prototype

Guidance for working in this repo. Read before making changes.

## Project overview

An Electron desktop app for deduplicating entity nodes in any Neo4j graph, with
additive support for graphs created with neo4j-graphrag-python (source passages
via `FROM_CHUNK`, and GraphRAG infrastructure labels hidden by default). The
scoring, review, and merge pipeline makes no assumptions about graph shape —
keep it that way when adding features. Stack: Electron 30+, electron-vite, React 18, TypeScript, Tailwind CSS, Zustand, better-sqlite3, Anthropic SDK, ONNX Runtime (via @huggingface/transformers).

All app code lives under `app/`. The repo root holds only `LICENSE`, `README.md`, `.gitignore`, and this file.

## Architecture

```
app/src/
  main/         Electron main process — all Node.js/native code lives here
  preload/      contextBridge only — exposes typed window.api to renderer
  renderer/     React UI (screens/, components/, store/, lib/)
  shared/       Types and IPC channel constants shared across all three layers
```

### IPC conventions

- All channel names are declared in `app/src/shared/ipc-channels.ts` as the `IPC` const — never use raw strings.
- `ipcRenderer.invoke` / `ipcMain.handle` for request-response.
- Push events (progress, streaming) use `event.sender.send()` from main; the preload wraps these with `ipcRenderer.on` and returns an unsubscribe function.
- The preload is a separate Vite bundle — after editing it, a full dev-server restart is required (hot reload does not pick up preload changes).

### State management

Single Zustand store at `app/src/renderer/src/store/index.ts`. Screen navigation is driven by the `screen` field. No React Router.

### Adding a metric

1. Create `app/src/main/metrics/my-metric.ts` implementing `MetricModule` from `app/src/main/metrics/types.ts`.
2. Register it in `app/src/main/metrics/registry.ts`.
3. Add its UI definition to `app/src/renderer/src/lib/metrics.ts`.

A metric's parameters are declared in two places — `paramSchema` in the renderer
definition, and `params.x` reads in the implementation — and nothing at runtime
connects them. Every param read ends in `?? default`, so a mismatch produces no
error, just a control that silently does nothing. Four had drifted before
`npm run check:params` existed; it runs as the first step of `npm run build` and
fails on a key declared but never read, or read but never declared.

### LLM usage, cost, and estimation

Every Claude call in the app is ledgered. Three call sites exist — auto-classify
(`main/index.ts`), config suggestion (`main/index.ts`), and assistant chat
(`main/assistant-service.ts`) — and each wraps its call in
`usage.recordCall(...)`. **A new LLM call site must do the same**, or its spend
becomes invisible.

- `app/src/main/pricing.ts` — bundled per-model rate catalog. Cache-write and
  cache-read rates are *derived* from the input rate (1.25×/2×/0.1×), so an
  override only sets input and output. Bump `PRICING_VERSION` when rates change.
- `app/src/main/usage-service.ts` — `llm_calls` (one row per API call) and
  `llm_jobs` (one row per multi-call run) tables, plus `estimateJob()`.
- Loop-driven jobs bracket their calls with `startJob` / `finishJob` so the
  estimator can derive per-unit token counts; one-shot calls pass `jobId: null`.
- Estimation falls back through: prior runs on this model → prior runs on any
  model → prompt-character extrapolation → no estimate.

### Batched auto-classify

`app/src/main/classify-service.ts` owns the auto-classify prompt. The shape is a
**cached run-invariant prefix** (dataset schema, metrics, score-percentile
calibration, and few-shot examples drawn from the user's own verdicts) plus a
per-call user message carrying N pairs, each tagged `[P1]`…`[Pn]`. Responses come
back as structured output validated against `BATCH_OUTPUT_SCHEMA`.

- The prefix is built **once** at job start and reused verbatim. Rebuilding it
  mid-run changes its bytes and cold-starts the cache on every call.
- Few-shot selection is deterministic (sorted, fixed stride, balanced across
  verdicts) for the same reason.
- Pairs the model doesn't return are retried individually — but only on a
  *partial* failure. A wholesale batch failure is almost always transport-level,
  so retrying it pair-by-pair would double the cost of an outage.
- Batch size, few-shot count, and prefix caching are user settings
  (`classifyBatchSize`, `classifyFewShotCount`, `classifyCachedPrefix`).

## Key constraints and gotchas

**React 18 StrictMode double-mount** — effects run twice in development. Any one-shot IPC listener or API call must be guarded with a `startedRef`:
```tsx
const startedRef = useRef(false)
useEffect(() => {
  if (startedRef.current) return
  startedRef.current = true
  // start the job
}, [])
```

**Sibling `key` props** — if two sibling components both derive their key from the same id (e.g. `NodeRelationships` and `SourcePassages` for the same node), they will silently share state. Always use a type prefix: `key={\`rel-${node.id}\`}` and `key={\`src-${node.id}\`}`.

**ONNX Runtime batch size** — the BGE semantic cosine pipeline crashes (`EXC_BREAKPOINT` in `AllocateMLValueTensorSelfOwnBufferHelper`) if given too many inputs at once. Hard limit: `BGE_BATCH_SIZE = 16`. The pipeline is cached as a module-level singleton (`bgeExtractor`) — do not re-instantiate per call. Input strings are truncated to 2000 chars before encoding.

**Neo4j Integer handling** — the Neo4j driver v6 returns `neo4j.Integer` for integer fields; these are not JS numbers. Use the `sanitize()` helper in `app/src/main/neo4j-int.ts` to convert before serialising to the renderer.

**Cancellable async loops** — use a module-level flag (`autoClassifyCancelled`) checked at the top of each loop iteration. Do not try to cancel mid-API-call; let the in-flight request finish, then stop. Return `{ classified, cancelled }` so the renderer can show a partial-result banner.

**Compute's memory model** — `runMetrics` holds one `(id, value)` per node per
field while scoring (~250 bytes/node measured), never full property maps. Those
are re-fetched afterwards by `loadSnapshots`, only for nodes that appear in a
candidate pair — a `NodeByElementIdSeek`, so it is a seek not a scan. Selecting
`properties(n)` in the per-field fetch, as it once did, costs ~900 bytes/node and
does not fit a multi-million-node label. The per-field result is consumed as an
async stream rather than `result.records` so the driver's record objects are
released as they are read.

The other axis is candidate pairs, ~325 bytes each while in flight.
`MAX_CANDIDATE_PAIRS` in `candidate-generator.ts` caps it at 5M, enforced
*inside* candidate generation rather than by the caller: metrics materialise
every pair before returning, so a wide configuration dies in there first — on a
647k-node label it hit V8's own ~16.7M-entry `Set` limit and threw "Set maximum
size exceeded". `tokenBucketPairs`, `exact-match`, `phonetic`, and
`semantic-cosine` each enforce it; a new pair-producing path must too.

**Pair ids are session-scoped** — `pairIdFor(sessionId, idA, idB)` in
`app/src/main/pair-id.ts`. `pairs.id` is the primary key, so an id built from
the node ids alone is shared by every session comparing those two nodes against
the same database: the second session's upsert hits `ON CONFLICT`, which does
not touch `session_id`, so the row stays owned by the first session and
`listPairs` never returns it. The symptom is a short queue with no error — one
session showed 4 pairs where its rule surfaced 11. `pair_scores` has the same
exposure through its `(pair_id, ...)` key, so the later session also overwrote
the earlier one's scores. `upsertPairs` still recognises the unscoped id within
the same session so recompute updates pre-scoping rows rather than duplicating
them; that shim and `legacyPairId` can go once no such session remains.

**Re-run compute** — detected via `session.status === 'reviewing' | 'merges-applied'` in ConfigureScreen. Uses `session.save` instead of `session.create`. The `upsertPairs` SQL uses `ON CONFLICT(id) DO UPDATE SET` but intentionally does **not** overwrite `verdict`, `decided_at`, or `note` — existing verdicts are preserved across recomputes.

**Session status** — the status field must be set explicitly when saving. `ComputeScreen.proceed()` must include `status: 'reviewing'` in the object passed to `session.save`; omitting it silently resets status to the previous value.

**Usage ledger has no FK to sessions** — `llm_calls.session_id` and
`llm_jobs.session_id` are deliberately unconstrained. Adding `REFERENCES
sessions(id) ON DELETE CASCADE` would silently erase lifetime spend history when
a session is deleted.

**Don't aggregate usage per loop iteration** — `getSessionUsage()` scans all
rows for the session. Calling it once per pair in auto-classify is O(n²). Use
`getJobTotals(jobId)` (primary-key lookup) for live progress.

**Failed LLM calls are still recorded** — with zero tokens and `ok = 0`. Jobs
finished as `'failed'`, or with `units_completed = 0`, are excluded from
`estimateJob()` samples so a broken run can't skew future estimates.

**A sub-floor cached prefix costs more, not less** — prompt caching only engages
above a model-specific minimum (4096 tokens on Haiku 4.5, the default model;
`cacheFloorFor()` in `pricing.ts`). Below it the breakpoint is silently ignored
and the whole prefix is re-sent at full price on every call, which is *worse*
than not having a rich prefix at all. `buildClassifyPlan()` counts the prefix via
the token-counting endpoint and the classify dialog reports eligibility — do not
remove that warning.

**Estimator samples are variant-scoped** — `llm_jobs.variant` records the prompt
shape (`batch:20+cache`). Changing batch size or cache setting starts a fresh
sample pool rather than blending incompatible per-unit token profiles. Any future
change to prompt shape needs a new variant string.

**Settings loading** — `App.tsx` loads settings on mount via `window.api.settings.get().then(setSettings)`. The `.then()` call must not be dropped; if it is, `store.settings` stays `null` and any feature gated on `settings.anthropicKey` will be permanently disabled.

## Conventions

- No comments unless the *why* is non-obvious. No docstrings.
- Tailwind only — no CSS modules or inline styles.
- All shared TypeScript types in `app/src/shared/types.ts`.
- SQLite access is synchronous (better-sqlite3); keep DB calls in main process only.
- Passwords stored in OS keychain via keytar, never in SQLite or plaintext.
- Planning documents (`*_SPEC.md`, `TASKS.md`) are gitignored at the repo root.
