# Deadline Crush

A hackathon project-submission system built to survive the last 10 minutes: 2,000 teams, files up to
100 MB, nothing lost, and a deadline the server (not the browser) decides.

Built for the Hack4Hack Crew Hiring Challenge 2026, problem statement 2.

| | |
|---|---|
| **Live URL** | https://deadline-crush.vercel.app (API: https://deadline-crush-api.onrender.com, first request after idle takes ~50 s on the free tier) |
| **Design doc** | [docs/DESIGN.md](docs/DESIGN.md) (1 page) |
| **Load-test report** | [docs/LOAD-TEST.md](docs/LOAD-TEST.md) |

## What it does

- **Direct-to-storage uploads.** Files go to S3-compatible storage (MinIO locally, Cloudflare R2 in
  production) in resumable 8 MB parts through short-lived presigned URLs. The API only handles JSON.
- **Server-enforced deadline** with a written grace policy. Every edit is a new version; all versions are
  kept; the last one created before the deadline counts.
- **Background checks** in a job queue: file type read from the bytes, zip-bomb and oversized-archive
  rejection, link checks (with an SSRF guard), and a preview (first PDF page or the zip's README).
- **Exactly-once results.** A worker killed mid-job is retried with no duplicate result (tested with a real
  `SIGKILL`).
- **Live status** (uploading, queued, checking, accepted, needs fix) over server-sent events, no refresh.
- **Organizer dashboard** with live counts, late attempts, failed checks, and CSV export.

## Stack

React + TypeScript (Vite) · Node.js + Express · MongoDB · BullMQ on Redis · S3-compatible storage
(`@aws-sdk/client-s3`) · Vitest + Supertest · k6 · GitHub Actions.

```
 browser ──JSON──▶ API (Express) ──▶ MongoDB
    │                 │  └──▶ Redis (BullMQ queue, pub/sub)
    │                 └─ presigned URLs                ▲
    └────── file parts (PUT) ──▶ object storage        │
                                   ▲                    │
                       Worker(s) ──┴── checks, previews ┘
                          └─ status events ─▶ Redis ─▶ API ─▶ SSE ─▶ browser
```

## Run it

### One command (Docker)

```bash
docker compose up --build
```

Web <http://localhost:5173> · API <http://localhost:4000> · MinIO console <http://localhost:9001>
(`minioadmin` / `minioadmin`). Two worker replicas start by default.

Create an organizer account (the organizer role cannot be self-registered):

```bash
docker compose exec api npx tsx src/scripts/create-organizer.ts organizer@example.com 'a-strong-password'
```

### Without Docker

You need MongoDB, Redis and an S3-compatible server. For storage, `npm run dev:s3` starts a small local one.

```bash
cd server && npm ci
npm run dev:s3 &      # local S3 on :9000
npm run dev:api &     # API on :4000
npm run dev:worker &  # worker
cd ../web && npm ci && npm run dev   # UI on :5173
```

Configuration is by environment variable; see [`server/.env.example`](server/.env.example). The deadline
and grace period can be changed by an organizer at runtime (`PUT /organizer/settings`).

## Tests

```bash
cd server && npm test        # needs Mongo, Redis and the local S3 server running
```

The suite runs in GitHub Actions on every push ([`ci.yml`](.github/workflows/ci.yml)). It covers
authentication, access control between teams, the deadline and grace policy (including the exact boundary
instant), resumable multipart uploads, every background check, live status over SSE, the organizer
endpoints, and exactly-once processing, including killing a worker process mid-job.

## Browser end-to-end test

`e2e/` drives the real UI in headless Chromium against a running stack: register with the keyboard, upload a
20 MB file in parts and watch the status change without a reload, a rejected file, resume after a page reload,
the closed-deadline state, the organizer dashboard and CSV export, and no horizontal scroll at phone width.

```bash
cd e2e && npm i && npx playwright install chromium && node run.mjs
```

## Deploy (free tiers)

| Part | Where | Notes |
|---|---|---|
| Web | Vercel (root `web`, env `VITE_API_URL`) | static build |
| API + worker | Render free web service ([`render.yaml`](render.yaml)) | `EMBED_WORKER=true` runs the queue worker in the same process |
| Database | MongoDB Atlas M0 | |
| Queue | Upstash Redis | use the `rediss://` URL |
| Files | Cloudflare R2 | `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, region `auto` |

On boot the API creates the bucket if missing and applies a CORS rule (exposing `ETag`) so browsers can upload
parts directly. Create the organizer with `npm run create-organizer -- <email> <password>` against the
production `MONGO_URL`. Render's free tier sleeps after idle time, so open the site before the event starts; the
sweeper re-enqueues any job interrupted by a sleep.

## Load test

```bash
cd server && npx tsx src/scripts/seed.ts --teams 2000 --out ../loadtest
k6 run --log-format raw --console-output=loadtest/results/ledger.log loadtest/submit.js
cd server && npx tsx src/scripts/reconcile.ts ../loadtest/results/ledger.log
```

See [docs/LOAD-TEST.md](docs/LOAD-TEST.md) for the method, results, and caveats.

## API summary

| Method and path | Purpose |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `GET /me` | Accounts; `/me` also returns the deadline and server time |
| `POST /versions` | New version; with `file`, opens a multipart upload; without, carries the previous file forward |
| `GET /versions`, `GET /versions/:id` | List versions (and which one counts); one version with check results |
| `GET /versions/:id/upload` | Resume state: which parts are stored, which are missing |
| `POST /versions/:id/upload/parts` | Presigned PUT URLs for the requested parts |
| `PUT /versions/:id/upload/parts/:n` | Acknowledge a part (its ETag) |
| `POST /versions/:id/upload/complete` | Finish the upload and enqueue the checks (idempotent) |
| `GET /versions/:id/download` | Short-lived download URL for the file and its preview |
| `GET /events` | Server-sent events: live status for your team |
| `GET /organizer/stats`, `/organizer/events`, `/organizer/export.csv`, `PUT /organizer/settings` | Organizer only |
