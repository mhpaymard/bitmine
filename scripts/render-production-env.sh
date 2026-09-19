#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo 'Run this script as root.' >&2
	exit 1
fi

: "${PANEL_DOMAIN:?PANEL_DOMAIN is required}"
: "${MINING_DOMAIN:?MINING_DOMAIN is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"

project_root="${PROJECT_ROOT:-/opt/mining-gateway}"
service_user="${SERVICE_USER:-mining-gateway}"
web_bind_ip="${WEB_BIND_IP:-0.0.0.0}"
bitcoin_bind_ip="${BITCOIN_BIND_IP:-0.0.0.0}"
bitcoin_tls_port="${BITCOIN_TLS_PORT:-3334}"
monero_bind_ip="${MONERO_BIND_IP:-0.0.0.0}"
monero_tls_port="${MONERO_TLS_PORT:-4443}"

case "$PANEL_DOMAIN" in
	*[!A-Za-z0-9.-]*|'') echo 'Invalid PANEL_DOMAIN.' >&2; exit 1 ;;
esac
case "$MINING_DOMAIN" in
	*[!A-Za-z0-9.-]*|'') echo 'Invalid MINING_DOMAIN.' >&2; exit 1 ;;
esac
printf '%s' "$BACKUP_AGE_RECIPIENT" | grep -Eq '^age1[0-9a-z]{20,}$' || {
	echo 'BACKUP_AGE_RECIPIENT must be an age public recipient.' >&2
	exit 1
}
case "$bitcoin_tls_port:$monero_tls_port" in
	*[!0-9:]*) echo 'TLS ports must be numeric.' >&2; exit 1 ;;
esac
if [ "$bitcoin_tls_port" -lt 1 ] || [ "$bitcoin_tls_port" -gt 65535 ] || \
	[ "$monero_tls_port" -lt 1 ] || [ "$monero_tls_port" -gt 65535 ]; then
	echo 'TLS ports must be between 1 and 65535.' >&2
	exit 1
fi
if [ "$bitcoin_tls_port" = 443 ] && {
	[ "$web_bind_ip" = "0.0.0.0" ] || [ "$bitcoin_bind_ip" = "0.0.0.0" ] || [ "$web_bind_ip" = "$bitcoin_bind_ip" ];
}; then
	echo 'Nginx HTTPS and Bitcoin TLS cannot share port 443 on an overlapping IP.' >&2
	exit 1
fi

for required in \
	postgres-password.txt redis-password.txt app-encryption.key cookie-secret.txt \
	bitcoin-rpc-password.txt bitcoin-wallet-passphrase.txt monero-rpc-password.txt \
	monero-wallet-passphrase.txt grafana-admin-password.txt; do
	test -s "$project_root/secrets/$required" || {
		echo "Missing secret: $project_root/secrets/$required" >&2
		exit 1
	}
done

postgres_password="$(<"$project_root/secrets/postgres-password.txt")"
redis_password="$(<"$project_root/secrets/redis-password.txt")"
env_tmp="$(mktemp "$project_root/.env.tmp.XXXXXX")"
infra_tmp="$(mktemp "$project_root/.env.infrastructure.tmp.XXXXXX")"
cleanup() {
	rm -f "$env_tmp" "$infra_tmp"
}
trap cleanup EXIT HUP INT TERM
umask 077

