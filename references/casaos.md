# Deployment: Docker, CasaOS installer, HTTPS, nightly updates

Contents: 1 Dockerfile · 2 Entrypoint and local HTTPS · 3 Installer · 4 CasaOS metadata ·
5 HTTPS modes · 6 Updater · 7 Releasing · 8 Raspberry Pi notes

All files are in `assets/template/` and filled by `scripts/scaffold.py`. User-facing messages are
Italian in the templates: translate them to the language chosen at intake, keeping the structure.

## 1. Dockerfile

Two stages on `node:24-alpine`: (1) `npm ci` + `npm run build` of `web/` with `shared/` copied in,
output `server/public`; (2) runtime with `openssl tini`, `npm ci --omit=dev` for the server,
`shared/`, `server/src`, the built `public/`, the entrypoint. `ENV NODE_ENV=production
DATA_DIR=/data PORT=8080 HTTPS_PORT=8443`, `VOLUME /data`, `HEALTHCHECK` with `wget` on
`/api/session`, `ENTRYPOINT ["/sbin/tini","--","docker-entrypoint.sh"]` (tini: proper signals and
zombie reaping), `CMD node --disable-warning=ExperimentalWarning server/src/main.ts`.
Copy `package*.json` before sources so dependency layers are cached between builds.
`.dockerignore`: `**/node_modules`, `server/public`, dev data, logs. Multi-arch comes for free:
the image is built on the server itself (amd64, arm64; armv7 works but slowly).

## 2. Entrypoint and local HTTPS (`casaos/docker-entrypoint.sh`)

When `HTTPS_HOSTS` is set (e.g. `192.168.1.10,casaos.local`): create once a local CA
(`<app>-ca.key/.crt`, 10 years, `CA:TRUE`, keyCertSign) and, whenever the host list changes, a
server certificate signed by it with SANs (`IP:` for numeric hosts, `DNS:` otherwise), 825 days
(longest Apple accepts), `serverAuth`. Phones trust the CA once via `/certificato`; regenerating
the server cert never requires reinstalling the CA. Without `HTTPS_HOSTS` remove the server cert
so the app listens HTTP only. Ends with `exec "$@"`.

## 3. Installer (`casaos/installa.sh`)

Run as `curl -fsSL https://raw.githubusercontent.com/<repo>/<branch>/<dir>/casaos/installa.sh | sudo bash`,
or `sudo bash <dir>/casaos/installa.sh` from a clone. Behavior, in order:

1. Banner, then checks: root, `docker`, `docker info`, Compose v2 plugin or `docker-compose`,
   CasaOS presence (`/var/lib/casaos/apps` or a casaos service), CPU arch (warn on armv7).
2. Questions read from `/dev/tty` (works under `curl | bash`), with defaults in brackets.
3. Existing install (`.env` in the app dir): offer "update keeping data and settings" (skips the
   questions) or reconfigure.
4. Source: the local checkout if the script sits in one, else the codeload tarball of the branch
   (`find -path "*/<dir>"`).
5. Questions: data dir (`/DATA/AppData/<app>` on CasaOS, else `/opt/<app>/data`), port (validated,
   free via `ss`/`netstat` unless already ours), time zone (from `/etc/timezone`/`timedatectl`),
   HTTPS mode (1 Tailscale, 2 local CA with HTTPS port + host list defaulting to LAN IP and
   `hostname.local`, 3 plain HTTP behind a proxy). Tailscale is detected both on the host
   (`tailscale status`) and as a CasaOS container (`docker exec <name> tailscale status`); if chosen
   but absent, fall back to local HTTPS and say how to add Tailscale later.
6. `docker build --pull -t <app>-pwa:latest` in the background with progress dots; on failure
   print the last 25 log lines.
7. Write `.env` with `umask 077` and `docker-compose.yml` (`pull_policy: never`, `restart:
   unless-stopped`, ports, bind mount data → `/data`, env `TZ`, `HTTPS_HOSTS`, `x-casaos` blocks),
   `compose up -d --force-recreate --remove-orphans`, restart `casaos-app-management` so the app
   appears in the dashboard at once.
8. Health check: poll `http://127.0.0.1:$PORT/api/session` up to 2 minutes.
9. Tailscale mode: `tailscale serve --bg --https=443 http://127.0.0.1:$PORT`, read the
   `DNSName` from `tailscale status --json`, print `https://<machine>.<tailnet>.ts.net`; if serve
   fails, explain enabling HTTPS certificates in the Tailscale admin (DNS → HTTPS Certificates).
