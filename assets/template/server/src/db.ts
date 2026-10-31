import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

// Data of one account. Every account has its own SQLite file under data/users/<id>/, picked per
// request with withUser(): the functions below never take a user id, they just read and write
// "the current account".

export const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

// TODO(port): the same tables and columns as the native database (Room entities, Core Data,
// SQLDelight...), so the JSON backup can move between the native app and the PWA.
// Keep meta, push_subs and any cache tables.
const schema = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, reminders INTEGER NOT NULL);
`

// --- accounts: every account has its own database, picked per request -------------------------

type UserData = { id: number; db: DatabaseSync; imagesDir: string }

const opened = new Map<number, UserData>()
const current = new AsyncLocalStorage<UserData>()

export const userDir = (userId: number) => join(dataDir, 'users', String(userId))

function open(userId: number): UserData {
  const known = opened.get(userId)
  if (known) return known
  const dir = userDir(userId)
  const imagesDir = join(dir, 'images')
  mkdirSync(imagesDir, { recursive: true })
  const db = new DatabaseSync(join(dir, '__APP_ID__.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;')
  db.exec(schema)
  const data = { id: userId, db, imagesDir }
  opened.set(userId, data)
  current.run(data, seedIfEmpty)
  return data
}

/** Runs [work] on the data of [userId]: every function of this module then reads and writes there. */
export function withUser<T>(userId: number, work: () => T): T {
  return current.run(open(userId), work)
}

export function closeUser(userId: number) {
  opened.get(userId)?.db.close()
  opened.delete(userId)
}

function user(): UserData {
  const data = current.getStore()
  if (!data) throw new Error('Nessun account attivo')
  return data
}

/** The database of the current account. */
export const db = {
  prepare: (sql: string) => user().db.prepare(sql),
  exec: (sql: string) => user().db.exec(sql),
}

export const imagesDir = () => user().imagesDir

// --- meta ------------------------------------------------------------------------------------

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(key: string, value: string | null) {
  if (value == null) db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  else db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Bumped on every change, so clients can tell when to reload (GET /api/state?since=<revision>). */
export function revision(): number {
  return Number(getMeta('revision') ?? '0')
}

function touch() {
  setMeta('revision', String(revision() + 1))
}

export function transaction<T>(work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    touch()
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// --- rows ------------------------------------------------------------------------------------

type Sql = string | number | null

function sqlValue(v: unknown): Sql {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === undefined) return null
  return v as Sql
}

/** Room's @Upsert: id 0 inserts a new row, any other id replaces (or recreates) that row. */
export function upsert(table: string, columns: readonly string[], entity: Record<string, unknown>): number {
  const values = columns.map((c) => sqlValue(entity[c]))
  const id = Number(entity.id ?? 0)
  if (id === 0) {
    const result = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values)
    return Number(result.lastInsertRowid)
  }
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`).run(id, ...values)
  return id
}

// TODO(port): typed readers (toItem...), state() returning everything the client needs,
// save/delete functions wrapped in transaction(), background work (processRecurring...).

/** Everything the app shows, sent to the client in one go (GET /api/state). */
export function state() {
  return { items: db.prepare('SELECT * FROM items ORDER BY createdAt DESC').all() }
}

/** First start of an account: the defaults the native app creates on install (categories...). */
export function seedIfEmpty() {
  // TODO(port): insert the native app's default rows when the account is new.
}

// --- images ----------------------------------------------------------------------------------

/** Images are referenced as "/images/<file>"; only files inside the images folder can be removed. */
export function deleteImage(path: string) {
  const name = basename(path)
  if (!path.startsWith('/images/') || !/^[\w.-]+$/.test(name)) return
  try { unlinkSync(join(imagesDir(), name)) } catch { /* already gone */ }
}
