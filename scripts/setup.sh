#!/usr/bin/env sh
set -eu

project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
secret_dir="$project_root/secrets"

node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$node_major" -lt 24 ]; then
  echo "Node.js 24 LTS or newer is required." >&2
  exit 1
fi

mkdir -p "$secret_dir"
chmod 700 "$secret_dir"
ensure_secret() {
  path="$secret_dir/$1"
  bytes="${2:-32}"
  if [ ! -f "$path" ]; then
    openssl rand -base64 "$bytes" | tr '+/' '-_' | tr -d '=\n' > "$path"
    chmod 600 "$path"
  fi
}

ensure_secret postgres-password.txt
ensure_secret redis-password.txt
ensure_secret app-encryption.key 48
ensure_secret cookie-secret.txt 48
ensure_secret bitcoin-rpc-password.txt
ensure_secret bitcoin-wallet-passphrase.txt 48
ensure_secret monero-rpc-password.txt
ensure_secret monero-wallet-passphrase.txt 48
ensure_secret grafana-admin-password.txt

if [ ! -f "$project_root/.env" ]; then
  postgres_password="$(cat "$secret_dir/postgres-password.txt")"
  redis_password="$(cat "$secret_dir/redis-password.txt")"
  sed \
    -e "s/mining_dev_password/$postgres_password/g" \
    -e "s/redis_dev_password/$redis_password/g" \
    "$project_root/.env.example" > "$project_root/.env"
  chmod 600 "$project_root/.env"
fi
if [ ! -f "$project_root/.env.infrastructure" ]; then
  cp "$project_root/.env.infrastructure.example" "$project_root/.env.infrastructure"
  chmod 600 "$project_root/.env.infrastructure"
fi

cd "$project_root"
pnpm install --frozen-lockfile
pnpm db:generate

echo "Setup complete. Secrets were created once and were not printed."
echo "Next: docker compose --env-file .env.infrastructure --profile core up -d && pnpm db:deploy"
