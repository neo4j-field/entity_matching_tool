import { getDriver } from './connection-service'
import { mapWithConcurrency } from './concurrency'
import { getSettings } from './settings-service'
import { toJsNumber, sanitize } from './neo4j-int'
import type {
  SchemaModel,
  LabelMeta,
  PropertyMeta,
  PropertyKind,
  PropertyIndexKind,
  RelTypeMeta,
  RelPattern,
} from '../shared/types'

let _cached: SchemaModel | null = null

// Nodes read per label to derive both the property list and sample values. One
// bounded scan per label replaces a DISTINCT query per property — see the
// sampling step below.
const SAMPLE_NODE_LIMIT = 100
const MAX_SAMPLE_VALUES = 10

// Each concurrent query needs its own session; a single session serialises its
// queries. Well inside the driver's default connection pool.
const LABEL_SAMPLE_CONCURRENCY = 8

// Nodes per sampled record for apoc.meta.*. One in a thousand was enough to
// return property sets identical to a full scan on a 9M-node database.
const SCHEMA_SAMPLE_RATE = 1000

export async function discoverSchema(): Promise<SchemaModel> {
  const driver = getDriver()
  const { excludedLabels } = getSettings()

  const startedAt = Date.now()
  let queryCount = 0
  const session = driver.session()
  try {
    // Probe APOC first — it decides which schema source to use below, and the
    // probe itself is a constant-time call.
    let apocAvailable = false
    try {
      await session.run('RETURN apoc.version() AS v')
      queryCount++
      apocAvailable = true
    } catch { /* not available */ }

    // Which properties the database can seek on. Read-only, and cheap — the
    // index list is metadata, not a scan. Nothing is ever created here: an
    // index outlives the session, taxes every write to its label for as long as
    // it exists, and belongs to whoever owns the database.
    const indexed = new Map<string, Map<string, Set<PropertyIndexKind>>>()
    try {
      const idxResult = await session.run(`
        SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state
        WHERE entityType = 'NODE' AND state = 'ONLINE'
        RETURN type, labelsOrTypes, properties
      `)
      queryCount++
      for (const record of idxResult.records) {
        const kind = record.get('type') as PropertyIndexKind
        const labels = (record.get('labelsOrTypes') ?? []) as string[]
        const props = (record.get('properties') ?? []) as string[]
        // A composite index only supports a seek on its leading property, and a
        // full-text index spans every property it names.
        const usable = kind === 'FULLTEXT' ? props : props.slice(0, 1)
        for (const label of labels) {
          if (!indexed.has(label)) indexed.set(label, new Map())
          const forLabel = indexed.get(label)!
          for (const prop of usable) {
            if (!forLabel.has(prop)) forLabel.set(prop, new Set())
            forLabel.get(prop)!.add(kind)
          }
        }
      }
    } catch { /* SHOW INDEXES unavailable — strategies needing one stay hidden */ }

    // Property types, from whichever source can answer without reading the
    // whole store.
    //
    // db.schema.nodeTypeProperties() and db.schema.relTypeProperties() scan
    // every node and every relationship to determine types. On a 9.06M-node
    // instance that measured 33s and 10s, out of a 46s connect. APOC's
    // equivalents sample instead: 2.5s and 2.7s for identical property sets on
    // the same database.
    //
    // The two report different type vocabularies — `String` where db.schema
    // says `STRING NOT NULL`, `StringArray` where it says
    // `LIST<STRING NOT NULL>` — which normalizeTypeName reconciles. That is the
    // part to be careful with: matching one vocabulary and not the other is
    // what once classified every property as kind 'other'.
    const tTypes = Date.now()
    const nodeTypeQuery = apocAvailable
      ? `CALL apoc.meta.nodeTypeProperties({sample: ${SCHEMA_SAMPLE_RATE}})
         YIELD nodeLabels, propertyName, propertyTypes, mandatory
         RETURN nodeLabels, propertyName, propertyTypes, mandatory
         ORDER BY nodeLabels, propertyName`
      : `CALL db.schema.nodeTypeProperties()
         YIELD nodeLabels, propertyName, propertyTypes, mandatory
         RETURN nodeLabels, propertyName, propertyTypes, mandatory
         ORDER BY nodeLabels, propertyName`
    const relTypeQuery = apocAvailable
      ? `CALL apoc.meta.relTypeProperties({sample: ${SCHEMA_SAMPLE_RATE}})
         YIELD relType, propertyName, propertyTypes
         RETURN relType, propertyName, propertyTypes
         ORDER BY relType`
      : `CALL db.schema.relTypeProperties()
         YIELD relType, propertyName, propertyTypes
         RETURN relType, propertyName, propertyTypes
         ORDER BY relType`

    // These two are independent, and together they are most of what connecting
    // costs: 6.2s and 6.1s of a 19.2s discovery on a 59-label graph. Both
    // procedures sample per label and per relationship type, so the cost tracks
    // how many kinds a schema has rather than how many nodes — a 6-label graph
    // of 6.3M nodes runs them far faster than a small graph with 59 labels.
    //
    // A session executes its queries in sequence, so overlapping them needs a
    // session each.
    const [propResult, relResult] = await Promise.all([
      runOnOwnSession(driver, nodeTypeQuery),
      runOnOwnSession(driver, relTypeQuery),
    ])
    queryCount += 2
    console.log(
      `[schema] property types via ${apocAvailable ? 'apoc.meta.*' : 'db.schema.*'} ` +
        `in ${Date.now() - tTypes}ms`
    )

    // Node counts
    const countsMap: Record<string, number> = {}
    if (apocAvailable) {
      const statsResult = await session.run('CALL apoc.meta.stats() YIELD labels RETURN labels')
      queryCount++
      const raw = statsResult.records[0].get('labels') as Record<string, unknown>
      for (const [k, v] of Object.entries(raw)) countsMap[k] = toJsNumber(v)
    } else {
      const fallback = await session.run(`
        MATCH (n) UNWIND labels(n) AS lab
        RETURN lab AS label, count(n) AS total ORDER BY total DESC
      `)
      queryCount++
      for (const r of fallback.records) {
        countsMap[r.get('label') as string] = toJsNumber(r.get('total'))
      }
    }

    // Build label map
    const labelMap = new Map<string, { properties: Map<string, PropertyMeta> }>()

    for (const record of propResult.records) {
      const nodeLabels: string[] = record.get('nodeLabels')
      const propertyName: string | null = record.get('propertyName')
      const propertyTypes: string[] = record.get('propertyTypes') ?? []
      const mandatory: boolean = record.get('mandatory') ?? false

      for (const label of nodeLabels) {
        if (excludedLabels.includes(label)) continue
        if (!labelMap.has(label)) labelMap.set(label, { properties: new Map() })
        if (!propertyName) continue
        const entry = labelMap.get(label)!
        if (!entry.properties.has(propertyName)) {
          entry.properties.set(propertyName, {
            name: propertyName,
            types: propertyTypes,
            mandatory,
            inferredKind: 'other',
            sampleValues: [],
          })
        }
      }
    }

    // Also ensure every label that appears in countsMap has an entry
    for (const label of Object.keys(countsMap)) {
      if (!excludedLabels.includes(label) && !labelMap.has(label)) {
        labelMap.set(label, { properties: new Map() })
      }
    }

    // Sample each label once and derive everything from those rows.
    //
    // This previously ran one query per (label, property):
    //   MATCH (n:`L`) WHERE n.`p` IS NOT NULL RETURN DISTINCT n.`p` LIMIT 10
    // which cost a round trip each — hundreds on a wide schema, all sequential —
    // and could not stop early: DISTINCT ... LIMIT 10 must keep scanning until
    // it finds ten *distinct* values, so any low-cardinality property (type,
    // status, category) scanned the entire label.
    //
    // One bounded scan per label answers both questions at once, and subsumes
    // the old "schema procedure returned no properties" fallback, since
    // properties(n) reports whatever the nodes actually carry.
    const tSample = Date.now()
    const labelNames = [...labelMap.keys()]
    const sampledRows = await mapWithConcurrency(
      labelNames,
      LABEL_SAMPLE_CONCURRENCY,
      async (label): Promise<Record<string, unknown>[]> => {
        const s = driver.session()
        try {
          const result = await s.run(
            `MATCH (n:\`${label}\`) RETURN properties(n) AS props LIMIT ${SAMPLE_NODE_LIMIT}`
          )
          queryCount++
          return result.records
            .map((r) => r.get('props') as Record<string, unknown> | null)
            .filter((p): p is Record<string, unknown> => p !== null)
        } catch {
          // A single unreadable label shouldn't sink the whole discovery.
          return []
        } finally {
          await s.close()
        }
      }
    )
    console.log(
      `[schema] sampled ${labelNames.length} labels in ${Date.now() - tSample}ms ` +
        `(${LABEL_SAMPLE_CONCURRENCY}-way concurrent)`
    )

    const labels: LabelMeta[] = []
    labelNames.forEach((label, i) => {
      const { properties } = labelMap.get(label)!
      const rows = sampledRows[i]

      // Pick up properties the schema procedure didn't report — common on Aura
      // when the database has no constraints.
      for (const props of rows) {
        for (const key of Object.keys(props)) {
          if (!properties.has(key)) {
            properties.set(key, {
              name: key,
              types: [],
              mandatory: false,
              inferredKind: 'other',
              sampleValues: [],
            })
          }
        }
      }

      const propMetas: PropertyMeta[] = []
      for (const [propName, meta] of properties) {
        const seen = new Set<string>()
        const values: unknown[] = []
        for (const props of rows) {
          const raw = props[propName]
          if (raw === null || raw === undefined) continue
          const value = sanitize(raw)
          const key = JSON.stringify(value)
          if (seen.has(key)) continue
          seen.add(key)
          values.push(value)
          if (values.length >= MAX_SAMPLE_VALUES) break
        }
        meta.sampleValues = values
        meta.inferredKind = inferKind(meta)
        const idx = indexed.get(label)?.get(propName)
        if (idx && idx.size > 0) meta.indexes = [...idx]
        propMetas.push(meta)
      }
      labels.push({ name: label, count: countsMap[label] ?? 0, properties: propMetas })
    })

    // Sort by count desc
    labels.sort((a, b) => Number(b.count) - Number(a.count))

    // Relationship types
    const relMap = new Map<string, RelTypeMeta>()
    for (const record of relResult.records) {
      const relType: string = record.get('relType').replace(/^:`|`$/g, '')
      if (!relMap.has(relType)) {
        relMap.set(relType, { name: relType, startLabels: [], endLabels: [] })
      }
    }

    // Which labels each type actually connects. apoc.meta.relTypeProperties and
    // db.schema.relTypeProperties both yield only the type and its properties,
    // so this was previously unknowable and startLabels/endLabels were always
    // empty. db.schema.visualization() is the only source that gives endpoints
    // with a direction, and it is built in — no new APOC dependency on a path
    // that already degrades 6s to 46s without it. Measured: 1825ms cold and
    // 156ms warm on a 9M-node database.
    const tViz = Date.now()
    const relPatterns = await discoverRelPatterns(session, excludedLabels)
    queryCount++
    for (const pat of relPatterns) {
      const entry = relMap.get(pat.relType) ?? { name: pat.relType, startLabels: [], endLabels: [] }
      if (!entry.startLabels.includes(pat.startLabel)) entry.startLabels.push(pat.startLabel)
      if (!entry.endLabels.includes(pat.endLabel)) entry.endLabels.push(pat.endLabel)
      relMap.set(pat.relType, entry)
    }
    console.log(
      `[schema] ${relPatterns.length} relationship patterns via db.schema.visualization() ` +
        `in ${Date.now() - tViz}ms`
    )

    const relationshipTypes = Array.from(relMap.values())

    console.log(
      `[schema] discovered ${labels.length} labels, ${relationshipTypes.length} rel types ` +
        `in ${Date.now() - startedAt}ms across ${queryCount} queries`
    )

    _cached = {
      labels,
      relationshipTypes,
      relPatterns,
      discoveredAt: new Date().toISOString(),
      apocAvailable,
    }
    return _cached
  } finally {
    await session.close()
  }
}

