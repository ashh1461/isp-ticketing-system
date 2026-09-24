# ISP Ticketing System

Full-stack ticketing platform for Techrise ISP operations. Deployed in production at **10.227.227.35** (n8n host).

- **Backend** — Node 18 + TypeScript + Express, Postgres 15, Redis 7
- **Frontend** — Single-page static app served by nginx
- **Auth** — JWT (15 min access token) with role-based access control

## Architecture

```
┌──────────────┐      ┌────────────────┐      ┌────────────┐      ┌───────────┐
│  Browser     │─────▶│ nginx :9000     │      │ backend    │─────▶│ postgres  │
│ (index.html) │      │ (static + proxy)│─────▶│ node :3001 │      │  :5432    │
└──────────────┘      └────────────────┘      │ (host :9001)│      └───────────┘
                                              └────────────┘           ▲
                                                     │                  │
                                                     ▼                  │
                                              ┌────────────┐           │
                                              │ redis :6379│───────────┘
                                              └────────────┘
```

Containers: `ticketing-frontend` (nginx, host `:9000`), `ticketing-backend` (node, host `:9001`), `ticketing-postgres`, `ticketing-redis`.

## Repository layout

```
├── backend/
│   ├── src/app.ts          # Express app: auth, RBAC, all routes
│   ├── src/db.ts           # Postgres pool + query helpers
│   ├── tests/api.test.ts   # 43 contract tests (vitest)
│   └── dist/               # Compiled output (built, not committed)
├── frontend/index.html     # The entire SPA
├── nginx.conf              # Static serve + /api proxy to backend
├── DATABASE_SCHEMA.sql     # 39 tables: tickets, customers, SLA, incidents...
├── docker-compose.yml      # 4 services
├── deploy.sh               # One-shot prod deploy to 10.227.227.35
├── rebuild.sh              # Rebuild backend + restart containers in place
├── DEPLOYMENT.md           # Step-by-step deployment runbook
└── MANUAL_DEPLOY.md        # Manual procedures (rebuild, rollback, DB ops)
```

## Quick start (local dev)

```bash
# 1. Backend dependencies
cd backend && npm install

# 2. Postgres + Redis
docker compose up -d postgres redis

# 3. Schema
docker exec -i ticketing-postgres psql -U ticketing_user -d isp_ticketing < ../DATABASE_SCHEMA.sql

# 4. Env — required variables (generate your own, don't reuse production)
export JWT_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export DB_PASSWORD=$(openssl rand -hex 16)
export REDIS_PASSWORD=$(openssl rand -hex 16)

# 5. Build + run
npm run build && npm run start     # :3001
```

Frontend: serve `frontend/index.html` from any static server pointing `/api` at `:3001`.

## Tests

```bash
cd backend
JWT_SECRET=test-secret-for-vitest-1234567890abcdef \
DB_PASSWORD=test DB_NAME=isp_ticketing DB_USER=ticketing_user \
npx vitest run
# → Test Files 1 passed (1), Tests 43 passed (43)
```

`JWT_SECRET` must be set or `src/app.ts` hard-fails at import time by design — that is a
production guard, not a test bug. If the suite reports 0 tests, the import died on a missing
env var; set them and re-run.

## Deploying to production

```bash
./deploy.sh      # syncs files to 10.227.227.35, rebuilds, restarts
./rebuild.sh     # rebuild backend image + restart containers in place
```

**Topology note — the frontend is a bind-mount, not a build step.** `ticketing-frontend` runs
`nginx:alpine` with `frontend/index.html` mounted read-only. A frontend change therefore needs
**no image rebuild**: sync the file and `docker restart ticketing-frontend`. A backend change
needs a rebuild (`rebuild.sh`) or `docker restart ticketing-backend` if only `dist/` changed.

### Live verification after any auth change

```bash
# health
curl -s http://10.227.227.35:9001/health

# forged token must return 401, not 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer fake' \
     http://10.227.227.35:9001/api/v1/auth/me     # → 401

# real login
curl -s -X POST http://10.227.227.35:9001/api/v1/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@isp.local","password":"..."}'
```

## Auth contract

| Condition | Status | Behaviour |
|---|---|---|
| Invalid / expired token | **401** | Frontend logs out, shows login page |
| Valid token, insufficient role | **403** | Request denied, session preserved |

This distinction matters. Before commit `63d1510` authentication failures returned `403`, the
frontend only logged out on `401`, and a stale token left users on a blank page with no login
prompt. The frontend now treats **both** 401 and 403 as session-invalidating for the current
user, and `init()` validates the stored token server-side before rendering.

## First-boot admin

The initial admin account is seeded on first start (`src/app.ts`):

- Email: `admin@isp.local`
- Password: auto-generated, printed **once** to the backend container logs at seed time.
  It is not in `.env`; `ADMIN_EMAIL` / `ADMIN_DEFAULT_PASSWORD` are unset by default.

```bash
docker logs ticketing-backend 2>&1 | grep -i 'admin'
```

Rotate it after first login — the value is a generated secret that has been in container logs.

## Data model highlights

39 tables in `DATABASE_SCHEMA.sql`, including: `users`, `roles`, `permissions`, `customers`,
`customer_contacts`, `tickets`, `ticket_comments`, `ticket_assignments`, `ticket_attachments`,
`sla_policies`, `escalation_rules`, `incidents`, `problems`, audit via `audit_log`,
`kb_articles`, `canned_responses`, `notifications`, `oncall_rotations`, `automation_rules`,
`backup_log`.

## Secrets

`SECRETS.txt` documents every required variable and where each one lives in production
(`.env` on the host, injected into containers at compose-up). Never commit real values —
`.gitignore` covers `.env`, `data/`, and `backend/dist`.

## Ticketing

Tracked in Linear: `ALI-16` (deployment), `ALI-17` (GitHub push).
