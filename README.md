# Labs Pulse

A lightweight PIVX Labs infrastructure monitor. The backend polls configured HTTP/HTTPS services and stores bucketed snapshots on disk; the frontend renders compact uptime bars.

## Requirements

- Node.js 18 or newer
- macOS/Linux/WSL compatible shell

## Project layout

- Backend: [backend/](backend) (Express server, API, monitor)
- Frontend: [frontend/](frontend) (static UI served by backend)
- Data: [backend/data/](backend/data) (per-service, per-month JSON files)

## Install

```bash
cd backend
npm install
```

## Run

Development (auto-reload):
```bash
cd backend
npm run dev
```

Production-like:
```bash
cd backend
npm start
```

Open http://localhost:8080 in a browser.

## Minute-bucket debug mode

Use minute buckets to iterate quickly:
```bash
cd backend
PULSE_DEBUG_MINUTE_BUCKETS=1 npm run dev
```
In this mode, the monitor finalizes a snapshot every minute and the frontend auto-refreshes every 60 seconds.

## Health checks

Basic pings (Node 18 has built-in fetch):
```bash
cd backend
npm run health       # GET /api/ping
npm run health:services  # GET /api/services
npm run health:full  # GET /api/health
```

## Seed data (optional)

Populate recent buckets so the UI shows history without waiting:

```bash
cd backend
npm run seed            # hourly by default
PULSE_DEBUG_MINUTE_BUCKETS=1 npm run seed   # minute buckets
```

- Seed writes snapshots for the recent window:
  - Minute mode: 180 buckets (~3 hours)
  - Hourly mode: 48 buckets (2 days)
- Safe to run multiple times; entries are upserted by bucket.

## API quick reference

- Services: GET [/api/services](/api/services)
- Health: GET [/api/health](/api/health)
- Snapshots (example):
  ```
  /api/snapshots?service_id=pivx-org&from_utc_ms=...&to_utc_ms=...&limit=168
  ```
Responses use UTC epoch ms and field hour_utc_ms for each bucket.
Color rules:
- red when ping_ms = 0
- green when 0 < ping_ms ≤ slow_threshold_ms
- yellow when ping_ms > slow_threshold_ms

## Data files

- Stored under [backend/data/](backend/data)
- File naming: <service_id>-YYYY-MM.json
- Each file contains a compact JSON array of snapshots:
  - hour_utc_ms: UTC bucket start
  - ping_ms: 0 when down, else representative latency

## Configure services

Edit [backend/src/config/services.json](backend/src/config/services.json). Defaults:
- poll_interval_ms: 60000
- retention_days: 90
- timezone: "UTC" (labels only; storage is UTC)
- Per service: id, name, url required; timeout_ms default 5000; slow_threshold_ms default 1000; tags optional; retries default 0.

## Frontend

Served by the backend at http://localhost:8080. It loads services and snapshots and renders colored timeline cells. In minute mode the UI uses a shorter, faster-updating window.