export function getCachedSchema(): SchemaModel | null {
  return _cached
}

const NUMERIC_TYPES = new Set(['LONG', 'INTEGER', 'DOUBLE', 'FLOAT', 'NUMBER'])
const DATE_TYPES = new Set([
  'DATE',
  'DATETIME',
  'LOCALDATETIME',
  'ZONEDDATETIME',
  'TIME',
  'LOCALTIME',
  'ZONEDTIME',
  'DURATION',
])

// The two schema sources spell types differently, and both reach here.
//
//   db.schema.*      STRING NOT NULL   INTEGER NOT NULL   LIST<STRING NOT NULL> NOT NULL
//   apoc.meta.*      String            Long               StringArray
//
// Uppercasing reconciles most of that on its own — the reason Neo4j 4 spellings
// once matched nothing, classifying every property as 'other', was the
// nullability suffix rather than the case. The one structural difference left is
// how a list is written, so both spellings reduce to their element type: a list
// of strings is string-like for similarity purposes either way.
function normalizeTypeName(raw: string): string {
  let t = raw.toUpperCase().replace(/\bNOT\s+NULL\b/g, '')
  const list = t.match(/^\s*LIST<(.+)>\s*$/)
  if (list) t = list[1]
  t = t.replace(/\s+/g, '')
  const array = t.match(/^(.+)ARRAY$/)
  if (array) t = array[1]
  return t
}

