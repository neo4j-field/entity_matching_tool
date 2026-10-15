import keytar from 'keytar'
import neo4j, { Driver } from 'neo4j-driver'
import { toJsNumber } from './neo4j-int'
import { randomUUID } from 'crypto'
import { getDb } from './db'
import type { ConnectionProfile, TestConnectionResult } from '../shared/types'

const SERVICE = 'neo4j-er-tool'
let _driver: Driver | null = null
let _activeProfileId: string | null = null
let _activeDatabase: string | undefined = undefined

// ── Profile CRUD (metadata in SQLite, password in keychain) ─────────────────

export async function saveProfile(
  profile: Omit<ConnectionProfile, 'id'> & { password: string; id?: string }
): Promise<ConnectionProfile> {
  const db = getDb()
  const id = profile.id ?? randomUUID()
  db.prepare(`
    INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)
  `).run(`profile:${id}`, JSON.stringify({ id, name: profile.name, uri: profile.uri, username: profile.username, database: profile.database }))
  await keytar.setPassword(SERVICE, id, profile.password)
  return { id, name: profile.name, uri: profile.uri, username: profile.username, database: profile.database }
}

export async function listProfiles(): Promise<ConnectionProfile[]> {
  const db = getDb()
  const rows = db.prepare("SELECT value FROM settings WHERE key LIKE 'profile:%'").all() as { value: string }[]
  return rows.map((r) => JSON.parse(r.value) as ConnectionProfile)
}

export async function deleteProfile(id: string): Promise<void> {
  const db = getDb()
  db.prepare("DELETE FROM settings WHERE key = ?").run(`profile:${id}`)
  await keytar.deletePassword(SERVICE, id)
}

async function getPassword(id: string): Promise<string> {
  const pw = await keytar.getPassword(SERVICE, id)
  if (!pw) throw new Error(`No password stored for profile ${id}`)
  return pw
}

// ── Test ─────────────────────────────────────────────────────────────────────

export async function testConnection(id: string): Promise<TestConnectionResult> {
  const profiles = await listProfiles()
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return { ok: false, error: 'Profile not found' }
  const password = await getPassword(id)
  let driver: Driver | null = null
  try {
    const t0 = Date.now()
    driver = neo4j.driver(profile.uri, neo4j.auth.basic(profile.username, password))
    await driver.verifyConnectivity()
    const latencyMs = Date.now() - t0
    const session = driver.session({ database: profile.database || undefined })
    const nodeCt = toJsNumber((await session.run('MATCH (n) RETURN count(n) AS c')).records[0].get('c'))
    const relCt = toJsNumber((await session.run('MATCH ()-[r]->() RETURN count(r) AS c')).records[0].get('c'))
    const apoc = await session.run('RETURN apoc.version() AS v').then(() => true).catch(() => false)
    await session.close()
    return { ok: true, latencyMs, nodeCount: nodeCt, relCount: relCt, apocAvailable: apoc }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  } finally {
    await driver?.close()
  }
}

// ── Connect / disconnect ──────────────────────────────────────────────────────

export async function connect(id: string): Promise<Driver> {
  if (_driver && _activeProfileId === id) return _driver
  await disconnect()
  const profiles = await listProfiles()
  const profile = profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found')
  const password = await getPassword(id)
  _driver = neo4j.driver(profile.uri, neo4j.auth.basic(profile.username, password))
  await _driver.verifyConnectivity()
  _activeProfileId = id
  _activeDatabase = profile.database || undefined
  return _driver
}

export async function disconnect(): Promise<void> {
  if (_driver) {
    await _driver.close()
    _driver = null
    _activeProfileId = null
    _activeDatabase = undefined
  }
}

export function getDriver(): Driver {
  if (!_driver) throw new Error('Not connected to Neo4j')
  return _driver
}

export function getActiveProfileId(): string | null {
  return _activeProfileId
}

export function getActiveDatabase(): string | undefined {
  return _activeDatabase
}
