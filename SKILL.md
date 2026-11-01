---
name: app-to-pwa-casaos
description: Converts a native mobile app (Android Kotlin/Compose or XML, iOS SwiftUI/UIKit, Flutter, React Native) into a Progressive Web App that looks, animates and behaves exactly like the original, with a small self-hosted Node + SQLite backend, user accounts, Web Push, a one-command guided installer for CasaOS (Docker) and nightly auto-updates with rollback. Use this skill whenever the user wants a web/PWA version of their own app, wants to self-host an app on a home server, CasaOS, Raspberry Pi, Umbrel-like or Docker box, asks for "the same app but in the browser", or wants an installer script/auto-update for a self-hosted web app — even if they don't say "PWA" or "CasaOS" explicitly.
---

# Native app → identical PWA → self-hosted on CasaOS

This skill captures a complete, proven conversion: a native app re-built as a PWA that is
indistinguishable from the original (colors, fonts, shapes, springs, gestures, copy), served by a
tiny backend that runs in Docker on the user's home server, installed with one `curl | sudo bash`
command and kept up to date every night.

The native app is never modified, with one opt-in exception: if the user wants it (intake round 3),
the native app gets a "server mode" switch in its settings to use the same account and data as the
PWA. Everything else new lives in one folder (default `PWA/`).

## What you will deliver

```
PWA/
├── shared/     pure TypeScript used by server AND web: model, dates, formatting, business logic
├── server/     Node 24 running .ts directly (type stripping), node:sqlite, web-push, no framework
├── web/        React 18 + Vite 5 + framer-motion 11: every screen, built into server/public
├── casaos/     installa.sh (guided install), aggiorna.sh (update + rollback), docker-entrypoint.sh (HTTPS certs)
├── Dockerfile  multi-stage node:24-alpine
├── README.md   install, accounts, updates, differences from the native app, development
└── .gitattributes .gitignore .dockerignore
```

Optional, in the native app (server mode): a settings switch, an API client and a sync layer that
make the phone use the PWA server's account and data, with the local database as a cache.

Architecture choices, and why they hold up:
- **Same data model as the native database** (table and column names) and **same JSON backup format**, so users can move their data between the phone app and the PWA in both directions.
- **The server owns what the phone did in the background**: periodic jobs (WorkManager/BGTask) run hourly on the server; notifications become Web Push; API keys/tokens (AI, third-party APIs) live only on the server and are never sent back to the browser.
- **Accounts with separate data**: each user gets their own SQLite file (`data/users/<id>/`), selected per request with `AsyncLocalStorage`, so data functions never take a user id and isolation is structural, not a WHERE clause someone can forget.
- **No framework, few dependencies**: node:http, node:sqlite, one npm dependency (`web-push`). Builds on a Raspberry Pi in minutes and has little to break.
- **Releases are version bumps**: the updater compares `server/package.json` `version` on GitHub with the running server. Push without a bump = not deployed.

## Workflow

Track these steps in your task list. Do not skip the intake or the inventory: the fidelity of the
result depends on them more than on anything else.

### 1. Intake: ask multiple-choice questions

First inspect the repo (platform, existing backup/export, notifications, biometrics, AI/API keys,
languages) so you only ask what you cannot infer, and so the options you offer are concrete.
Then ask with the multiple-choice question tool (`AskUserQuestion`; max 4 questions per call, so use
two rounds, plus a one-question third round). Put the recommended option first with "(Recommended)". Ask in the user's language.

**Round 1 — the product**
1. *Who uses it and whose data is it?* — Separate accounts, each with private data (Recommended) · Shared data for the whole household, one login each · One shared password, no accounts · Choose per account (create new space or join one with an invite code).
2. *Who can create an account?* — Anyone who can reach the server (fine behind Tailscale/LAN) · Only with an invite/family code set at install time · First account is admin and approves the others. (Skip if no accounts.)
3. *Native-only features to carry over* (multiSelect, list only what the app has) — Notifications → Web Push · Biometric lock → WebAuthn passkey · Background jobs → server cron · Camera/photos → upload to server · Voice input → server transcription · Widgets (not possible on the web: say so) · Share/export files.
4. *How identical must it be?* — Pixel- and motion-identical, same copy (Recommended) · Same look, simplified animations · Same features, web-native look.

**Round 2 — hosting**
1. *How will phones reach it over HTTPS?* (multiSelect; the installer will ask the end user to pick one) — Tailscale (Recommended: real HTTPS, works away from home) · Local CA ("HTTPS in casa", install a certificate once per phone) · Plain HTTP behind an existing reverse proxy / Cloudflare Tunnel.
2. *Updates* — Nightly automatic update with backup and rollback (Recommended) · Manual command only · Both, user chooses at install.
3. *Where does the installer download from?* — This GitHub repo, branch main (Recommended) · Another branch · Private repo (needs a token: warn this complicates curl | bash).
4. *Language of the app UI, installer and README* — Same as the native app (Recommended) · Italian · English · Other.

**Round 3 — the native app**
1. *Do you want to reach the server's data from the native app too?* — Yes: an optional "server
   mode" in the native app's settings, off by default; on, the app uses the same account and data
   as the PWA, keeping a local copy for offline reading (Recommended when the user will use both) ·
   No: the native app stays phone-only (data moves between the two only through the JSON backup).
   Explain in the option text that it modifies the native app and needs a new release of it, and
   that offline the native app can read but not change data in server mode.

Also settle, without a question if the repo or the user already answered: folder name (`PWA`),
app id (lowercase, names the container/image/command), default port (pick a free-looking one like
8095), CasaOS category, and whether you may commit/push when done (default: ask at the end).

