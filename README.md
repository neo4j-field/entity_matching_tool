# Entity Resolution Tool for Neo4j

A desktop application for deduplicating entity nodes in any Neo4j graph, with extra support for graphs built by [neo4j-graphrag-python](https://github.com/neo4j/neo4j-graphrag-python).

Schema discovery, similarity scoring, review, and merging work against any labels and properties the database happens to have — nothing in the pipeline requires a particular graph shape. The GraphRAG-specific parts are additive: source-passage display and a sensible set of default hidden labels.

Built with Electron, React, TypeScript, and Tailwind CSS.

---

## What it does

The tool guides you through a four-step workflow:

1. **Connect** — Save a Bolt connection profile (credentials stored in the OS keychain via keytar, never in plaintext). Test connectivity and discover the graph schema automatically.
2. **Configure** — Select an entity label, choose which properties to compare, assign similarity metrics with per-metric thresholds, and set a surfacing rule that controls which pairs enter the review queue. If an Anthropic API key is set, the **✦ Ask AI to suggest** button will recommend fields, metrics, and thresholds based on the property names and sample values, with a per-field explanation of the reasoning.
3. **Compute** — Run pairwise similarity scoring across all nodes. Progress is streamed per metric. After completion, interactive score-distribution histograms let you adjust thresholds before proceeding.
4. **Review** — Work through the pair queue, mark each as **Duplicate** or **Distinct**, add notes, inspect relationships and source passages, and apply merges when ready. The **✦ AI Classify…** button previews the run — how many requests, the shared-prompt size, and the estimated cost — then, once you confirm, sends pending pairs to Claude in batches for automated Duplicate/Distinct recommendations with reasoning stored in the Notes field (cancelable mid-run, with running spend shown as it goes). Pairs you have already reviewed are included in the prompt as worked examples, so accuracy improves as you review. After applying merges, choose to return to the Session list or stay in review. Use **Re-run Compute →** to run a second scoring pass on the same session (e.g. to surface transitive duplicates after merging) — existing verdicts are preserved, and the pass only ever adds to the queue (see [Re-running compute](#re-running-compute)).

Sessions are persisted in SQLite.

---

## Re-running compute

**A re-run only ever adds to a session. It never removes pairs, and it never removes scores.**

A pass computes the pairs that the current configuration surfaces, then upserts them:

- Pairs it surfaces are inserted, or have their node snapshots refreshed if already present. A pair row belongs to exactly one session, so two sessions comparing the same nodes keep independent rows, scores, and verdicts.
- Scores are written per `(pair, metric, field)`, replacing that exact combination.
- **Verdicts, decision timestamps, and notes are never overwritten** — human and AI review survives any number of re-runs.

What it does *not* do follows from the same design:

- **A pair that no longer meets the surfacing rule stays in the queue.** Raising a threshold, removing a metric, or unchecking a field does not retire the pairs those settings originally surfaced.
- **Scores for a field you removed stay attached to their pairs.** The re-run simply never mentions that field, so nothing replaces those rows — and the review panel goes on showing a match on a field the session no longer compares.

This is deliberate: pruning the queue would mean deleting pairs a human or the AI had already ruled on. The trade is that a session accumulates the union of every configuration it has ever run under.

The practical consequence is worth stating plainly. If you configure a session with a broad field like `country · exact-match = 1.0`, compute, and then remove that field and re-run, the queue still holds every pair that country match produced — and the review panel still shows them matching on country.

**To get a queue that reflects only the current configuration, create a new session.** Re-run compute is for widening a search or re-scoring after a merge, not for narrowing one.

---

## Similarity metrics

| Metric | Best for | Configurable params |
|---|---|---|
| Exact Match | Identifiers, codes | Normalization |
| Edit Distance (Levenshtein ratio) | Short names, IDs | Min string length |
| Jaro-Winkler | Person/place names | Prefix weight |
| Token Jaccard | Multi-word names, text | Tokenization mode |
| Token Sort Ratio | Names with word reordering | Tokenization mode |
| Phonetic (Double Metaphone) | Names with spelling variants | — |
| Numeric Proximity | Year, age, quantity fields | — |
| Semantic Cosine | Long text, descriptions | Backend: BGE (in-process) or a vector already stored on the node |

Candidate pairs are generated with a **token-bucket** approach (O(n × tokens), not O(n²)), so the tool stays fast even on large label sets.

**Exact Match and `Normalization`.** `nfkd-lower-strip` (the default) lowercases, applies Unicode NFKD, and replaces every non-alphanumeric character with a space before collapsing runs of whitespace. So `St. Louis` matches `St Louis` and `Reagan-National` matches `Reagan National`, but `Zürich` does not match `Zurich` — NFKD splits the umlaut into a combining mark, which is then replaced by a space. `none` compares the raw strings, so even `USA` and `usa` differ.

**Edit Distance and `Min string length`.** The Levenshtein ratio is a step function of length: on a four-character value one edit costs a flat 0.25, on a two-character value it costs 0.5. Below a few characters the score reports length more than similarity, so the metric **declines to score** a pair where either value is shorter than `Min string length` (default 3) rather than returning a number no threshold can use sensibly.

Declining is not failing. A field where every configured metric declined is skipped by All mode and dropped from both sides of the weighted-average ratio, exactly as a property neither node carries would be — so putting Edit Distance on a two-character field such as a US state code costs you that field, not your whole queue.

---

## Surfacing rules

Controls which scored pairs enter the review queue:

- **Any field** — surface if any field score meets its threshold
- **All fields** — surface only if every field *the two nodes can be compared on* meets its threshold
- **Weighted average** — surface if the weighted *mean* of field scores meets a combined threshold

**Estimate Pair Count** on the Configure screen answers the rule you have actually selected. It runs the real pipeline — candidate generation, score fill-in, and the same surfacing test compute uses — so All and Weighted Average are counted on real scores rather than on a candidate-pair bound. The number is exact.

Above 50,000 candidate pairs it scores an evenly spaced sample of nodes and scales the result by `C(N,2)/C(n,2)`, reporting how many nodes it sampled. That scaling is unbiased in expectation, because a pair survives sampling exactly when both its nodes do — but it is noisy when true duplicates are rare, so treat a sampled figure as an order of magnitude rather than a count.

### Missing properties, and why All is worded that way

Nodes in the same label rarely carry the same properties. All mode therefore judges a pair on the fields **both** nodes actually have, and ignores the rest — a record missing `airport_id` is compared on the fields it does have rather than being excluded outright. A pair with no comparable field in common never surfaces.

This matters more than it sounds, because a *missing score* and a *low score* are not the same thing. Metrics emit scores sparsely — the token-bucket pass only produces a score for records sharing a token — so an absent score cannot be read as a failure. Before applying the rule, the tool asks each metric directly for any score it needs and doesn't have, whenever both nodes carry the property. All mode is judged on real numbers, never on inferred failure.

Any mode is unaffected: it needs one field to clear its threshold, so absences are irrelevant. **Weighted average treats a missing field as a score of 0**, which pulls the mean down and can hold back a pair that matched well on everything it could be compared on. A field that is absent on most nodes is therefore a poor choice of weighted-average input.

Weights are **relative**. They are divided by their own total before the comparison, so what matters is their sizes against each other, not what they add up to — `0.5/0.5` and `0.1/0.1` behave identically. This division is what keeps the combined threshold meaningful: weights stop summing to 1 as soon as a field is removed or a slider is dragged, and comparing an unnormalized sum against a fixed threshold silently rescales it. Five fields still holding `1/9` each cap their total at `0.56`, so a `0.85` threshold could never be met no matter how well a pair matched.

---

## Review keyboard shortcuts

| Key | Action |
|---|---|
| `D` | Mark as Duplicate |
| `X` | Mark as Distinct |
| `J` / `→` | Next pair |
| `K` / `←` | Previous pair |
| `N` | Open note editor |
| `?` | Toggle shortcut overlay |
| `Esc` | Close overlays |

---

## Merging duplicates

The merge step uses **union-find** to group transitively connected duplicates into merge groups. Pairs you marked as Distinct are not merged even if they are in the same group transitively — only directly confirmed duplicates are joined.

For each group, the survivor node is chosen by highest degree (most relationships). Two merge paths are available:

- **APOC path** — a single `apoc.refactor.mergeNodes` call per group (recommended; available on Aura, requires APOC on self-managed)
- **Fallback path** — a manual Cypher transaction that collects all relationships, re-creates them on the survivor, then `DETACH DELETE`s absorbed nodes (no APOC dependency)

Property conflict strategy is selectable per merge pass: **discard** (keep survivor), **overwrite** (absorbed overwrites), or **combine** (merge arrays; needs the APOC path).

Every merge pass writes an audit record to SQLite (and optionally to the graph as `ERAuditRecord` nodes).

---

## GraphRAG integration

None of this is required, but the tool recognises neo4j-graphrag-python's conventions and takes advantage of them when present:

- `__Entity__`, `__KGBuilder__`, `Document`, `Chunk`, `_Bloom_Perspective_`, and `_Bloom_Scene_` are hidden from the label selector by default — the last two are Neo4j Bloom's, not GraphRAG's. This is just a default; edit the list in Settings for any other graph.
- Source passages are fetched via `(:Entity)-[:FROM_CHUNK]->(:Chunk)` and displayed inline in the review panel. The query is an `OPTIONAL MATCH`, so a graph without that structure simply shows no passages rather than failing.
- When **Neo4j storage** is enabled, decided pairs are written back as `(:ERPair)-[:INVOLVES]->(:Entity)` nodes, making deduplication decisions queryable from within the graph. This works on any graph — see [Writing results back to Neo4j](#writing-results-back-to-neo4j).

---

## Token use and cost

Every call to Claude is recorded — input, output, cache-read, and cache-write tokens are tracked separately, priced, and accumulated over the lifetime of the app.

- **Before a job runs**, the AI Classify dialog shows the estimated token use and a cost range, along with what the estimate is based on. The first run on a new setup extrapolates from the size of the prompts about to be sent; later runs are fitted from the token counts of previous runs, so the estimate tightens with use.
- **During a job**, spend updates per pair alongside the progress bar.
- **After any call**, the cost is shown where the work happened — under the AI suggestion on the Configure screen, and as session spend in the assistant panel.

### How auto-classify spends

Pending pairs are sent in batches (default 20 per request), behind a shared prompt prefix carrying the dataset schema, the active metrics, score-percentile calibration for this corpus, and worked examples taken from pairs you decided by hand.

That prefix is the same on every request, so it is marked for **prompt caching** — re-read at 10% of input price rather than re-sent at full price. Caching only engages above a per-model minimum (4096 tokens on Haiku 4.5, 1024 on Sonnet 5, 512 on Opus 5). **Below that minimum the prefix is re-sent in full on every call, which costs more than not having it** — so the classify dialog counts the prefix up front and tells you which side of the line you are on. Batch size, worked-example count, and caching are all adjustable under **Settings → AI Auto-classify**.

Note that output tokens are unaffected by any of this — each pair still needs its own verdict and reason — and on Haiku output is priced at 5× input, so it dominates the bill on most runs.

Costs are computed from a per-model rate table bundled with the app. Anthropic publishes no pricing API, so if a rate changes you can correct it under **Settings → Token Pricing** without waiting for a release; cache-write and cache-read rates are derived from the input rate automatically. Each recorded call is stamped with the pricing version in force at the time, so correcting a rate does not rewrite historical costs.

---

## Writing results back to Neo4j

Off by default. Under **Settings → Neo4j Storage** there are two toggles, the second dependent on the first.

**Write verdicts and audit records** creates, as each pair is decided:

```
(:ERPair {pairId, verdict, decidedBy, decidedAt, sessionId, note})
  -[:INVOLVES {role: 'nodeA'|'nodeB'}]-> (the compared nodes)
```

and, for each merge pass:

```
(:ERAuditRecord {id, sessionId, mergePassId, timestamp, label, conflictStrategy,
                 pairsDecidedByHuman, pairsDecidedByAi, pairsDecidedByUnknown})
  -[:MERGED_INTO]-> (survivor)
  -[:ABSORBED]->    (each absorbed node)
```

**Also record per-metric scores** adds one node per field and metric behind each verdict:

```
(:ERPair)-[:SCORED]->(:ERPairScore {pairId, fieldName, metricId, score, aboveThreshold})
```

The grain matches the internal score table — one node per `(pair, field, metric)`, not one per pair — so a pair compared on three fields with two metrics each carries up to six. Expect a few per decided pair, and note that a large session can therefore add tens of thousands of nodes.

Both writes are keyed by `MERGE`, so re-deciding a pair or re-running compute updates in place rather than accumulating duplicates. Supporting indexes are created automatically on first write. Everything is best-effort: a failed graph write never fails or blocks a verdict, which is always committed to SQLite first.

Scores are what make the graph independently useful — they let you interrogate the reasoning behind a decision:

```cypher
// Pairs judged distinct despite a very high similarity — check for a
// field that is surfacing candidates it shouldn't.
MATCH (p:ERPair {verdict: 'distinct'})-[:SCORED]->(s:ERPairScore)
WHERE s.score > 0.95
RETURN s.fieldName, s.metricId, count(*) AS pairs
ORDER BY pairs DESC
```

Every verdict records **who made it** — `decidedBy` is `human` or `ai` — and each audit record counts how the pairs behind that merge were decided, so you can ask whether a destructive merge rested on human judgement:

```cypher
MATCH (r:ERAuditRecord) WHERE r.pairsDecidedByHuman = 0
RETURN r.mergePassId, r.pairsDecidedByAi AS aiDecidedPairs
```

---

## Setup

### Prerequisites

- Node.js 18+
- A running Neo4j instance (5.x recommended)
- APOC Core — bundled with Aura, optional on self-managed. Enables the faster merge path and the combine property strategy; the tool falls back to plain Cypher without it.

### Install

```bash
cd app && npm install
```

### Development

```bash
cd app && npm run dev
```

### Build

`npm run build` runs `check:params`, then `typecheck`, then bundles. The
platform targets below bundle and package:

```bash
# macOS
cd app && npm run build:mac

# Windows
cd app && npm run build:win

# Linux
cd app && npm run build:linux
```

---

## Settings

Open **Settings** from the top nav bar.

| Setting | Description |
|---|---|
| Anthropic API Key | Powers three features: the assistant panel (chatbot), **AI Auto-classify** (bulk pair verdicts), and **AI field/metric suggestion** on the Configure screen. |
| Assistant Model | Powers the assistant, auto-classify, and field suggestions. Defaults to `claude-sonnet-5`. The list is generated from the pricing table, so every selectable model shows its current per-million-token rates. |
| AI Auto-classify | Pairs per request (default 20), worked examples drawn from your own verdicts (default 20), requests in parallel (default 4), and whether the shared prompt prefix is cached. |
| Token Pricing | Per-million-token input and output rates used to cost every Claude call. Ships with current rates; edit one if it changes, or reset to the bundled values. |
| Hidden Labels | Labels excluded from schema discovery. Defaults to GraphRAG infrastructure labels. |
| Neo4j Storage | Two toggles. The first writes verdicts and merge audit records back into the graph as first-class nodes; the second additionally records per-metric scores, and is only available when the first is on. |

---

## Data storage

| What | Where |
|---|---|
| Sessions, pairs, scores, audit records | `~/Library/Application Support/app/er-sessions.db` (macOS) — Electron's `userData` directory, named after `productName` in `electron-builder.yml` |
| LLM call ledger (tokens, cost, latency) | Same SQLite database. Retained when a session is deleted, so lifetime spend stays accurate. |
| Connection passwords | OS keychain via keytar |
| All other settings | Same SQLite database |

Sessions can be exported at any point from the review panel as CSV or JSON, filtered by verdict.

---

## Architecture

```
src/
  main/              Electron main process
    connection-service.ts   Neo4j driver, profile CRUD, keytar
    schema-service.ts       Schema discovery, PropertyKind inference
    session-service.ts      Session and pair CRUD, verdict upsert
    metric-runner.ts        Orchestrates metrics, surfacing, distributions
    candidate-generator.ts  Token bucketing — which pairs are worth scoring
    pair-id.ts              Session-scoped pair row ids
    merge-executor.ts       Union-find, APOC/fallback merge, audit
    assistant-service.ts    Anthropic SDK streaming
    usage-service.ts        LLM call/job ledger, aggregates, job estimation
    pricing.ts              Per-model token rates, cost computation, cache floors
    classify-service.ts     Cached prompt prefix, batching, structured parsing
    neo4j-storage.ts        Optional graph write-back
    concurrency.ts          Order-preserving bounded parallel map
    metrics/                Eight pluggable MetricModule implementations
  preload/           Typed contextBridge (window.api)
  renderer/          React UI
    screens/          ConnectScreen, SessionListScreen, ConfigureScreen,
                      ComputeScreen, ReviewScreen, SettingsScreen
    components/       AssistantPanel, ScoreHistogram, NodeRelationships,
                      SourcePassages, Toast
    store/            Zustand global state
    lib/metrics.ts    Metric definitions for the UI
    lib/usage.ts      Cost and token formatting helpers
  shared/
    types.ts          All shared TypeScript types
    ipc-channels.ts   Typed IPC channel constants
    constants.ts      Runtime defaults (model, batch size, concurrency)

scripts/
  check-metric-params.mjs   Build gate: metric params declared vs read
```

### Adding a new metric

1. Create `src/main/metrics/my-metric.ts` implementing the `MetricModule` interface from `src/main/metrics/types.ts`
2. Register it in `src/main/metrics/registry.ts`
3. Add its UI definition to `src/renderer/src/lib/metrics.ts` (display name, description, applicable PropertyKinds, default params)

Parameters are declared in two places — `paramSchema` in the UI definition, and
`params.x` reads in the implementation — and nothing at runtime connects them.
Every read ends in `?? default`, so a mismatched name produces a control that
silently does nothing rather than an error. `npm run check:params` compares the
two lists in both directions and runs as the first step of `npm run build`.
