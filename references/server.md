# Server: Node 24 + SQLite, accounts, jobs, push, backup

Contents: 1 Runtime · 2 Shared code · 3 Database · 4 Accounts · 5 API · 6 Images · 7 Background jobs ·
8 Web Push · 9 Secrets and AI proxy · 10 Backup · 11 Static files and HTTPS · 12 Local dev

## 1. Runtime

- Node ≥ 24 runs `.ts` directly (type stripping): `node --disable-warning=ExperimentalWarning src/main.ts`.
  Only erasable TypeScript: no `enum` (use string unions + `as const` objects), no `namespace`, no
  constructor parameter properties (declare fields), no `import x = require`. Import local files with
  the `.ts` extension. `import.meta.dirname` for paths.
- Built-ins only: `node:http`, `node:https`, `node:sqlite` (`DatabaseSync`), `node:crypto`
  (`scryptSync`, `randomBytes`, `timingSafeEqual`), `node:async_hooks` (`AsyncLocalStorage`).
  One dependency: `web-push@3.6.7`. Commit `package-lock.json` (the Dockerfile runs `npm ci`).
- Env: `PORT` (8080 in the container), `HTTPS_PORT` (8443), `DATA_DIR` (`/data`), `PUBLIC_DIR`
  (defaults to `server/public`), `TZ`.
- `GET /api/session` returns `{ loggedIn, username, version }`: the updater and the installer's
  health check read `version` from it.

## 2. Shared code (`shared/`)

Pure TS with no DOM or Node imports, imported by both sides (`../../shared/x.ts`); web
`tsconfig.json` includes `../shared`. Port here: entity types, enums as unions, default seed data,
date math, money/number/date formatting, recurrence, reports/statistics, validation.

Dates: if the native app stores `LocalDate.toEpochDay()`, keep epoch days (integers, UTC-free) and
port the helpers (`today()` from local date, `ymd(day)`, month index `y*12 + m-1`). Never use
`Date` timestamps for day-based logic: timezones shift days.

Formatting: port the exact native formatters (e.g. `NumberFormat.getCurrencyInstance(Locale.ITALY)`
→ `Intl.NumberFormat('it-IT', {style:'currency', currency:'EUR', useGrouping:'always'})`), relative
dates ("oggi", "domani", "tra 3 giorni") and month names in the same words.

## 3. Database (template `server/src/db.ts`)

- **Same tables and columns as the native DB** (Room entity names/fields, Core Data entities...),
  so the backup maps 1:1 and the business logic ports line by line. Booleans as INTEGER 0/1, colors
  as ARGB INTEGER, dates as epoch-day INTEGER, money as cents INTEGER.
- Per-account file `data/users/<id>/<app>.db`, `PRAGMA journal_mode = WAL`, schema applied with
  `CREATE TABLE IF NOT EXISTS` on open; additive migrations with guarded `ALTER TABLE ADD COLUMN`
  (check `PRAGMA table_info`).
- `withUser(id, work)` runs `work` with that account's DB in `AsyncLocalStorage`; `db.prepare`/
  `db.exec` resolve to the current account. The request handler wraps every authenticated route,
  background jobs loop over `userIds()`. Data functions stay user-agnostic.
- `meta` table: per-account key/values (`revision`, AI config, last notice sent...).
- `revision` bumped after each committed transaction: clients poll `GET /api/state?since=<rev>`
  every 30 s and on `visibilitychange` and get `{unchanged:true}` cheaply.
- `upsert(table, columns, entity)` reproduces Room `@Upsert` (id 0 inserts, else
  `INSERT OR REPLACE` with the id). Clients send whole entities, like the native repository.
- Deletion rules: port `ON DELETE` behavior and the native repository's manual cleanup (e.g.
  nulling a foreign key, refusing to delete a category in use with 409 and a human message).
- `seedIfEmpty()` per new account: the native first-run defaults.

## 4. Accounts (template `server/src/accounts.ts`)

- `accounts.db` (server-wide): `users(id, username UNIQUE COLLATE NOCASE, hash, createdAt)`,
  `sessions(token, userId, createdAt)`, `meta` (server-wide values such as VAPID keys).
- Username 3–24 chars `[\p{L}\p{N}._-]`, case-insensitive unique; password ≥ 6 chars. Hash
  `scrypt$<salt hex>$<hash hex>` (16-byte salt, 64-byte key), compare with `timingSafeEqual`.
- Session cookie: random 32 bytes hex, `HttpOnly; SameSite=Lax; Path=/; Max-Age=400 days`,
  `Secure` when the request is HTTPS or `X-Forwarded-Proto: https` (Tailscale serve / proxies).
- Failed login: 800 ms delay, generic message ("Nome utente o password sbagliati").
- Routes: `POST /api/register`, `/api/login`, `/api/logout`, `/api/account/password`
  (current + new), `/api/account/delete` (password; deletes sessions, user row, closes the DB,
  removes `users/<id>` recursively).
