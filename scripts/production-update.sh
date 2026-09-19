#!/usr/bin/env bash
set -Eeuo pipefail
. /etc/mining-gateway/deploy.env
cd "${PROJECT_ROOT:-/opt/mining-gateway}"
sudo -u "${SERVICE_USER:-mining-gateway}" git diff --quiet
sudo -u "${SERVICE_USER:-mining-gateway}" git diff --cached --quiet
sudo -u "${SERVICE_USER:-mining-gateway}" git fetch --prune origin
sudo -u "${SERVICE_USER:-mining-gateway}" git pull --ff-only
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm install --frozen-lockfile
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm audit --prod --audit-level high
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm format:check
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm lint
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm typecheck
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm test
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm db:validate
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm --filter @mitm/server config:validate:production
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm build
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup config --quiet
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup run --rm -e BACKUP_INTERVAL_SECONDS=0 postgres-backup
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup pull --ignore-buildable
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup build --pull
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup up -d --remove-orphans
systemctl stop mining-gateway.service
sudo -u "${SERVICE_USER:-mining-gateway}" pnpm db:deploy
systemctl restart mining-gateway.service
nginx -t
systemctl reload nginx
PREFLIGHT_APP_USER="${SERVICE_USER:-mining-gateway}" BASE_URL="https://${PANEL_DOMAIN}" STRATUM_HOST="$MINING_DOMAIN" STRATUM_PORT="${BITCOIN_TLS_PORT:-3334}" COMPOSE_OVERLAY_FILE=compose.nginx.yaml SKIP_QUALITY=true bash scripts/preflight-production.sh