10. Install `/usr/local/bin/<app>-aggiorna` and offer the nightly timer (default yes; kept if
    already enabled).
11. Final instructions: URLs (LAN and phone), certificate steps for local mode, a warning for
    plain-HTTP mode that anyone reaching it can register, how to install as an app (Android Chrome
    ⋮ → Installa app; iPhone Safari Condividi → Aggiungi alla schermata Home), create the first
    account, import the native backup, how updates work, config/data/log locations.

Questions not to ask anymore once accounts exist: a shared password. Add an invite code question
only if the intake chose "invite code".

## 4. CasaOS metadata (`x-casaos` in the compose file)

Service level: `ports` (container 8080, description en_us/it_it), `volumes` (`/data`). Top level:
`architectures [amd64, arm64]`, `main`, `author`, `developer`, `category` (Finance, Utilities,
Productivity, Media...), `icon` (raw GitHub URL of `web/public/icon-512.png`), `title`, `tagline`,
`description` (en_us + it_it at least), `port_map`, `scheme: http`, `index: /`. Files live in
`/var/lib/casaos/apps/<app>/` (`docker-compose.yml` + `.env`), so the app shows in the CasaOS
dashboard with its icon and opens on click. Outside CasaOS the same files go to `/opt/<app>/`.

## 5. HTTPS modes (why each exists)

- **Tailscale** (recommended): real certificates, works away from home, only the user's devices
  can reach it, WebAuthn works (hostname). Needs MagicDNS + HTTPS certificates enabled in the
  tailnet. `tailscale serve --bg` persists across reboots.
- **Local CA**: no extra service; each phone installs the CA once. WebAuthn works only if the user
  opens it by a hostname in the cert (`hostname.local`), not the IP.
- **HTTP behind proxy/tunnel**: for users with Nginx Proxy Manager, Caddy, Cloudflare Tunnel. Warn
  that public exposure + open registration = strangers can make accounts.
- Plain HTTP on the LAN still works as a website: no install prompt, no push, no lock.

## 6. Updater (`casaos/aggiorna.sh` → `/usr/local/bin/<app>-aggiorna`)

Non-interactive, safe for a timer:
- Options: none (update if newer), `--controlla` (only report), `--forza` (rebuild same version).
- Whole script inside `main()` so it can replace itself while running; self-update at the end
  via copy to a temp file + `mv -f` (atomic rename keeps the running inode).
- `flock -n` on `/run/<app>-aggiorna.lock`: one update at a time.
- Installed version = `version` from the running `/api/session`; latest = `version` in
  `raw.githubusercontent.com/<repo>/<branch>/<dir>/server/package.json`. Equal → exit 0.
- Download tarball, `docker build` to a separate tag `<app>-pwa:nuova`: a failed build leaves the
  running app untouched.
- Backup before switching, from inside the container with `node:sqlite` `backup()` (consistent
  while the server runs): `accounts.db` plus every `users/<id>/<app>.db` (and a legacy single DB if
  present) into `<data>/backup/<version>-<timestamp>/`; keep the last 5 directories.
- Switch: tag current `latest` as `precedente`, `nuova` as `latest`, `compose up -d
  --force-recreate`; wait up to 2 minutes for `/api/session` to report the new version.
- Failure → retag `precedente` as `latest`, recreate, exit 1 with the log command. Success →
  remove `precedente`, `docker builder prune -f` (SD cards fill up), self-update.
- systemd: `<app>-aggiorna.service` (oneshot, `After=network-online.target docker.service`,
  `TimeoutStartSec=1h`, `Nice=10`) + `.timer` (`OnCalendar=*-*-* 04:00`, `RandomizedDelaySec=30min`,
  `Persistent=true`). Logs: `journalctl -u <app>-aggiorna`. Off: `systemctl disable --now
  <app>-aggiorna.timer`.

## 7. Releasing

Bump `version` in `server/package.json` (and `package-lock.json` top-level fields) in the same
push as the changes. Without a bump, servers do not update; with a bump, they update the next
night. The service worker then serves the new shell on the next app open (network-first
navigation) and Settings → "Controlla aggiornamenti" shows it.

## 8. Raspberry Pi notes

- Build takes minutes on a Pi 4/5 (`tsc` + Vite). With 1 GB RAM it can be slow; 2 GB+ is comfortable.
- `node:24-alpine` and `web-push` are multi-arch; no native npm modules are involved (keep it so:
  `node:sqlite` instead of `better-sqlite3` avoids compiling on ARM).
- Keep images small and prune the build cache after updates; data lives on the bind mount.
