# ISP Ticketing System - Deployment Package

**Generated:** 2026-09-10  
**Target:** n8n host (10.227.227.35)  
**Status:** Ready to deploy

---

## 📦 Package Contents

```
/home/user/.hermes/deploy/ticketing-system/
├── .env                          # Config with generated secrets
├── SECRETS.txt                   # ⚠️ Store securely - passwords here
├── docker-compose.yml            # Stack definition
├── nginx.conf                    # Reverse proxy config
├── DATABASE_SCHEMA.sql           # PostgreSQL schema (for reference)
├── backend/
│   ├── src/app.ts                # Complete backend API
│   ├── package.json              # Node dependencies
│   └── tsconfig.json             # TypeScript config
├── frontend/
│   └── index.html                # Complete web UI
├── deploy.sh                     # One-command deploy script
└── MANUAL_DEPLOY.md              # Step-by-step instructions
```

---

## 🔐 Generated Secrets

| Secret | Value |
|--------|-------|
| DB_PASSWORD | `DdGWEDo6vpp3...` (see SECRETS.txt) |
| REDIS_PASSWORD | `mlzeM0c3J-XN...` (see SECRETS.txt) |
| JWT_SECRET | `V4rpiRU8stKH...` (see SECRETS.txt) |
| JWT_REFRESH_SECRET | `9B7pH1Zdq-GNHL...` (see SECRETS.txt) |

⚠️ **Store SECRETS.txt securely** — contains plaintext passwords.

---

## 🚀 Quick Deploy

### Option A: Automated Script

```bash
# From Hermes host:
cd /home/user/.hermes/deploy
bash ticketing-system/deploy.sh
```

### Option B: Manual Steps

```bash
# 1. Upload to n8n host
scp -r /home/user/.hermes/deploy/ticketing-system \
       user@10.227.227.35:/home/user/

# 2. SSH to n8n host
ssh user@10.227.227.35

# 3. Deploy
cd ~/ticketing-system
docker compose up -d

# 4. Verify
sleep 15
curl http://localhost:9001/health
```

---

## 🌐 Access Points

| Service | URL |
|---------|-----|
| Frontend | http://10.227.227.35:9000 |
| Backend API | http://10.227.227.35:9001 |
| Health Check | http://10.227.227.35:9001/health |
| WebSocket | ws://10.227.227.35:3001 (internal) |

---

## 📊 System Architecture

```
┌─────────────────────────────────────────┐
│  n8n Host: 10.227.227.35               │
│                                         │
│  ┌──────────────┐    ┌───────────────┐ │
│  │  Nginx       │    │  Frontend     │ │
│  │  :80         │◄──►│  :3000        │ │
│  └──────┬───────┘    └───────┬───────┘ │
│         │                    │          │
│         │    ┌───────────────▼───────┐  │
│         │    │  Backend (Node.js)    │  │
│         │    │  :3001                │  │
│         │    └───────┬───────────────┘  │
│         │            │                  │
│  ┌──────▼──────┐ ┌───▼───────────┐    │
│  │  PostgreSQL │ │    Redis      │    │
│  │  :5432      │ │  :6379        │    │
│  └─────────────┘ └───────────────┘    │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  n8n (existing) :5678            │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## 🔌 Integration with Existing Stack

### n8n Webhook Connection
- Ticket creation webhook: `POST http://10.227.227.35:3001/api/v1/tickets`
- Dashboard metrics: `GET http://10.227.227.35:3001/api/v1/analytics/dashboard`
- Authenticate with Bearer token from login response

### Alert Routing (via Pulse/n8n)
- Configure critical ticket alerts → n8n webhook router (`wf wnOdDn8hjeJj7JPA`)
- Route to Telegram/email as needed

---

## 🛡️ Security Notes

1. **Production hardening:**
   - Enable HTTPS (generate certs or use Let's Encrypt)
   - Restrict access via firewall
   - Change default admin credentials after first login

2. **Backup strategy:**
   - PostgreSQL volume: `./data/postgres`
   - Redis volume: `./data/redis`
   - Set up daily backups to SFTP (configured in .env)

3. **Monitoring:**
   - Add Wazuh agent for container monitoring
   - Docker health checks enabled for all services

---

## 📋 API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/v1/auth/register | No | Register new user |
| POST | /api/v1/auth/login | No | Login (returns JWT) |
| GET | /api/v1/users | Yes | List all users |
| POST | /api/v1/customers | Yes | Create customer |
| GET | /api/v1/customers | Yes | List customers |
| POST | /api/v1/tickets | Yes | Create ticket |
| GET | /api/v1/tickets | Yes | List tickets |
| GET | /api/v1/tickets/:id | Yes | Get ticket details |
| PUT | /api/v1/tickets/:id | Yes | Update ticket |
| PATCH | /api/v1/tickets/:id/assign | Yes | Assign ticket |
| POST | /api/v1/tickets/:id/comments | Yes | Add comment |
| GET | /api/v1/analytics/dashboard | Yes | Dashboard metrics |
| GET | /health | No | Health check |

---

## ⚠️ Known Limitations

1. **In-Memory Database**: Backend uses in-memory storage (resets on restart). For production with persistence:
   - Run migrations from `DATABASE_SCHEMA.sql`
   - Update backend to connect to PostgreSQL directly

2. **Email Not Configured**: SMTP settings need to be added to `.env`

3. **No SSL by Default**: Use nginx reverse proxy with certbot for HTTPS

---

## 🔧 Next Steps

1. ✅ Package ready for deploy
2. ⏳ Deploy to n8n host (run deploy.sh or manual steps above)
3. ⏳ First login and create admin user
4. ⏳ Configure SMTP for email notifications
5. ⏳ Integrate with n8n workflow for alert routing
6. ⏳ Set up Wazuh monitoring
7. ⏳ Configure automated backups

---

## 🆘 Troubleshooting

```bash
# Check container status
docker compose ps

# View logs
docker compose logs -f backend

# Restart services
docker compose restart

# Full reset
docker compose down && docker compose up -d
```
