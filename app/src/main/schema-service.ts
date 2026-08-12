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
    const propResult = await session.run(
      apocAvailable
        ? `CALL apoc.meta.nodeTypeProperties({sample: ${SCHEMA_SAMPLE_RATE}})
           YIELD nodeLabels, propertyName, propertyTypes, mandatory
           RETURN nodeLabels, propertyName, propertyTypes, mandatory
           ORDER BY nodeLabels, propertyName`
        : `CALL db.schema.nodeTypeProperties()
           YIELD nodeLabels, propertyName, propertyTypes, mandatory
           RETURN nodeLabels, propertyName, propertyTypes, mandatory
           ORDER BY nodeLabels, propertyName`
    )
    queryCount++

    const relResult = await session.run(
      apocAvailable
        ? `CALL apoc.meta.relTypeProperties({sample: ${SCHEMA_SAMPLE_RATE}})
           YIELD relType, propertyName, propertyTypes
           RETURN relType, propertyName, propertyTypes
           ORDER BY relType`
        : `CALL db.schema.relTypeProperties()
           YIELD relType, propertyName, propertyTypes
           RETURN relType, propertyName, propertyTypes
           ORDER BY relType`
    )
    queryCount++
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
    const relationshipTypes = Array.from(relMap.values())

    console.log(
      `[schema] discovered ${labels.length} labels, ${relationshipTypes.length} rel types ` +
        `in ${Date.now() - startedAt}ms across ${queryCount} queries`
    )

    _cached = { labels, relationshipTypes, discoveredAt: new Date().toISOString(), apocAvailable }
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