function inferKind(meta: PropertyMeta): PropertyKind {
  const types = meta.types.map(normalizeTypeName).filter(Boolean)
  if (types.some((t) => NUMERIC_TYPES.has(t))) return 'numeric'
  if (types.includes('BOOLEAN')) return 'boolean'
  if (types.some((t) => DATE_TYPES.has(t))) return 'date'
  // Only hard-return 'other' when we have explicit non-string type info.
  // Empty types (no schema constraints) falls through to sample-value heuristics.
  if (types.length > 0 && !types.includes('STRING')) return 'other'

  const samples = meta.sampleValues.filter((v) => typeof v === 'string') as string[]
  if (samples.length === 0) return 'name'

  const avgLen = samples.reduce((s, v) => s + v.length, 0) / samples.length
  // Digits or punctuation suggest an identifier, but only without whitespace —
  // otherwise product and aircraft names carrying a model number ("Boeing 737
  // Max") read as identifiers and lose the token- and phonetic-based metrics
  // that names need.
  const identifierPattern = /[\d.()/\\-]/
  const identifierLike =
    samples.filter((s) => identifierPattern.test(s) && !/\s/.test(s)).length / samples.length

  if (avgLen < 20 && identifierLike > 0.5) return 'identifier'
  if (avgLen > 100) return 'text'
  return 'name'
}

