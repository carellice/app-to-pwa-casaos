# Verification

Do all of it before saying the port is done, and report what could not be checked.

## 1. Build

```bash
cd PWA/web && npm run build          # tsc --noEmit && vite build; zero type errors
cd PWA/server && npm install
bash -n PWA/casaos/installa.sh && bash -n PWA/casaos/aggiorna.sh && sh -n PWA/casaos/docker-entrypoint.sh
```
`bash -n` does not see the YAML inside the heredoc. Render the compose file the installer writes, for
both `MODE=local` (extra HTTPS port) and another mode, and parse it:
```bash
for MODE in local tailscale; do
  APP=x IMAGE=x:latest REPO=o/r BRANCH=main PORT=8095 MODE=$MODE bash -c '
    https_ports=""; [ "$MODE" = local ] && https_ports="      - \"\${HTTPS_PORT}:8443\""
    '"$(sed -n '/^cat > "\$APP_DIR\/docker-compose.yml" <<EOF/,/^EOF$/p' PWA/casaos/installa.sh \
        | sed 's#"\$APP_DIR/docker-compose.yml"#/dev/stdout#')" > compose-$MODE.yml
  docker compose -f compose-$MODE.yml config -q \
    || python -c "import sys, yaml; yaml.safe_load(open(sys.argv[1]))" compose-$MODE.yml
done
```
If Docker is available: `docker build -t test PWA` and run it with a temp volume.

## 2. Server API with curl

Start a throwaway server: `DATA_DIR=<temp> PORT=8099 PUBLIC_DIR=public node --disable-warning=ExperimentalWarning src/main.ts`
(on Windows pass `DATA_DIR` through `cygpath -w`). Check:
- `/api/session` logged out; register with invalid name → 400 message; register A and B; duplicate
  name (different case) → refused; login wrong password → 401 after delay; login with other case → ok.
- Write as A, read as B: B sees nothing of A (state, images: A's image URL → 404 for B).
- Change password (wrong current → 400, right → ok); delete account → session gone, folder removed.
- Every entity route: create (id 0), update, delete, 409 rules; `/api/state?since=` returns
  `unchanged` when nothing changed.
- Backup round trip: export, import into another account, compare counts; import a backup made
  by the native app.
- Legacy adoption: a data dir with a pre-accounts DB, images and VAPID keys → first account owns
  them, push key unchanged.
- Jobs: an item due in the past is processed once, survives a restart without double processing.

## 3. In the browser (375×812, light and dark)

Use the built-in browser pane / Playwright at mobile size against the throwaway server
(`npm run build` first, the server serves `server/public`). Clear `localStorage` and unregister
service workers between runs. Walk every screen in PORTING.md: open, every action, back gesture
(history back), sheets drag to dismiss, dialogs, undo, empty states, errors, onboarding, login
and register (mismatching passwords), account sheets, logout and login as another account
(data and settings switch; check `localStorage` keys per user), offline reopen (cached data).
Compare side by side with native screenshots for spacing, sizes, colors, font rendering; for
motion, record both (or compare with the specs in PORTING.md).

Test credentials you create here are test data for a local server only.

## 4. Updater simulation (no Docker needed)

Copy `aggiorna.sh` with `sed` rewriting the app dir, lock file and `/usr/local/bin` to a temp
folder; put stub `id` (prints 0), `docker` (logs calls; `build` fails when `FAIL_BUILD` is set;
`compose up` writes the "running version" file, or removes it when `FAIL_START` is set, or
restores the old version after a `tag ...precedente ...latest`), `curl` (raw GitHub → newer
package.json, codeload → a local tarball with `PWA/server/package.json` and `casaos/aggiorna.sh`,
`127.0.0.1` → `{"version": "<running>"}`), `sleep` and `seq` stubs in a `bin/` first on `PATH`
(on Git Bash use `/c/...` paths in `PATH`). Cases: `--controlla`, update ok, already updated,
build fails (old version keeps running), new version does not start (rollback to old), `--forza`.
Also run the backup JS against a sample data folder with `node -e` (replace `/data` with the
folder) and check every account DB is copied.

## 5. What cannot be verified locally (say it)

Real Docker build on the target (arm64), CasaOS dashboard entry, `tailscale serve`, the
certificate install on phones, Web Push delivery on a real phone (needs HTTPS), WebAuthn on a
hostname, AI/transcription calls without the user's keys. Give the user a short checklist for the
first install on their server.
