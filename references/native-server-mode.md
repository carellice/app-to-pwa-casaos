# Native app on the PWA server ("server mode")

Optional, only when the intake answer says so. The native app gets a switch in its settings:
off (default), everything stays on the phone as before; on, the app uses the same account and
data as the PWA on the user's own server. Every user of the app can point it at their own server.
This is the one case where the native app is modified: keep the change small and self-contained.

Contents: 1 Design · 2 Server side · 3 Android client · 4 Writes and errors · 5 Offline changes ·
6 Refresh · 7 Images · 8 Background work · 9 Settings screen · 10 Other platforms · 11 Verification

## 1. Design (why it is built this way)

- **The server is the source of truth, the local database is a cache.** Screens keep reading the
  native database (Room, Core Data, sqflite...), so no screen changes and the app still opens and
  shows data offline. Every write goes to the server API first; the local copy is then reloaded
  from the server. No merging and no conflict resolution: the last change to reach the server wins.
- **Offline: changes wait on the phone.** When the server can't be reached, the change is applied
  to the local database and saved in an outbox file; the outbox is sent, in order, before any
  other write and before every reload, so a reload never wipes changes not yet sent (section 5).
- **Same API as the PWA**, same session cookie, same accounts. The server needs no changes when it
  comes from the template: `/api/login`, `/api/register`, `/api/state?since=<revision>`, the
  per-entity `POST`/`DELETE` routes, `/api/images`, `/api/backup`.
- **The server owns background work** in server mode (fixed expenses, scheduled jobs): the phone's
  workers must stop doing it, or every run creates duplicates.

Ask nothing more than the intake answer: this design is the default. Mention to the user when
delivering that offline changes are sent later and that on conflicts the last one wins.

## 2. Server side

Check, don't build: `GET /api/state` returns `{revision, ...all rows}` or `{revision, unchanged:
true}` when `since` matches; every write bumps the revision (`touch()` in `db.ts`); writes upsert
by id (id 0 = new, any other id replaces or recreates the row, so "undo delete" works); `POST
/api/images` names files `<prefix>_<ms>_<6 hex>.jpg`; `/api/backup` imports the native backup
format keeping ids. **Every save route must return the id it gave the row** (and a parent with
children, such as a category with subcategories, the children's ids in order): the outbox needs
them to map the ids the phone gave offline. Add it to any route that only answers `{ok: true}`.

No push to the native app: Web Push reaches browsers only. The native app shows its own local
notifications from synced data (section 8).

## 3. Android client

Copy `assets/native-android/ServerClient.kt` into the app's data package and replace
`__PACKAGE__`, `__APP_ID__` (the session cookie is `<app id>_session`), `__APP_NAME__`. It holds:
- `ServerStore`: URL, username, session token encrypted with an Android Keystore AES key
  (SharedPreferences, so a restored backup on another phone just drops the token), last revision,
  reminders already shown. `config` is a `StateFlow<ServerConfig?>`: null = server mode off.
- `ServerClient`: `HttpURLConnection` + `org.json` (no new dependencies). `login(register=)` reads
  the token from `Set-Cookie`; `state`, `post`, `delete`, `importBackup`, `uploadImage`,
  `deleteImage`, `downloadImage`. Errors become `ServerException` with the server's own message,
  plus clear Italian messages for unreachable host, TLS failure, redirect (wrong http/https), and
  expired session. `normalizeUrl` adds `https://` and drops the trailing slash.

