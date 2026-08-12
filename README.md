# Entity Resolution Tool for Neo4j

A desktop application for deduplicating entity nodes in any Neo4j graph, with extra support for graphs built by [neo4j-graphrag-python](https://github.com/neo4j/neo4j-graphrag-python).

Schema discovery, similarity scoring, review, and merging work against any labels and properties the database happens to have — nothing in the pipeline requires a particular graph shape. The GraphRAG-specific parts are additive: source-passage display and a sensible set of default hidden labels.

Built with Electron, React, TypeScript, and Tailwind CSS.

---

## What it does

The tool guides you through a four-step workflow:

1. **Connect** — Save a Bolt connection profile (credentials stored in the OS keychain via keytar, never in plaintext). Test connectivity and discover the graph schema automatically.
2. **Configure** — Select an entity label, choose which properties to compare, assign similarity metrics with per-metric thresholds, and set a surfacing rule that controls which pairs enter the review queue. If an Anthropic API key is set, the **✦ Ask AI to suggest** button will recommend fields, metrics, and thresholds based on the property names and sample values, with a per-field explanation of the reasoning.
3. **Compute** — Score the candidate pairs the chosen blocking strategy produces. Progress is streamed per metric, and the summary reports how candidates were chosen and — for an incremental capture — how far the walk reached. After completion, interactive score-distribution histograms let you adjust thresholds before proceeding.
4. **Review** — Work through the pair queue, mark each as **Duplicate** or **Distinct**, add notes, inspect relationships and source passages, and apply merges when ready. The **✦ AI Classify…** button previews the run — how many requests, the shared-prompt size, and the estimated cost — then, once you confirm, sends pending pairs to Claude in batches for automated Duplicate/Distinct recommendations with reasoning stored in the Notes field (cancelable mid-run, with running spend shown as it goes). Pairs you have already reviewed are included in the prompt as worked examples, so accuracy improves as you review. After applying merges, choose to return to the Session list or stay in review. Use **Re-run Compute →** to run a second scoring pass on the same session (e.g. to surface transitive duplicates after merging) — existing verdicts are preserved, and the pass only ever adds to the queue (see [Re-running compute](#re-running-compute)). On a partially captured label, **Capture more** continues the walk from where it stopped; **Re-apply Thresholds** re-judges what is already captured without rescanning.

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

**To narrow a queue, use Re-apply Thresholds rather than a re-run** — see [Tuning thresholds without rescanning](#tuning-thresholds-without-rescanning). A re-run cannot do it, because it only ever adds. Changing *fields or metrics* is a different matter: those change what the scores mean, so a session that has run under several field configurations still accumulates their union, and a new session is the only clean answer.

---

## Choosing which pairs to compare

Comparing every pair of a label is quadratic, so past a few thousand nodes something has to decide which pairs are worth scoring at all. That decision is the single largest determinant of what reaches the review queue, and Configure exposes it directly.

| Strategy | How it picks candidates | Use when |
|---|---|---|
| **Auto** | Compares every pair below ~1,000 nodes; falls back to token bucketing above it | Small labels, or when you have no reason to override |
| **Exhaustive** | Every pair, up to 500,000 | The data is small and you cannot afford a miss |
| **Token bucket** | Pairs sharing a word on some field | The default at scale for labels that fit in memory |
| **Prefix** | Pairs sharing the first *n* characters of an indexed property | Labels too large to hold in memory |

The trade is a judgement about your data, not about its size, which is why the choice is yours to override. Exhaustive misses nothing and costs everything; the other two each buy their speed by not comparing something, and it is worth knowing what:

- **Token bucketing** never offers two records that share no word. Measured on a 244-node label, 824 of 29,646 possible pairs — 2.8% — were never scored at all. It also discards any token shared by more than **500** values, so a word common enough to be useless as a key stops blocking altogether: two records whose only shared word is `LIMITED` are never compared.
- **Prefix blocking** compares each node against at most **50** partners sharing its prefix. On a prefix that thousands of nodes share, the rest are not offered — which is the mechanism that keeps a dense block from exploding, and equally the reason a short prefix on a low-cardinality key finds little.

**Prefix blocking requires an index.** The predicate is `n.prop STARTS WITH x`, which plans as an index seek on a RANGE or TEXT index and as a full label scan per node without one — 0.26 ms per node against 13 seconds. Configure therefore offers only indexed properties as blocking keys. It cannot tell a good key from a bad one: pick something with many distinct values (`name`, `addressLine1`), not `status` or `country`, which are indexed and useless because a prefix of them describes millions of nodes.

`STARTS WITH` is also case- and punctuation-sensitive, and wrapping the property in `toLower()` would lose the index. Two spellings that differ in the blocked prefix land in different blocks and are never compared.

Prefix blocking cannot be combined with Semantic Cosine, which scores a whole set at once rather than pair by pair.

---

## Incremental capture

Prefix blocking walks the label in indexed order, which means it can *stop*. On a 6,342,823-node label a complete walk is roughly 27 minutes; a reviewable batch is a few seconds. A capture pass therefore stops on whichever of two budgets binds first — **100,000 candidates scored** or **2,000 pairs surfaced** — and records where it stopped.

Measured on that label, blocking on `name` at 12 characters:

| Pass | Nodes walked | Queue | Time |
|---|---|---|---|
| 1 | 110,000 | 2,017 | 27s |
| 2 | 170,000 | 4,173 | 16s |
| 3 | 205,000 | 6,300 | 11s |

Each pass resumes exactly where the last stopped and appends to the same queue; no pair is found twice. **Capture more** in the review panel runs the next pass.

**Coverage is not the fraction of nodes walked.** A walked node is compared against every partner sharing its prefix, so it covers pairs on both sides: after *k* of *N* nodes you hold `1 - (1 - k/N)²` of the possible pairs — 75% at half the nodes. The 110,000 nodes of pass 1 above are 1.7% of the label but 3.4% of its pairs.

**A partial capture is visible everywhere it matters.** The compute summary reports how far the walk reached, the review queue carries a partial-capture note, the merge dialog warns before the irreversible step, and the audit record — in SQLite and in the graph — stores whether the label was fully compared. Each merge from a partial capture is individually correct; what is not true is that the label has been deduplicated.

**The cursor is a `(value, elementId)` pair**, not a value, because a batch boundary can fall inside a run of equal values and resuming from the value alone would skip every node sharing it. A merge between passes can delete the node the cursor names; that is safe, because the walk compares the stored value and never looks the node up.

**A capture resumes only while its configuration holds.** Changing a field, a metric's parameters, or the blocking key restarts the walk, because pairs already captured would otherwise answer a different question from the ones still to come. Thresholds and the surfacing rule are deliberately excluded — they re-filter scores rather than change them.

---

## Tuning thresholds without rescanning

Scores do not depend on thresholds, so every scored candidate is stored, whether or not it surfaced. **Re-apply Thresholds** on the Fields & Metrics screen re-runs the surfacing rule over what is already captured — no walk, no scoring, no graph traffic beyond fetching node details for pairs newly entering the queue.

This is what makes a threshold worth *lowering*. Dropping 0.97 to 0.85 on an Address capture brought back 1,382 pairs in 136 ms.

- **Threshold or surfacing-rule change** → re-filter what is already captured, instantly.
- **Field or metric change** → genuine invalidation; the scores no longer describe the question.

A pair that already carries a verdict stays in the queue even when a raised threshold would exclude it, so a re-filter never hides work someone already did.

Two limits worth knowing. Only surfaced pairs carry node snapshots — storing them for every candidate would cost 116 MB per pass on a label like Company against 12 MB for ids and scores — so a pair promoted by a re-filter is fetched from the graph as it enters the queue. And sessions captured before this existed stored only their surfaced pairs, so on those a re-filter can still retire pairs but has nothing below the threshold to recover.

---

## Scale and limits

Figures below were measured against an Aura instance of 9,060,704 nodes and 15,872,887 relationships.

**Connecting is fast when APOC is present, slow when it is not.** Schema discovery needs property types per label. `apoc.meta.nodeTypeProperties` and `apoc.meta.relTypeProperties` sample to get them; the built-in `db.schema.*` equivalents walk the entire store. On that instance the difference is a 6s connect against a 46s one, for identical results. APOC ships with Aura, so this only bites on a self-managed database without it — where the connect is working, not hung.

**Everything in this section describes the in-memory strategies — Auto, Exhaustive and Token bucket. Prefix blocking is bounded by design and none of these limits apply to it:** it holds one batch of 5,000 nodes rather than the label, and stops on a budget rather than at the end. That is the strategy to reach for when a label exceeds the figures below.

**Compute holds one value per node, per field, for the entire run** — roughly 250 bytes per node. Full property maps are fetched afterwards, only for the nodes that ended up in a candidate pair. That still puts a ceiling on label size, because V8 caps its heap near 4 GB:

| Label size | Node memory | Outcome |
|---|---|---|
| under 500,000 | under 0.12 GB | fine |
| 500,000 – 2,000,000 | 0.12 – 0.5 GB | Configure warns |
| over 2,000,000 | over 0.5 GB | Configure requires confirmation |
| 6,342,823 | 1.5 GB | feasible, but leaves little headroom for pair scores |

The Configure screen shows the node count and projected memory once a label crosses the first threshold, and puts `Start Compute` behind an explicit checkbox past the second. Neither applies under prefix blocking, which reports its batched walk instead.

**Candidate pairs are the other limit, and usually the one that binds.** Each costs about 325 bytes while a run is in progress, so compute stops with a message past **five million** of them rather than attempting a run it cannot finish. This is driven by the surfacing rule rather than the label — Exact Match on a field with few distinct values will reach it on a label of any size.

Prefix blocking never builds a whole-label pair set, so this ceiling does not apply to it. The contrast is stark on a large label: token bucketing on a 6,342,823-node label projects 483 million candidates against the five-million ceiling and is refused, where prefix blocking captures about 30,000 in 27 seconds and stops.

**Estimate Pair Count is safe at any label size, and reports what the configured strategy will actually do.** For the in-memory strategies it samples — bounded at 20,000 nodes, thinning from there — and projects a whole-label figure. For prefix blocking it walks one batch from the session's own cursor and reports what the *next pass* will yield, because that is the run that will happen; there is deliberately no "passes to finish the label" figure, since pair density varies by region enough to make any such number authoritative-looking noise.

**Cancel does not interrupt a fetch.** Cancellation is checked between metrics, so during the initial query — the longest phase on a large label — the button has no effect until the query returns.

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

Which pairs a metric is asked to score is decided before scoring, by the blocking strategy — see [Choosing which pairs to compare](#choosing-which-pairs-to-compare). The default at scale is **token bucketing** (O(n × tokens), not O(n²)).

**Exact Match and `Normalization`.** `nfkd-lower-strip` (the default) lowercases, applies Unicode NFKD, and replaces every non-alphanumeric character with a space before collapsing runs of whitespace. So `St. Louis` matches `St Louis` and `Reagan-National` matches `Reagan National`, but `Zürich` does not match `Zurich` — NFKD splits the umlaut into a combining mark, which is then replaced by a space. `none` compares the raw strings, so even `USA` and `usa` differ.

**Exact Match and Phonetic on low-cardinality fields.** Both group every record sharing a value — or a phonetic code — and compare all of them pairwise, with no cap on group size. That is free on an identifier, where groups hold one or two records, and quadratic on a field with few distinct values. A month-of-year field over six million records is twelve groups and roughly 1.7 trillion pairs. Kind inference reads a short digit string as an identifier and suggests Exact Match for it, so this is reachable by accepting the defaults; check the distinct-value count before putting either metric on a field.

**Edit Distance and `Min string length`.** The Levenshtein ratio is a step function of length: on a four-character value one edit costs a flat 0.25, on a two-character value it costs 0.5. Below a few characters the score reports length more than similarity, so the metric **declines to score** a pair where either value is shorter than `Min string length` (default 3) rather than returning a number no threshold can use sensibly.

Declining is not failing. A field where every configured metric declined is skipped by All mode and dropped from both sides of the weighted-average ratio, exactly as a property neither node carries would be — so putting Edit Distance on a two-character field such as a US state code costs you that field, not your whole queue.

---

## Surfacing rules

Controls which scored pairs enter the review queue:

- **Any field** — surface if any field score meets its threshold
- **All fields** — surface only if every field *the two nodes can be compared on* meets its threshold
- **Weighted average** — surface if the weighted *mean* of the field scores that could be judged meets a combined threshold

**Estimate Pair Count** on the Configure screen answers the rule you have actually selected. It runs the real pipeline — candidate generation, score fill-in, and the same surfacing test compute uses — so All and Weighted Average are counted on real scores rather than on a candidate-pair bound. The number is exact. Under prefix blocking it estimates the next capture pass instead; see [Scale and limits](#scale-and-limits).

It stays bounded on large labels through two limits. The fetch itself stops at 20,000 nodes — the query carries the `LIMIT`, so the estimate never pulls a whole label into memory. Then, if those nodes still yield more than 50,000 candidate pairs, an evenly spaced subset of them is scored instead.

Whenever either limit applies, the result is scaled by `C(N,2)/C(n,2)` against the label's true node count and reported as sampled. That scaling is unbiased in expectation, because a pair survives sampling exactly when both its nodes do.

Its **precision**, though, comes from the pairs actually seen rather than the pairs projected — roughly `1/√observed`. So the estimate reports that number too: *projected from 127 pairs seen in a sample of 2,000 of 2,716,446 nodes*. A hundred or more observations is worth acting on; single digits are not, and the displayed figure is rounded to match. The sample never thins below 2,000 nodes for that reason, and the fetch limit takes the first 20,000 in store order rather than a random draw.

### Missing properties, and why All is worded that way

Nodes in the same label rarely carry the same properties. All mode therefore judges a pair on the fields **both** nodes actually have, and ignores the rest — a record missing `airport_id` is compared on the fields it does have rather than being excluded outright. A pair with no comparable field in common never surfaces.

This matters more than it sounds, because a *missing score* and a *low score* are not the same thing. Metrics emit scores sparsely — blocking only produces a score for records that share a token, or a prefix, or whatever the chosen strategy keys on — so an absent score cannot be read as a failure. Before applying the rule, the tool asks each metric directly for any score it needs and doesn't have, whenever both nodes carry the property. All mode is judged on real numbers, never on inferred failure.

Any mode is unaffected: it needs one field to clear its threshold, so absences are irrelevant.

**Weighted average now drops an unjudgeable field from both sides of the ratio**, exactly as All mode skips it — so a field one node lacks neither helps nor hurts, and a pair is not penalised for data it does not have. This changed: it previously averaged such a field in as a score of 0, which pulled the mean down and could hold back a pair that matched well on everything it could be compared on. The two modes disagreeing about what "cannot be judged" means was also what stopped a threshold re-filter from reproducing compute's own verdict. If you have a weighted-average session on sparse data, expect it to surface more than it used to.

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

**One caveat on those records.** Without APOC the fallback path cannot combine array properties, so **combine** silently behaves as **discard** — but the audit record still stores `combine`, the strategy you asked for rather than the one that ran. On a database with APOC, which includes all of Aura, this cannot arise.

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
                 pairsDecidedByHuman, pairsDecidedByAi, pairsDecidedByUnknown,
                 labelFullyCompared, nodesWalked})
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

`labelFullyCompared` says whether the merge rests on a complete comparison of the label or on part of one — false for a merge applied from a partial capture, and true for the strategies that compare the whole label by construction. Records written before this existed carry no value rather than a misleading `true`:

```cypher
// Merges applied while the label was only partly compared.
MATCH (r:ERAuditRecord) WHERE r.labelFullyCompared = false
RETURN r.label, r.nodesWalked, count(*) AS merges
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

Sessions can be exported at any point from the review panel as CSV or JSON, filtered by verdict. CSV carries `node_a_<field>` and `node_b_<field>` for every field the session matched on, alongside the per-metric scores, so the numbers can be read against the values that produced them. JSON carries the whole pair, including every property of both nodes.

Candidates that were scored but did not surface are stored too, which is what makes [threshold re-filtering](#tuning-thresholds-without-rescanning) possible. They hold ids and scores but no node snapshots — roughly 12 MB per 100,000 candidates — and never appear in the queue or in an export.

---

## Architecture

```
src/
  main/              Electron main process
    connection-service.ts   Neo4j driver, profile CRUD, keytar
    schema-service.ts       Schema discovery, PropertyKind inference
    session-service.ts      Session and pair CRUD, verdict upsert
    metric-runner.ts        Orchestrates metrics, surfacing, distributions,
                            and the resumable prefix capture walk
    candidate-generator.ts  Token bucketing — which pairs are worth scoring
    refilter-service.ts     Re-applies thresholds to captured candidates
    pair-id.ts              Session-scoped pair row ids
    neo4j-int.ts            Integer, temporal and spatial conversion for IPC
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
