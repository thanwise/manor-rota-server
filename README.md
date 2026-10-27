# Rota app server

A shift rota for shops, forecourts and other retailers. One server keeps the rota in a database. Every phone opens the app in a browser, signs in with a PIN and sees the same rota, with changes showing up on every phone within a second or two. On an iPhone, use Safari's **Add to Home Screen** and it opens like an app.

The first time it starts, it loads the Manor staff and the September and October 2026 shifts from `seed.json`. Delete or replace that file before the first start if you want to begin with an empty rota.

## What it does

- Weekly rota by day, with quick-pick shift types, custom times, day off and holiday
- Job roles, contracted hours and an Under 18 flag for each person
- Checks for each week: weekly hours limit, rest between shifts, overlapping shifts, under-18 limits, contract hours and understaffing
- Minimum staffing rules, such as 2 people from 07:00 to 09:00 on weekdays, shown on a 24-hour cover bar
- Unpaid breaks taken off long shifts, a weekly labour budget in hours and £, and monthly paid hours and estimated pay
- Day notes, time-off requests that the manager approves, and the week as text to paste into WhatsApp
- Manager and staff PINs, a change log, a payroll CSV export, backup and restore, and automatic daily backups

| Signed in with | Can do |
|---|---|
| Manager PIN | Everything, including pay rates, settings, PINs, approvals and backups |
| Staff PIN | View the rota and hours, and request time off. No pay rates are sent to their phone. |

## Choose where to host it

| Option | Good for | HTTPS | Cost |
|---|---|---|---|
| A PC at the shop | Trying it out, staff on the shop Wi-Fi only | No | Free |
| Render | Easiest online option, deploys from GitHub | Yes, automatic | Paid instance needed for the disk |
| Railway | Simple online option, deploys from GitHub | Yes, automatic | Hobby plan |
| Fly.io | Online, London region, command line | Yes, automatic | Pay as you go |
| Your own VPS with Docker | Full control, your own domain | Yes, automatic with Caddy | VPS rental |

Whichever you pick:

- **It runs as one copy.** The database is a single file (SQLite), so never scale it to more than one instance.
- **Give it a persistent disk.** Without one, every redeploy wipes the rota. All the setups below include one.
- **Set the PINs before the first start** with `MANAGER_PIN` (and `STAFF_PIN` if you want staff sign-in). If you don't, a random manager PIN is printed in the server log on first start.
- **Expect a few seconds' downtime on each redeploy.** Hosts stop the old copy before starting the new one when a disk is attached.

### Put the code on GitHub first

Render, Railway and Fly can all deploy straight from a GitHub repository. Create a private repository and upload everything in this folder except `node_modules` and `data`; the `.gitignore` file already skips them.

### Render

1. In Render, choose **New > Blueprint** and pick your repository. Render reads `render.yaml`.
2. Enter a `MANAGER_PIN` (4 to 8 digits) and, if you want, a `STAFF_PIN` when asked.
3. Deploy. Your rota is at the `onrender.com` address Render shows. You can add your own domain in the service settings.

The blueprint uses a Starter instance in Frankfurt with a 1 GB disk mounted at `/var/data`. Change `region` or `plan` in `render.yaml` if you want something else.

### Railway

1. In Railway, choose **New Project > Deploy from GitHub repo** and pick your repository. It builds with the `Dockerfile`.
2. Right-click the service and **Attach Volume**, mounted at `/data`.
3. Under **Variables**, add `TRUST_PROXY=1`, `MANAGER_PIN` and, if you want, `STAFF_PIN`.
4. Under **Settings > Networking**, choose **Generate Domain**.

### Fly.io

Install the `fly` command line tool, then in this folder:

```
fly launch --no-deploy            # keep the existing fly.toml; choose a unique app name
fly volumes create rota_data --size 1 --region lhr
fly secrets set MANAGER_PIN=482913 STAFF_PIN=5521
fly deploy
```

### Your own server (VPS) with a domain name

You need a small Linux server with Docker installed and a domain or subdomain, such as `rota.yourshop.co.uk`.

1. Point the domain's DNS A record at the server's IP address.
2. Copy this folder to the server, then `cp .env.example .env` and fill in `DOMAIN`, `MANAGER_PIN` and `STAFF_PIN`.
3. Run `docker compose up -d`.

