import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import * as data from './db.ts'
import * as accounts from './accounts.ts'
import { runJobsForAll, subscribe, unsubscribe, vapidPublicKey } from './push.ts'

const PORT = Number(process.env.PORT ?? 8080)
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443)
const publicDir = process.env.PUBLIC_DIR ?? join(import.meta.dirname, '..', 'public')
const certDir = join(data.dataDir, 'certs')
// The version the updater compares with GitHub: bump it in package.json to release.
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string

// Node runs this file with type stripping: no enums, namespaces or parameter properties.
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// --- helpers ---------------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

async function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'File troppo grande')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req)
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'Richiesta non valida')
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k) out[k] = decodeURIComponent(v.join('='))
  }
  return out
}

const secure = (req: IncomingMessage) =>
  (req.socket as { encrypted?: boolean }).encrypted === true || req.headers['x-forwarded-proto'] === 'https'

// --- auth: one account per person, each with its own data -----------------------------------

const SESSION = '__APP_ID___session'

const sessionUser = (req: IncomingMessage) => accounts.sessionUser(cookies(req)[SESSION])

function startSession(req: IncomingMessage, res: ServerResponse, userId: number) {
  const token = accounts.startSession(userId)
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}${secure(req) ? '; Secure' : ''}`
  res.setHeader('Set-Cookie', `${SESSION}=${token}; ${flags}`)
}

function clearSession(res: ServerResponse) {
  res.setHeader('Set-Cookie', `${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** Account mistakes (name taken, short password...) reach the user as they are. */
function accountCall(work: () => void) {
  try {
    work()
  } catch (e) {
    if (e instanceof accounts.AccountError) throw new HttpError(400, e.message)
    throw e
  }
}

// --- static files ----------------------------------------------------------------------------

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.crt': 'application/x-x509-ca-cert', '.txt': 'text/plain; charset=utf-8',
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string) {
  const stat = statSync(file)
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304)
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ETag: etag,
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const clean = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '')
  const file = join(publicDir, clean)
  if (file.startsWith(publicDir) && clean && existsSync(file) && statSync(file).isFile()) {
    const immutable = clean.startsWith('assets')
    sendFile(req, res, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    return
  }
  // Single page app: every other path gets the shell.
  sendFile(req, res, join(publicDir, 'index.html'), 'no-cache')
}

// --- API -------------------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL, user: accounts.User) => Promise<void> | void
const routes: [string, RegExp, Handler][] = []
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), handler])

route('GET', '/api/session', (req, res) => {
  const user = sessionUser(req)
  json(res, 200, { loggedIn: user != null, username: user?.username ?? null, version: VERSION })
})

route('POST', '/api/register', async (req, res) => {
  const { username, password } = await readJson<{ username?: string; password?: string }>(req)
  accountCall(() => {
    const user = accounts.register(String(username ?? ''), String(password ?? ''))
    startSession(req, res, user.id)
    json(res, 200, { username: user.username })
  })
})

route('POST', '/api/login', async (req, res) => {
  const { username, password } = await readJson<{ username?: string; password?: string }>(req)
  const user = accounts.login(String(username ?? ''), String(password ?? ''))
  if (!user) {
    await new Promise((r) => setTimeout(r, 800))
    throw new HttpError(401, 'Nome utente o password sbagliati')
  }
  startSession(req, res, user.id)
  json(res, 200, { username: user.username })
})

route('POST', '/api/logout', (req, res) => {
  const token = cookies(req)[SESSION]
  if (token) accounts.endSession(token)
  clearSession(res)
  json(res, 200, { ok: true })
})

route('POST', '/api/account/password', async (req, res, _p, _u, user) => {
  const { current, password } = await readJson<{ current?: string; password?: string }>(req)
  accountCall(() => accounts.changePassword(user.id, String(current ?? ''), String(password ?? '')))
  json(res, 200, { ok: true })
})

route('POST', '/api/account/delete', async (req, res, _p, _u, user) => {
  const { password } = await readJson<{ password?: string }>(req)
  accountCall(() => accounts.deleteAccount(user.id, String(password ?? '')))
  clearSession(res)
  json(res, 200, { ok: true })
})

/** Everything the app shows; "unchanged" when the client already has this revision (polling every 30 s). */
route('GET', '/api/state', (_req, res, _p, url) => {
  const rev = data.revision()
  if (url.searchParams.get('since') === String(rev)) {
    json(res, 200, { revision: rev, unchanged: true })
    return
  }
  json(res, 200, { revision: rev, ...data.state() })
})

// TODO(port): one POST (upsert, id 0 = new) and one DELETE per entity, then runJobs() when a
// change can make background work due (import runJobs from push.ts). Example:
// route('POST', '/api/items', async (req, res) => json(res, 200, data.saveItem(await readJson<Item>(req))))

// Photos (receipts, custom logos...): JPEG only, compressed on the phone before upload.
route('POST', '/api/images', async (req, res, _p, url) => {
  const body = await readBody(req, 15 * 1024 * 1024)
  if (body.length < 4 || !(body[0] === 0xff && body[1] === 0xd8)) throw new HttpError(400, 'Immagine non valida')
  const prefix = /^[a-z]{1,16}$/.test(url.searchParams.get('prefix') ?? '') ? url.searchParams.get('prefix') : 'image'
  const name = `${prefix}_${Date.now()}_${randomBytes(3).toString('hex')}.jpg`
  writeFileSync(join(data.imagesDir(), name), body)
  json(res, 200, { path: `/images/${name}` })
})