Copy `assets/native-android/network_security_config.xml` to `res/xml/` and set
`android:networkSecurityConfig="@xml/network_security_config"` on `<application>`: it trusts user
CAs (the installer's local-CA mode) and allows HTTP (LAN or reverse-proxy setups). Show a warning
in the form when the address starts with `http://`.

Then write the app-specific `ServerSync` (in Money: `data/ServerSync.kt`), wrapped by the existing
repository:
- JSON ⇄ entity for every table with **all** fields (image paths and bookkeeping fields such as
  `notifiedFor` too; the backup format usually omits them).
- `pull(force)`: `state(since = stored revision)`; if changed, replace every local table in one
  transaction and store the new revision. A `Mutex` serializes pulls and writes.
- `write { config -> ... }`: run one API call, then pull. Record the error in a `StateFlow` status
  the settings screen shows.
- `upload(snapshot)`: post the native backup JSON to `/api/backup`, then images one by one.
- `encode`/`decode`: the full local snapshot as JSON, used to keep "the data from before".

## 4. Writes and errors

In the repository, each write becomes
`either(failed, remote = { submit(Change...) }, offline = { ...old code, then enqueue }, local = { ...old code })`:
local mode runs the old code untouched; server mode sends the change; when the server can't be
reached (`ServerException.offline`: no connection, or 502-504 from a proxy) `offline` applies the
old code and queues the change with the ids the phone gave; any other error emits a message on an
`errors` flow and returns `failed`. The activity collects `errors` (merged with the outbox notices)
into a Toast/snackbar. Writes that make no sense offline (importing a whole backup) have no
`offline` and keep failing with a message.

Pick `failed` values the callers can read: ids return `-1`, so form view models check
`if (savedId < 0) return@launch` before closing (otherwise the screen closes and the input is
lost). A "delete category" that returns `false` for "in use" must not also return `false` for
"network error" (that would show the wrong message): return `true` and let the error toast speak.
Find every caller of the repository writes (`grep` the write function names) and check each one.

## 5. Offline changes (the outbox)

In Money: `data/PendingChanges.kt` (`Change`, `Outbox`) and the writes section of `ServerSync.kt`.
- Every write is a `Change` (sealed type: save or delete per entity, plus "delete image"). Online
  and offline go through the same `send(config, change)`, so there is one code path.
- A row created offline keeps the id the phone gave it, marked `created`. Sending it posts id 0;
  the id the server answers is recorded (`table -> phone id -> server id`), and every later change
  is rewritten through that map before it is sent: its own id and every reference (category,
  subcategory, fixed expense, person, payment method). A form opened before the sync may still hold
  a phone id, so online sends go through the same rewrite.
- Images saved offline are uploaded when their row is sent; the local file is renamed to the
  server name only after the row is saved, and the rename is recorded too, so a later change that
  still points to the old path finds the file.
- The outbox (changes + id map + path map) is a JSON file written after every step, so a send
  interrupted halfway resumes where it stopped without duplicating rows.
- `flush` runs under the sync mutex before every write and every pull: offline or session expired
  (401) stops it and keeps the queue; a change the server refuses (4xx) is dropped with a message.
  A delete answered 404 counts as done.
- After a reload that replaced the local tables (outbox empty), clear the id and path maps: the
  phone now has the server's ids and an old phone id could clash with a new server one.
- Turning server mode on or off clears the outbox; the settings screen shows how many changes are
  waiting and the disconnect dialog warns they would be lost.
- First queued change shows "Server non raggiungibile: salvato sul telefono, lo invio appena torna
  la connessione"; later ones don't repeat it.

## 6. Refresh

In the main activity: `repeatOnLifecycle(STARTED) { while (true) { repository.refresh();
delay(30_000) } }`. It runs on open and while the app is visible, costs one tiny request when
nothing changed (`unchanged`), and makes changes from the PWA or other phones appear. The settings
screen has "Aggiorna ora" (`pull(force = true)`).

## 7. Images

Local paths stay in the local database; server paths are `/images/<name>`.
- Pull: for each server path, the local file is `<imagesDir>/<name>`; download it if missing.
- Push: a local file already named like a server image (`isServerImage`: the random hex suffix the
  app's own names don't have) maps back to `/images/<name>`; otherwise upload it, post the row, and
  only then rename the local file to the server name. Renaming before the row is saved loses the
  photo when the save fails and the user taps Save again.
- `deleteImage` also deletes the server copy (fire and forget) when the name is a server name.

## 8. Background work and notifications

The periodic worker keeps running in server mode but only pulls and shows local notifications:
reminders the server marked as due (in Money: active items with `notifiedFor == nextDate`) that
this phone hasn't shown yet (`ServerStore.shownReminders`, keyed `id:date`). It never generates
rows. Seeding default data is skipped in server mode: the server seeds new accounts itself.

## 9. Settings screen

A row in the main settings ("Usa il server CasaOS", subtitle "Attivo: user su host" or "Spento:
i dati restano solo sul telefono") opens a screen in the app's own style:
- Off: address, "Ho già un account" / "Creane uno", username, password, "Collega il server".
- After login, if the phone has data: a dialog "Quali dati vuoi usare?" with counts on both sides:
  "Quelli del telefono" (upload) or "Quelli del server" (pull). Phone without data: take the
  server's silently. Dismissing logs out and changes nothing.
- Before either choice, save the phone's full snapshot to a file (`dati-prima-del-server.json`).
  If the switch-on fails halfway, clear the config: never leave the app half in server mode.
- On: status ("Aggiornato alle 17:33" or the last error), "Aggiorna ora", "Scollega il server".
- Turning off: log out, clear the config, then "Tieni i dati attuali" (the server copy stays on
  the phone) or "Torna a quelli di prima" (restore the saved snapshot); delete the saved file.
- Importing a JSON backup in server mode replaces the account's data on the server: say so in
  the import confirmation.

## 10. Other platforms

Same design, platform tools: iOS `URLSession` + Keychain for the token, ATS exception for HTTP
and a user-installed CA profile for local HTTPS; Flutter `http` + `flutter_secure_storage`; React
Native `fetch` (cookies handled manually through the `Set-Cookie` header) + Keychain/Keystore.
Port `ServerClient.kt` and keep sections 1 and 4–9 unchanged.

## 11. Verification

Run the PWA server locally (`DATA_DIR=<tmp> PORT=8095 node --disable-warning=ExperimentalWarning
server/src/main.ts`), register an account and add rows with curl, then on the emulator (the host
is `http://10.0.2.2:8095`; on Git Bash prefix adb commands with `MSYS_NO_PATHCONV=1` so
`/sdcard/...` is not rewritten):
1. Connect with data on both sides, choose the server: its rows appear.
2. Add a row in the app: it is on the server (`curl /api/state`).
3. Add a row with curl: it appears in the app within 30 s.
4. Stop the server and save: error message, form stays open; restart, save works.
5. Turn off with "Torna a quelli di prima": the old data is back.
6. Connect again choosing the phone: the server now has the phone's rows.
7. Add a row with a photo (push a JPEG to `/sdcard/Pictures`, pick it from the gallery): the
   server has the image and the local file has the server name; delete the local file, change
   something on the server: the image is downloaded again.
8. Stop the server; in the app create a payment method (or any referenced row), a person and a
   movement that uses both: they appear at once and the outbox file
   (`run-as <package> cat files/<outbox>.json`) lists three changes. Start the server and create
   rows of the same kinds with curl first (so the server's next ids differ from the phone's), then
   bring the app to the foreground: the outbox empties and on the server the movement points to the
   server ids of the new method and person.
Then release the native app the usual way (its version, not the PWA's: the server did not change).
