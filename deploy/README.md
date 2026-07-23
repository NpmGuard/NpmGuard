# Deploy

Reusable modules, composable per platform. Nothing here knows where
production runs.

| Module | What it is |
|---|---|
| `systemd/npmguard.service` | Engine unit: Alembic migrate, then uvicorn on `127.0.0.1:8000`. Assumes repo at `/root/NpmGuard`; adjust paths if elsewhere. |
| `nginx/npmguard.conf` | Reverse proxy: SSE unbuffered, audit/checkout rate-limited, Stripe webhook passthrough. Ships on `:80`; add TLS per your platform. |
| `nginx/rate-limit.conf` | The two `limit_req` zones the site config uses. |
| `setup-ubuntu.sh` | Idempotent provisioner for a generic Ubuntu host: packages, Node 22, uv, UFW, fail2ban, nginx, Docker sandbox image, app build, systemd install. |

## Generic Ubuntu playbook

```bash
# 1. Get the code onto the host
scp -r . root@<host>:/root/NpmGuard

# 2. Provision (idempotent; SKIP_CERTBOT=1 if TLS is terminated elsewhere)
ssh root@<host> /root/NpmGuard/deploy/setup-ubuntu.sh

# 3. Configure
vi /root/NpmGuard/engine/.env        # from engine/.env.template

# 4. Start
systemctl start npmguard
curl -fsS localhost:8000/health
```

## Redeploy (manual)

```bash
# On the host, from /root/NpmGuard, after updating the code:
(cd engine && uv sync --frozen && uv run alembic upgrade head)
npm run build:shared && npm --prefix frontend run build
systemctl restart npmguard
curl -fsS localhost:8000/health
```

Deploys are deliberately manual — there is no auto-deploy pipeline.
Snapshot the host's working tree before replacing it if it may have been
hand-edited.