route('DELETE', '/api/images', (_req, res, _p, url) => {
  const path = url.searchParams.get('path')
  if (path) data.deleteImage(path)
  json(res, 200, { ok: true })
})

// TODO(port): GET/POST /api/backup with the native app's JSON backup format (see references/server.md).

// Push
route('GET', '/api/push/key', (_req, res) => json(res, 200, { key: vapidPublicKey }))
route('POST', '/api/push/subscribe', async (req, res, _p, _u, user) => {
  const { subscription, reminders } = await readJson<{ subscription: Parameters<typeof subscribe>[0]; reminders: boolean }>(req)
  if (!subscription?.endpoint) throw new HttpError(400, 'Iscrizione non valida')
  subscribe(subscription, reminders !== false, user.id)
  json(res, 200, { ok: true })
})
route('POST', '/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = await readJson<{ endpoint: string }>(req)
  if (endpoint) unsubscribe(endpoint)
  json(res, 200, { ok: true })
})

// --- server ----------------------------------------------------------------------------------

const open = new Set(['/api/session', '/api/register', '/api/login', '/api/logout'])

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  try {
    if (path === '/certificato' || path === '/__APP_ID__-ca.crt') {
      const ca = join(certDir, '__APP_ID__-ca.crt')
      if (!existsSync(ca)) throw new HttpError(404, 'HTTPS locale non attivo')
      if (path === '/__APP_ID__-ca.crt') sendFile(req, res, ca, 'no-cache')
      else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(certificatePage(req))
      }
      return
    }
    if (path.startsWith('/api/')) {
      const user = sessionUser(req)
      if (!open.has(path) && !user) throw new HttpError(401, 'Accesso richiesto')
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(path)
        if (match && method === req.method) {
          // Everything the handler reads or writes belongs to the logged in account.
          if (user) await data.withUser(user.id, () => handler(req, res, match.slice(1), url, user))
          else await handler(req, res, match.slice(1), url, { id: 0, username: '' })
          return
        }
      }
      throw new HttpError(404, 'Non trovato')
    }
    if (path.startsWith('/images/')) {
      const user = sessionUser(req)
      if (!user) throw new HttpError(401, 'Accesso richiesto')
      const name = path.slice('/images/'.length)
      const file = join(data.withUser(user.id, data.imagesDir), name)
      if (!/^[\w.-]+$/.test(name) || !existsSync(file)) throw new HttpError(404, 'Immagine non trovata')
      sendFile(req, res, file, 'private, max-age=31536000, immutable')
      return
    }
    serveStatic(req, res, path)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) json(res, status, { error: e instanceof HttpError ? e.message : 'Errore del server' })
    else res.end()
  }
}

/** How to trust the local certificate authority, for the "HTTPS in casa" mode. */
function certificatePage(req: IncomingMessage): string {
  const host = (req.headers.host ?? '').split(':')[0]
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__APP_NAME__ · certificato</title><style>body{font-family:system-ui,sans-serif;background:__BG_LIGHT__;color:#15121F;max-width:560px;margin:auto;padding:24px;line-height:1.5}
a.b{display:inline-block;background:#B8A6FF;color:#15121F;padding:14px 22px;border-radius:99px;text-decoration:none;font-weight:600}li{margin:6px 0}</style></head><body>
<h1>Installa il certificato di __APP_NAME__</h1><p>Serve una volta sola per telefono: dopo, __APP_NAME__ si apre in HTTPS e si può installare come app.</p>
<p><a class="b" href="/__APP_ID__-ca.crt">Scarica il certificato</a></p>
<h3>Android</h3><ol><li>Scarica il file qui sopra.</li><li>Impostazioni → Sicurezza e privacy → Altre impostazioni di sicurezza → Installa da memoria → <b>Certificato CA</b>.</li><li>Scegli <i>__APP_ID__-ca.crt</i> e conferma.</li></ol>
<h3>iPhone</h3><ol><li>Apri questa pagina con Safari e scarica il file.</li><li>Impostazioni → Profilo scaricato → Installa.</li><li>Impostazioni → Generali → Info → Impostazioni attendibilità certificati → attiva <i>__APP_NAME__ CA</i>.</li></ol>
<p>Poi apri <b>https://${host}:${HTTPS_PORT}</b></p></body></html>`
}

await runJobsForAll()
// Like WorkManager's periodic job: background work of every account, every hour.
setInterval(runJobsForAll, 60 * 60 * 1000)

createHttp(handle).listen(PORT, () => console.log(`__APP_NAME__ ${VERSION} su http://0.0.0.0:${PORT}`))

const cert = join(certDir, 'server.crt')
const key = join(certDir, 'server.key')
if (existsSync(cert) && existsSync(key)) {
  createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, handle)
    .listen(HTTPS_PORT, () => console.log(`__APP_NAME__ in HTTPS su https://0.0.0.0:${HTTPS_PORT}`))
}