Caddy gets an HTTPS certificate for your domain automatically. The rota data lives in the `rota-data` Docker volume.

### A PC at the shop

1. Install Node.js 20 or newer (the LTS version from nodejs.org).
2. **Windows:** double-click `start-windows.bat`. **Mac or Linux:** run `./start-mac-linux.sh`.
3. Note the manager PIN shown in the window. It's also saved in `data/FIRST-RUN-PINS.txt`; delete that file once noted.
4. On each phone, open the "On your network" address shown, such as `http://192.168.1.20:3000`.

The PC must stay on with the window open. Don't open the PC to the internet through the shop router. If you need access from outside the shop, use one of the hosted options or a tunnel such as Cloudflare Tunnel or Tailscale.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Port the server listens on |
| `HOST` | 0.0.0.0 | Use 127.0.0.1 to allow only this computer |
| `DATA_DIR` | ./data (Docker: /data) | Where the database and backups go. Must be on the persistent disk when hosted. |
| `MANAGER_PIN` | random | Manager PIN, used on first start only |
| `STAFF_PIN` | none | Staff PIN, used on first start only |
| `TRUST_PROXY` | off | Set to 1 behind a host or proxy so the PIN lockout sees each phone's own address |
| `BACKUP_KEEP` | 30 | How many daily backup files to keep |

After the first start, change PINs in the app under **Settings > Security**.

## Backups

- The server writes a backup to `DATA_DIR/backups` when it starts and every 24 hours after that, keeping the last 30.
- Before restoring a file in the app, the server saves a copy of the current rota first.
- The manager can download a backup any time from **Settings > Data on the server**.
- Backups also restore into the Claude cloud test version, and the other way round.
- Hosted disks can fail, so download a backup now and then and keep it somewhere else.

## Upgrading

Replace the code and restart. The server upgrades its database automatically, for example adding the role, contract and under-18 columns to a database from version 1. Your data folder is never touched by an upgrade.

## API

Send the token from `/api/login` as `Authorization: Bearer <token>`.

| Method | Path | Who | What |
|---|---|---|---|
| POST | /api/login `{pin}` | anyone | Returns `{token, role}` |
| POST | /api/logout | signed in | Ends this session |
| GET | /api/state | signed in | Staff, weeks, settings, notes, requests |
| GET | /api/events | signed in | Live update stream (`?token=` allowed) |
| PUT | /api/shifts/:week/:staffId/:day | manager | Body `{s,e}`, `{t:"hol"}` or `{}` for a day off. Week is the Monday date; day is 0 (Mon) to 6 (Sun) |
| POST | /api/weeks/:week/copy-previous | manager | Copy last week into this week |
| DELETE | /api/weeks/:week | manager | Clear a week |
| POST | /api/staff | manager | `{name, rate, roleId, contract, under18}` |
| PATCH | /api/staff/:id | manager | Any of `name, rate, roleId, contract, under18, active` |
| POST | /api/staff/order `{ids}` | manager | Set rota order |
| PUT | /api/notes/:day `{text}` | manager | Set or clear (empty text) a day note |
| POST | /api/requests | signed in | `{staffId, from, to, reason}` time-off request |
| PATCH | /api/requests/:id `{status}` | manager | `approved` marks the days as Holiday; also `declined`, `pending` |
| DELETE | /api/requests/:id | manager | Delete a request |
| PUT | /api/settings | manager | Store name, hours, shift types, roles, staffing rules, breaks, limits, budget, pay options |
| PUT | /api/pins `{manager}` or `{staff}` | manager | Change PINs (`staff: null` turns staff sign-in off) |
| GET | /api/activity | manager | Change log |
| GET | /api/export, POST /api/import | manager | Backup and restore |
| GET | /api/health | anyone | Health check for hosts |

## Files

```
server.js             API, database, sign-in, live updates, backups
seed.json             Starting rota loaded on first start
public/               The phone app (index.html, app.js, app.css, icons, offline worker)
render.yaml           Render Blueprint
railway.json          Railway build and health check
fly.toml              Fly.io app config
Dockerfile            Container image used by Railway, Fly and Docker Compose
docker-compose.yml    Your own server with Caddy for HTTPS (with Caddyfile and .env.example)
start-windows.bat     Start on a Windows PC
start-mac-linux.sh    Start on a Mac or Linux PC
data/                 Created on first start: rota.db and backups (keep this safe)
```
