import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { closeUser, dataDir, userDir } from './db.ts'

// Family accounts: each one has its own __APP_NAME__ (its own database and images), reached with a
// username and a password. No email: the server lives at home.

const db = new DatabaseSync(join(dataDir, 'accounts.db'))
db.exec('PRAGMA journal_mode = WAL;')
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hash TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY NOT NULL, userId INTEGER NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS index_sessions_userId ON sessions (userId);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`)

export class AccountError extends Error {}

export type User = { id: number; username: string }

// --- server wide settings (the Web Push keys) -------------------------------------------------

export function getServerMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setServerMeta(key: string, value: string) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// --- passwords --------------------------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`
}

function passwordMatches(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length)
  return timingSafeEqual(expected, actual)
}

function checkPassword(password: string) {
  if (password.length < 6) throw new AccountError('La password deve avere almeno 6 caratteri.')
  if (password.length > 200) throw new AccountError('Password troppo lunga.')
}

// --- accounts ---------------------------------------------------------------------------------

const userRow = (id: number) =>
  db.prepare('SELECT id, username, hash FROM users WHERE id = ?').get(id) as { id: number; username: string; hash: string } | undefined

export function userIds(): number[] {
  return (db.prepare('SELECT id FROM users ORDER BY id').all() as { id: number }[]).map((r) => Number(r.id))
}

export function register(rawUsername: string, password: string): User {
  const username = rawUsername.trim()
  if (!/^[\p{L}\p{N}._-]{3,24}$/u.test(username)) {
    throw new AccountError('Il nome utente deve avere da 3 a 24 caratteri: lettere, numeri, punto, trattino o trattino basso.')
  }
  checkPassword(password)
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new AccountError('Nome utente già usato, scegline un altro.')
  const first = userIds().length === 0
  const id = Number(db.prepare('INSERT INTO users (username, hash, createdAt) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), Date.now()).lastInsertRowid)
  if (first) adoptLegacyData(id)
  return { id, username }
}

export function login(username: string, password: string): User | null {
  const row = db.prepare('SELECT id, username, hash FROM users WHERE username = ?').get(username.trim()) as
    { id: number; username: string; hash: string } | undefined
  if (!row || !passwordMatches(password, row.hash)) return null
  return { id: Number(row.id), username: row.username }
}

export function changePassword(userId: number, current: string, password: string) {
  const row = userRow(userId)
  if (!row || !passwordMatches(current, row.hash)) throw new AccountError('La password attuale non è corretta.')
  checkPassword(password)
  db.prepare('UPDATE users SET hash = ? WHERE id = ?').run(hashPassword(password), userId)
}

/** Removes the account with all its data: movements, fixed expenses, receipts. */
export function deleteAccount(userId: number, password: string) {
  const row = userRow(userId)
  if (!row || !passwordMatches(password, row.hash)) throw new AccountError('La password non è corretta.')
  db.prepare('DELETE FROM sessions WHERE userId = ?').run(userId)
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  closeUser(userId)
  rmSync(userDir(userId), { recursive: true, force: true })
}

// --- sessions ---------------------------------------------------------------------------------

export function startSession(userId: number): string {
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?, ?, ?)').run(token, userId, Date.now())
  return token
}

export function sessionUser(token: string | undefined): User | null {
  if (!token) return null
  const row = db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.userId WHERE s.token = ?').get(token) as
    { id: number; username: string } | undefined
  return row ? { id: Number(row.id), username: row.username } : null
}

export function endSession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

// --- data from before accounts ----------------------------------------------------------------

const legacyDb = join(dataDir, '__APP_ID__.db')

/** Web Push keys of a server installed before accounts, so existing subscriptions keep working. */
if (existsSync(legacyDb) && !getServerMeta('vapid_public')) {
  const old = new DatabaseSync(legacyDb)
  try {
    for (const key of ['vapid_public', 'vapid_private']) {
      const row = old.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
      if (row) setServerMeta(key, row.value)
    }
  } catch { /* no meta table */ }
  old.close()
}

/** The first account takes over the data of the single password version (database and images). */
function adoptLegacyData(userId: number) {
  if (!existsSync(legacyDb)) return
  const dir = userDir(userId)
  mkdirSync(dir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(legacyDb + suffix)) renameSync(legacyDb + suffix, join(dir, '__APP_ID__.db' + suffix))
  }
  const images = join(dataDir, 'images')
  if (existsSync(images) && !existsSync(join(dir, 'images'))) renameSync(images, join(dir, 'images'))
  console.log(`I dati della versione precedente ora appartengono all'account ${userId}`)
}