cat >"$env_tmp" <<EOF
NODE_ENV=production
HTTP_HOST=127.0.0.1
HTTP_PORT=3000
ADMIN_ORIGIN=https://${PANEL_DOMAIN}
TRUST_PROXY=127.0.0.1,::1
ALLOW_PUBLIC_HTTP_API_IN_PRODUCTION=false
DATABASE_URL=postgresql://mining:${postgres_password}@127.0.0.1:5432/mining_gateway?schema=public
REDIS_URL=redis://:${redis_password}@127.0.0.1:6379/0
APP_ENCRYPTION_KEY_FILE=../../secrets/app-encryption.key
COOKIE_SECRET_FILE=../../secrets/cookie-secret.txt
GATEWAY_ENABLED=true
ALLOW_PLAINTEXT_GATEWAY_IN_PRODUCTION=false
BITCOIN_GATEWAY_TCP_ENABLED=false
BITCOIN_GATEWAY_HOST=0.0.0.0
BITCOIN_GATEWAY_PORT=3333
BITCOIN_GATEWAY_TLS_ENABLED=true
BITCOIN_GATEWAY_TLS_HOST=${bitcoin_bind_ip}
BITCOIN_GATEWAY_TLS_PORT=${bitcoin_tls_port}
BITCOIN_GATEWAY_TLS_CERT_FILE=../../secrets/stratum-tls-cert.pem
BITCOIN_GATEWAY_TLS_KEY_FILE=../../secrets/stratum-tls-key.pem
MONERO_GATEWAY_TCP_ENABLED=false
MONERO_GATEWAY_HOST=0.0.0.0
MONERO_GATEWAY_PORT=4444
MONERO_GATEWAY_TLS_ENABLED=true
MONERO_GATEWAY_TLS_HOST=${monero_bind_ip}
MONERO_GATEWAY_TLS_PORT=${monero_tls_port}
MONERO_GATEWAY_TLS_CERT_FILE=../../secrets/stratum-tls-cert.pem
MONERO_GATEWAY_TLS_KEY_FILE=../../secrets/stratum-tls-key.pem
GATEWAY_MAX_CONNECTIONS=500
GATEWAY_MAX_CONNECTIONS_PER_IP=100
GATEWAY_MAX_UNAUTHENTICATED_PER_IP=10
GATEWAY_AUTH_TIMEOUT_MS=15000
GATEWAY_MAX_LINE_BYTES=65536
GATEWAY_IDLE_TIMEOUT_MS=180000
RAW_SHARE_RETENTION_DAYS=14
PAYOUT_TIMEZONE=Asia/Tehran
ENABLE_MAINNET_PAYOUTS=false
BITCOIN_NETWORK=mainnet
BITCOIN_RPC_URL=http://127.0.0.1:18443
BITCOIN_RPC_USER=miningrpc
BITCOIN_RPC_PASSWORD_FILE=../../secrets/bitcoin-rpc-password.txt
BITCOIN_WALLET_NAME=mining-gateway
BITCOIN_WALLET_PASSPHRASE_FILE=../../secrets/bitcoin-wallet-passphrase.txt
BITCOIN_CONFIRMATIONS=6
BITCOIN_MIN_PAYOUT_ATOMIC=50000
BITCOIN_DAILY_AUTO_LIMIT_ATOMIC=0
MONERO_NETWORK=mainnet
MONERO_WALLET_RPC_URL=http://127.0.0.1:38088/json_rpc
MONERO_WALLET_RPC_USER=miningrpc
MONERO_WALLET_RPC_PASSWORD_FILE=../../secrets/monero-rpc-password.txt
MONERO_WALLET_PASSPHRASE_FILE=../../secrets/monero-wallet-passphrase.txt
MONERO_CONFIRMATIONS=10
MONERO_MIN_PAYOUT_ATOMIC=10000000000
MONERO_DAILY_AUTO_LIMIT_ATOMIC=0
LOG_LEVEL=info
SERVE_ADMIN_STATIC=true
EOF

cat >"$infra_tmp" <<EOF
GATEWAY_DOMAIN=${PANEL_DOMAIN}
ADMIN_UPSTREAM=host.docker.internal:3000
ADMIN_ALLOWLIST=127.0.0.1/32
ADMIN_BIND_IP=127.0.0.1
ADMIN_HTTP_PORT=8080
ADMIN_HTTPS_PORT=8443
POSTGRES_HOST_PORT=5432
BITCOIN_CHAIN=mainnet
BITCOIN_RPC_PORT=18443
BITCOIN_WALLET_NAME=mining-gateway
BITCOIN_PRUNE_MIB=100000
MONERO_NETWORK=mainnet
MONERO_BOOTSTRAP_WALLET=false
MONERO_WALLET_RESTORE_HEIGHT=0
BACKUP_AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT}
BACKUP_INTERVAL_SECONDS=21600
BACKUP_RETENTION_DAYS=30
EOF

install -o "$service_user" -g "$service_user" -m 0600 "$env_tmp" "$project_root/.env"
install -o "$service_user" -g "$service_user" -m 0600 "$infra_tmp" "$project_root/.env.infrastructure"