### 2. Study the native app and write an inventory

Read `references/study-native.md`, then write `PWA/PORTING.md` (kept in the repo: it is the
checklist for this and future ports). It lists every screen, route, dialog/sheet, the theme
(colors light/dark, fonts and sizes, shapes, elevations), every animation with its exact spec,
custom drawing, the data model, business logic, background work, notifications, permissions,
settings, the backup format, icons and strings. For each item: native source file → web file →
status. Nothing goes into the PWA "by eye" when the native code states the value.

### 3. Scaffold

Write a config JSON with the placeholders and run:

```bash
python <skill>/scripts/scaffold.py --target PWA --config pwa-config.json
```

It copies `assets/template/` (accounts, per-user SQLite, routes skeleton, Web Push, service worker,
Vite config, nav stack, store, WebAuthn lock, Kotlin Random port, Dockerfile, installer, updater),
fills the placeholders and prints every `TODO(port)` left. Placeholders: `APP_ID APP_NAME REPO BRANCH
PWA_DIR DEFAULT_PORT DEVELOPER CASAOS_CATEGORY LANG NATIVE_PLATFORM FONT_FILE BG_LIGHT BG_DARK
TAGLINE_IT TAGLINE_EN DESCRIPTION_IT DESCRIPTION_EN VOLUME_DESC_IT VOLUME_DESC_EN SHORTCUT_NAME SHORTCUT_ROUTE`
(`VOLUME_DESC_*`: what the data folder holds, shown by CasaOS, e.g. "Database e foto").
The installer/updater messages are in Italian: translate them if the chosen language differs.
The installer banner is the fixed COSAC logo (CasaOS App Converter): keep it, never redraw it
with the app's name (the name already appears on the line below it).

Then icons:
```bash
python <skill>/scripts/app_icons.py --foreground <launcher foreground png> --background "#RRGGBB" --monochrome <mono png> --out PWA/web/public
cd PWA/web && npm i -D @material-design-icons/svg@0.14.15 && node <skill>/scripts/material_icons.mjs --style round --out src/lib/icons.gen.ts <names...>
```
Copy the app font file(s) into `web/public` and the `@font-face` into `styles.css`.

### 4. Shared code and server

Read `references/server.md`. Port the model, date math, formatting and business logic once into
`shared/` (both sides import it), the schema into `server/src/db.ts`, every repository write into a
route, background work into `runJobs`, the backup format into `/api/backup`.

### 5. Web app: screens, theme, motion

Read `references/ui-fidelity.md` (theme, typography, Compose/SwiftUI motion → framer-motion,
components, navigation, overlays, gestures) and `references/web-platform.md` (service worker,
manifest, push, WebAuthn, camera, voice, files, offline, accounts UI). Build screen by screen
following the inventory, comparing with the native app as you go.

### 6. Deployment

Read `references/casaos.md`. The templates already contain the Dockerfile, entrypoint, installer and
updater; adapt texts, the CasaOS metadata, the backup step (database file names) and the final
instructions printed by the installer. Keep `.gitattributes` (LF for `*.sh` and `Dockerfile`):
a CRLF script breaks on Linux with `$'\r': command not found`.

### 7. Native app on the server (only if chosen in round 3)

Read `references/native-server-mode.md`. Android: copy `assets/native-android/ServerClient.kt`
and `network_security_config.xml`, write the app-specific `ServerSync`, route every repository
write through it, add the settings screen, the 30-second refresh and the reminder handling, and
test it on an emulator against the PWA server running locally. Other platforms: same design with
their HTTP and secure storage APIs. Then release the native app with its usual process.

### 8. Verify

Read `references/verification.md` and do all of it: typecheck/build, server API with curl
(including account isolation), every flow in a 375×812 browser in light and dark, side-by-side
with the native app, the updater simulated with stub `docker`/`curl`, the installer syntax-checked.
Report honestly what could not be verified locally (Docker build, real CasaOS, push on a real phone,
Tailscale, WebAuthn on a hostname).

### 9. Deliver

README (install command, HTTPS modes, accounts, updates, differences from the native app,
development), `PORTING.md` statuses updated. Commit and push only if the user said so, respecting
their commit conventions. Tell them the install command:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<PWA_DIR>/casaos/installa.sh | sudo bash
```

works only after the folder is pushed, and that a release = bump `server/package.json` `version` + push.

## Pitfalls that cost real time (details in the references)

- SVG elements have no `offsetWidth`: measure the parent element.
- Overlay/FAB containers stacked over the screen need `pointer-events: none` (children `auto`), or they eat taps.
- Use `overflow: clip`, not `hidden`, on the app shell and layers: `scrollIntoView`/focus otherwise shifts the whole app.
- History-backed navigation: programmatic `back()` must bypass in-screen back handlers (a `programmatic` flag), or saving a form "goes back a step" instead of closing.
- Service worker: navigations network-first; never put `/` in a cache-first list, or users get a stale shell after updates.
- framer-motion `Transition` union types: return explicit `Spring`/`Tween` types from helpers.
- Node type stripping: no `enum`, `namespace`, parameter properties; import with `.ts` extensions.
- Windows dev box: Git Bash paths (`/tmp/...`) are not valid for Node; use `cygpath -w`. `PATH` entries must be `/c/...`, not `C:/...`.
- WebAuthn needs HTTPS and a hostname: it never works on `https://192.168.x.x`.
- The updater's DB backup must cover every account database, not a single file.
- Native server mode: rename an uploaded image to its server name only after the row is saved, and
  check every caller of a repository write: a failed save must keep the form open.