/**
 * Directed (start)-[:TYPE]->(end) shapes, from the built-in schema procedure.
 *
 * Patterns touching an excluded label are dropped here rather than by the
 * caller: on a GraphRAG database 11 of 43 patterns are FROM_CHUNK plumbing, and
 * on a database this tool has written back to, its own ERPair and ERPairScore
 * nodes appear as candidates.
 *
 * Failure is not fatal. A database that cannot run the procedure keeps every
 * other part of discovery; callers see an empty list and offer no patterns.
 */
async function discoverRelPatterns(
  session: ReturnType<ReturnType<typeof getDriver>['session']>,
  excludedLabels: string[]
): Promise<RelPattern[]> {
  let result
  try {
    result = await session.run('CALL db.schema.visualization()')
  } catch (err) {
    console.log(`[schema] db.schema.visualization() unavailable: ${(err as Error).message}`)
    return []
  }
  const record = result.records[0]
  if (!record) return []

  // Relationships carry the identities of their endpoints, not the nodes, so
  // they have to be resolved through the node list in the same row.
  // One node per label is what the procedure returns. Anything else is a shape
  // this does not understand, and joining the labels would invent a name no
  // database has — so skip it rather than offer a pattern that cannot match.
  const labelById = new Map<string, string>()
  for (const node of (record.get('nodes') ?? []) as { identity: unknown; labels: string[] }[]) {
    if (node.labels.length !== 1) {
      console.log(`[schema] skipping schema node with ${node.labels.length} labels: ${node.labels.join(', ')}`)
      continue
    }
    labelById.set(String(node.identity), node.labels[0])
  }

  const patterns: RelPattern[] = []
  const seen = new Set<string>()
  for (const rel of (record.get('relationships') ?? []) as {
    start: unknown
    end: unknown
    type: string
  }[]) {
    const startLabel = labelById.get(String(rel.start))
    const endLabel = labelById.get(String(rel.end))
    if (!startLabel || !endLabel) continue
    if (excludedLabels.includes(startLabel) || excludedLabels.includes(endLabel)) continue
    const key = `${startLabel}|${rel.type}|${endLabel}`
    if (seen.has(key)) continue
    seen.add(key)
    patterns.push({ relType: rel.type, startLabel, endLabel })
  }
  return patterns
}

