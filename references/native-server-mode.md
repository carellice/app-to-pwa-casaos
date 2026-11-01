# Native app on the PWA server ("server mode")

Optional, only when the intake answer says so. The native app gets a switch in its settings:
off (default), everything stays on the phone as before; on, the app uses the same account and
data as the PWA on the user's own server. Every user of the app can point it at their own server.
This is the one case where the native app is modified: keep the change small and self-contained.

Contents: 1 Design · 2 Server side · 3 Android client · 4 Writes and errors · 5 Refresh ·
6 Images · 7 Background work · 8 Settings screen · 9 Other platforms · 10 Verification

## 1. Design (why it is built this way)

- **The server is the source of truth, the local database is a cache.** Screens keep reading the
  native database (Room, Core Data, sqflite...), so no screen changes and the app still opens and
  shows data offline. Every write goes to the server API first; the local copy is then reloaded
  from the server. No merging, no conflict resolution, no sync queue: that is what keeps it small
  and correct.
- **Offline: read-only.** A write without the server fails with a message and the form stays open
  with what the user typed. Queuing offline writes would turn this into a two-way sync (ids,
  conflicts, deletions): don't, unless the user explicitly asks and accepts the cost.
- **Same API as the PWA**, same session cookie, same accounts. The server needs no changes when it
  comes from the template: `/api/login`, `/api/register`, `/api/state?since=<revision>`, the
  per-entity `POST`/`DELETE` routes, `/api/images`, `/api/backup`.
- **The server owns background work** in server mode (fixed expenses, scheduled jobs): the phone's
  workers must stop doing it, or every run creates duplicates.

Ask nothing more than the intake answer: this design is the default. Mention the offline
limitation to the user when delivering.

## 2. Server side

Check, don't build: `GET /api/state` returns `{revision, ...all rows}` or `{revision, unchanged:
true}` when `since` matches; every write bumps the revision (`touch()` in `db.ts`); writes upsert
by id (id 0 = new, any other id replaces or recreates the row, so "undo delete" works); `POST
/api/images` names files `<prefix>_<ms>_<6 hex>.jpg`; `/api/backup` imports the native backup
format keeping ids. If a write route of the port returns nothing useful, the client reloads state
anyway, so it doesn't matter.

No push to the native app: Web Push reaches browsers only. The native app shows its own local
notifications from synced data (section 7).

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

In the repository, each write becomes `either(failed, remote = { ... }, local = { ...old code })`:
local mode runs the old code untouched; server mode calls `ServerSync` and on any exception emits
a message on an `errors` `SharedFlow` and returns `failed`. The activity collects `errors` into a
Toast/snackbar.

Pick `failed` values the callers can read: ids return `-1`, so form view models check
`if (savedId < 0) return@launch` before closing (otherwise the screen closes and the input is
lost). A "delete category" that returns `false` for "in use" must not also return `false` for
"network error" (that would show the wrong message): return `true` and let the error toast speak.
Find every caller of the repository writes (`grep` the write function names) and check each one.

## 5. Refresh

In the main activity: `repeatOnLifecycle(STARTED) { while (true) { repository.refresh();
delay(30_000) } }`. It runs on open and while the app is visible, costs one tiny request when
nothing changed (`unchanged`), and makes changes from the PWA or other phones appear. The settings
screen has "Aggiorna ora" (`pull(force = true)`).

## 6. Images

Local paths stay in the local database; server paths are `/images/<name>`.
- Pull: for each server path, the local file is `<imagesDir>/<name>`; download it if missing.
- Push: a local file already named like a server image (`isServerImage`: the random hex suffix the
  app's own names don't have) maps back to `/images/<name>`; otherwise upload it, post the row, and
  only then rename the local file to the server name. Renaming before the row is saved loses the
  photo when the save fails and the user taps Save again.
- `deleteImage` also deletes the server copy (fire and forget) when the name is a server name.

## 7. Background work and notifications

The periodic worker keeps running in server mode but only pulls and shows local notifications:
reminders the server marked as due (in Money: active items with `notifiedFor == nextDate`) that
this phone hasn't shown yet (`ServerStore.shownReminders`, keyed `id:date`). It never generates
rows. Seeding default data is skipped in server mode: the server seeds new accounts itself.

## 8. Settings screen

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

## 9. Other platforms

Same design, platform tools: iOS `URLSession` + Keychain for the token, ATS exception for HTTP
and a user-installed CA profile for local HTTPS; Flutter `http` + `flutter_secure_storage`; React
Native `fetch` (cookies handled manually through the `Set-Cookie` header) + Keychain/Keystore.
Port `ServerClient.kt` and keep sections 1 and 4–8 unchanged.

## 10. Verification

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
Then release the native app the usual way (its version, not the PWA's: the server did not change).
