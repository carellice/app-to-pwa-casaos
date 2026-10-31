# Web platform: PWA plumbing and native feature mapping

Contents: 1 Feature map · 2 Service worker · 3 Manifest and icons · 4 Data store · 5 Accounts UI ·
6 Push · 7 Biometric lock · 8 Camera and images · 9 Voice · 10 Export and share · 11 App updates

## 1. Feature map (put the final version in the README "differences" table)

| Native | PWA | Notes |
|---|---|---|
| Local DB | Server SQLite per account + localStorage cache | Opens instantly offline with last data; writes need the server |
| DataStore/UserDefaults | localStorage per device and per account | `<app>.settings.<user>` |
| WorkManager / BGTask | Server hourly job | Runs even when no phone is on |
| Local notifications | Web Push from the server | Needs HTTPS; on iPhone only for the installed PWA (iOS ≥ 16.4) |
| BiometricPrompt / FaceID | WebAuthn platform authenticator | Needs HTTPS **and a hostname** (not an IP) |
| Camera / gallery | `<input type=file accept=image/* capture>` + canvas compression | |
| Speech/voice | MediaDevices + 16 kHz WAV → server transcription | |
| Share sheet | `navigator.share({files})`, fallback download | |
| Files export | Blob + `<a download>` | |
| Haptics | `navigator.vibrate` | Android only |
| App shortcuts | Manifest `shortcuts` | Android Chrome |
| Home screen widgets | Not available | Say so |
| Encrypted token storage | Token only on the server | |
| Play Store updates | Service worker update + server auto-update | |

## 2. Service worker (template `web/public/sw.js` + Vite plugin)

- The Vite plugin in `vite.config.ts` stamps `__BUILD__` (timestamp) and `__FILES__` (the shell
  files + every hashed asset) into `sw.js` after the build: each build = new cache name.
- Install: precache `FILES`, `skipWaiting`. Activate: delete old `<app>-*` caches, `clients.claim`.
- Fetch: ignore non-GET, cross-origin and `/api/`; **navigations network-first** with the cached
  `/` as offline fallback; `/assets/`, `/images/` and `FILES` cache-first (they never change).
  Never serve `/` cache-first: the app would stay on the old shell after every update.
- `push` → `showNotification(title, {body, icon:'/icon-192.png', badge:'/badge.png', tag, data:{url}})`.
- `notificationclick` → focus an open window and `postMessage({type:'open', url})`, else
  `openWindow(url)`.
- Register only in production and only when it works (HTTPS or localhost): plain HTTP on a LAN IP
  simply runs as a website.

## 3. Manifest and icons

`display: standalone`, `orientation: portrait`, `start_url`/`scope` `/`, `lang`, colors = native
background, icons 192/512 `any` + 192/512 `maskable` + `apple-touch-icon` 180 + `badge.png`
(white silhouette, Android status bar). Generate them with `scripts/app_icons.py` from the launcher
icon. iOS needs the `apple-mobile-web-app-*` meta tags (template index.html).

## 4. Data store (template `web/src/lib/store.ts`)

`useSyncExternalStore` store with `data`, `revision`, `settings`, `loadError` (+ app UI state such
as the selected month shared across screens). `refresh()` (dedup in-flight, `?since=`),
`mutate(work)` = request then forced refresh; optimistic deletes. Cache and settings keyed by the
lowercase username; `setUser()` after login/session check, `forgetUser()` after account deletion.

## 5. Accounts UI

- **Login screen** in the app's own style (same blob/hero, title, fonts): mode login/register
  toggled by a text link, fields username + password (+ repeat on register, animated in with
  height auto), `autocomplete` `username` / `current-password` / `new-password`, submit on Enter,
  server error shown under the fields, "Bentornato" / "Crea il tuo <App>" titles in the app voice.
- **App gate**: `GET /api/session` → not logged in → login layer; logged in → `setUser(username)`,
  lock if a credential exists, refresh data. Offline with a cached user → open with cache.
  A 401 from any call (`authEvents`) brings back the login.
- **Onboarding** per account (`settings.onboarded`), shown after login on first use.
- **Settings → Account**: "Cambia password" (sheet: current, new, repeat), "Esci" (first
  `disablePush()` so the phone stops getting that account's notifications, then logout and reload),
  "Elimina account" (sheet with password, red button, then `forgetUser` and reload). Subtitle shows
  "Sei entrato come <username>".

## 6. Push (template `web/src/lib/push.ts`)

`enablePush()`: permission → `pushManager.subscribe({userVisibleOnly:true,
applicationServerKey})` with the server key (base64url → bytes) → `POST /api/push/subscribe`;
store `remindersEnabled`. `disablePush()`: unsubscribe server and browser. Explain in the UI when
unsupported: "open it over HTTPS and install it as an app".

## 7. Biometric lock (template `web/src/lib/deviceLock.ts`)

Register: `navigator.credentials.create` with `authenticatorAttachment:'platform'`,
`userVerification:'required'`, `rp.id = location.hostname`; store the credential id per device and
account. Unlock: `navigator.credentials.get` with `allowCredentials` that id. Lock when the app
returns after N seconds hidden (native timeout, e.g. 30 s) so camera/file pickers don't relock.
Hide or explain the option when `isUserVerifyingPlatformAuthenticatorAvailable()` is false or the
host is an IP address.

## 8. Camera and images

Hidden `<input type="file" accept="image/*">` (add `capture="environment"` for direct camera),
decode with `createImageBitmap`, draw on a canvas at the native max size, `toBlob('image/jpeg',
quality)`, upload, keep the returned path. Preview full screen through the overlay portal.

## 9. Voice (template `web/src/lib/voice.ts`)

`VoiceRecorder`: `getUserMedia` mono with echo cancellation, `AudioContext({sampleRate:16000})`,
ScriptProcessor collecting Float32 chunks, level callback for the waveform UI, max duration, WAV
(PCM16) encoder; upload to `/api/ai/transcribe`.

## 10. Export and share

PDF reports: port the native PDF layout to jsPDF (lazy `import('jspdf')`), same fonts if embedded.
Share images (cards): draw on a canvas exactly like the native `Canvas`/Bitmap code, then
`navigator.canShare({files})` ? `navigator.share` : download.

## 11. App updates

Settings "Controlla aggiornamenti": `registration.update()`, wait briefly, if
`registration.waiting` → "Nuova versione disponibile: tocca per aggiornare" → `postMessage
('skipWaiting')` + reload on `controllerchange`. Show the server version from `/api/session`.