- Variants from the intake:
  - *Invite code*: env `INVITE_CODE` set by the installer; `register` requires it.
  - *Admin approval*: `users.approved` (first user auto-approved and admin); login refuses
    unapproved; admin list/approve routes and a Settings section.
  - *Shared household data*: keep accounts for login, but `withUser` always opens one shared DB;
    add `memberId`/`createdBy` columns if the app shows who did what.
  - *Single password*: `MONEY_PASSWORD`-style env, `sessions` without user, skip accounts UI.
- Legacy adoption: if a pre-accounts `data/<app>.db` exists, the first registered account takes it
  over (rename DB, `-wal`, `-shm` and `images/` into `users/1/`); VAPID keys are copied from the
  legacy meta at startup so existing push subscriptions keep working.

## 5. API

- Tiny router: `route(method, '/api/items/:id', handler)` → regex; handlers get
  `(req, res, params, url, user)`. JSON helpers `json(res, status, body)`, `readJson`, `readBody`
  with a size limit (25 MB default, 15 MB images, 8 MB audio). Errors: `HttpError(status, message)`;
  messages are user-facing, in the app language; unknown errors → 500 "Errore del server" + log.
- Per entity: `POST /api/<entity>` (upsert, returns the saved row) and `DELETE /api/<entity>/:id`.
  Composite saves (a category with its subcategories) in one transaction.
- After writes that can make background work due (e.g. a recurring item), call `runJobs()` for the
  current account before responding.
- `GET /api/state` returns everything the screens need in one payload (the native app had it all
  locally; the PWA keeps it in memory and in localStorage). Fine up to a few MB; paginate only if
  the native app paginates.

## 6. Images

`POST /api/images?prefix=receipt` with the JPEG body (client compresses like the native app:
canvas resize to the native max side, quality 0.8–0.85); check the JPEG magic bytes `FF D8`;
random file name `prefix_<ts>_<hex>.jpg` in the account's `images/`; return `{path:'/images/…'}`
stored in the row. `GET /images/<name>` only for the logged-in account (name regex `^[\w.-]+$`),
`Cache-Control: private, max-age=31536000, immutable`. `DELETE /api/images?path=` with the same
checks. Images are excluded from JSON backups (say so in Settings and README).

## 7. Background jobs

Native WorkManager/BGTask jobs become `runJobs()` per account, run at startup and every hour
(`setInterval(runJobsForAll, 3600000)`), plus after relevant writes. Make them idempotent and
catch-up capable: process everything due up to today (loop with a guard), remember what was
already notified (`notifiedFor` column/meta) so restarts never double-send.

## 8. Web Push (template `server/src/push.ts`)

- VAPID keys generated once, stored in `accounts.db` meta; subject = the repo URL or a mailto.
- `GET /api/push/key`, `POST /api/push/subscribe {subscription, reminders}`,
  `POST /api/push/unsubscribe {endpoint}`. Subscriptions are stored per account; subscribing an
  endpoint removes it from every other account (shared phone switching accounts).
- `send({title, body, url, tag})` to all the account's subscriptions; drop 404/410; TTL 24 h. `tag`
  replaces older notifications of the same kind; `url` is the deep link opened on tap.
- Port the native notification texts exactly, including plural/relative-date logic.

## 9. Secrets and AI proxy

Never ship API tokens to the browser. Store them per account in `meta` via a settings route; the
status route returns `{ hasToken: true }`, never the token. The server calls the provider
(fetch with timeout, error messages mapped to friendly text, `502` to the client). Cache expensive
answers keyed by a signature of the input data (`ai_cache(month, signature, text)`). For voice: the
client uploads 16 kHz mono WAV, the server forwards to the transcription model.

## 10. Backup (`GET/POST /api/backup`)

Same JSON as the native export (`app`, `version`, `exportedAt`, arrays with the same keys). Import
validates (`app` name, required arrays), tolerates older files (missing newer arrays/fields with
defaults), drops dangling references, replaces all data in one transaction, clears caches. Export
streams `application/json` with a dated file name client-side (`<app>-backup-YYYY-MM-DD.json`).

## 11. Static files and HTTPS

- `serveStatic`: `/assets/*` → `public, max-age=31536000, immutable`; other files `no-cache` with
  ETag/304; unknown paths → `index.html` (SPA). Path traversal guarded with `normalize` +
  `startsWith(publicDir)`.
- HTTPS: if `DATA_DIR/certs/server.crt` and `server.key` exist (created by the entrypoint when
  `HTTPS_HOSTS` is set), also listen on `HTTPS_PORT`. `/certificato` serves an instruction page
  and `/<app>-ca.crt` the CA (Android: Settings → Security → Install CA certificate; iPhone:
  profile install + Certificate Trust Settings).

## 12. Local development

```bash
cd PWA/server && npm install && npm run dev        # API on :8080, data in server/data
cd PWA/web && npm install && npm run dev           # Vite on :5173, proxies /api and /images to :8080
cd PWA/web && npm run build                        # tsc --noEmit && vite build → server/public
```