/**
 * Whether a pattern has any data at all.
 *
 * db.schema.visualization() reports label-pair combinations rather than only
 * observed ones: on one test database 5 of 43 patterns matched nothing, among
 * them (Occurrence)-[:PART_OF]->(Aircraft). Configuring one of those would
 * produce a session that silently surfaces no pairs — no error, an empty queue,
 * the same failure mode as a blocking key with no index. Check before offering
 * a pattern as usable. Measured at 208-640ms per pattern on a 9M-node database.
 */
export async function relPatternHasData(pattern: RelPattern): Promise<boolean> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      `MATCH (a:\`${pattern.startLabel}\`)-[:\`${pattern.relType}\`]->(b:\`${pattern.endLabel}\`) ` +
        `RETURN 1 AS ok LIMIT 1`
    )
    return result.records.length > 0
  } finally {
    await session.close()
  }
}

/**
 * How well a property would work as a prefix blocking key.
 *
 * Blocking compares a node only against others sharing its prefix, so the key
 * has to divide the label into many small groups. A low-cardinality property
 * does the opposite: `category` on a company register holds a handful of values,
 * so every node's block is millions of nodes, every node hits the partner cap,
 * and the partners are arbitrary nodes that happen to share a category.
 *
 * Measured on a 6.3M-node label blocked by `category`: one batch of 5,000 nodes
 * produced 250,000 candidates and surfaced nothing, exhausting the pass's whole
 * candidate budget on 0.08% of the label. Nothing errors — the queue is simply
 * empty — which is why this is worth reporting before a run rather than after.
 *
 * Sampled rather than counted: an exact distinct-count over the label is a scan,
 * and the ratio is obvious long before it is precise.
 */
export async function blockingKeyQuality(
  label: string,
  field: string,
  prefixLength: number
): Promise<{ sampled: number; distinctPrefixes: number; averageBlock: number }> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      `MATCH (n:\`${label}\`) WHERE n.\`${field}\` IS NOT NULL
       RETURN n.\`${field}\` AS v LIMIT 5000`
    )
    const prefixes = new Set<string>()
    let sampled = 0
    for (const record of result.records) {
      const value = record.get('v')
      if (typeof value !== 'string') continue
      sampled++
      prefixes.add(value.slice(0, prefixLength))
    }
    const distinctPrefixes = prefixes.size
    return {
      sampled,
      distinctPrefixes,
      averageBlock: distinctPrefixes > 0 ? sampled / distinctPrefixes : 0,
    }
  } finally {
    await session.close()
  }
}

/**
 * Run one query on a session of its own, so it can overlap with another.
 *
 * The driver serialises queries within a session; concurrency is per session,
 * not per query.
 */
type QueryResult = Awaited<ReturnType<ReturnType<ReturnType<typeof getDriver>['session']>['run']>>

async function runOnOwnSession(
  driver: ReturnType<typeof getDriver>,
  query: string
): Promise<QueryResult> {
  const session = driver.session()
  try {
    return await session.run(query)
  } finally {
    await session.close()
  }
}
