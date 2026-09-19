#!/usr/bin/env bash
set -uo pipefail

project_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_root" || exit

base_url="${BASE_URL:-https://panel.partie.ir}"
stratum_host="${STRATUM_HOST:-btc.partie.ir}"
stratum_port="${STRATUM_PORT:-3334}"
skip_quality="${SKIP_QUALITY:-false}"
skip_live="${SKIP_LIVE:-false}"
app_user="${PREFLIGHT_APP_USER:-}"
compose_overlay="${COMPOSE_OVERLAY_FILE:-compose.production.yaml}"
failures=()

check() {
  local name="$1"
  shift
  if "$@"; then
    printf '\033[32m[PASS]\033[0m %s\n' "$name"
  else
    local code=$?
    failures+=("$name (exit $code)")
    printf '\033[31m[FAIL]\033[0m %s (exit %s)\n' "$name" "$code" >&2
  fi
}

run_app() {
  if [ -n "$app_user" ] && [ "$(id -u)" -eq 0 ]; then
    runuser -u "$app_user" -- "$@"
  else
    "$@"
  fi
}

node_24() {
  local major
  major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ -n "$major" ] && [ "$major" -ge 24 ]
}

safe_tls_environment() {
  [ "${NODE_TLS_REJECT_UNAUTHORIZED:-}" != "0" ]
}

no_tracked_secrets() {
  [ ! -d .git ] && return 0
  local tracked
  tracked="$(git ls-files -- .env .env.infrastructure 'secrets/*' 'backups/*' '*.log' | grep -Fvx 'secrets/.gitkeep' || true)"
  if [ -n "$tracked" ]; then
    printf 'Tracked sensitive files:\n%s\n' "$tracked" >&2
    return 1
  fi
}

required_configuration() {
  local required=(
    .env .env.infrastructure
    secrets/app-encryption.key secrets/cookie-secret.txt
    secrets/postgres-password.txt secrets/redis-password.txt
    secrets/bitcoin-rpc-password.txt secrets/bitcoin-wallet-passphrase.txt
    secrets/monero-rpc-password.txt secrets/monero-wallet-passphrase.txt
    secrets/grafana-admin-password.txt
    secrets/stratum-tls-cert.pem secrets/stratum-tls-key.pem
  )
  local path
  for path in "${required[@]}"; do
    [ -s "$path" ] || { printf 'Missing or empty: %s\n' "$path" >&2; return 1; }
  done
  grep -Eq '^BACKUP_AGE_RECIPIENT=age1[0-9a-z]+$' .env.infrastructure || {
    printf 'BACKUP_AGE_RECIPIENT must contain an age public recipient.\n' >&2
    return 1
  }
  [ ! -e secrets/backup-age-identity.txt ] || {
    printf 'The private age identity must not be stored on the production server.\n' >&2
    return 1
  }
  if [ -e INITIAL_WALLET_SEED.txt ] || [ -e secrets/INITIAL_WALLET_SEED.txt ]; then
    printf 'A plaintext Monero seed remains on the production server.\n' >&2
    return 1
  fi
}

restricted_secret_permissions() {
  local mode path
  while IFS= read -r path; do
    mode="$(stat -c '%a' "$path")"
    case "$mode" in
      400|440|600|640) ;;
      *) printf 'Unsafe permissions %s on %s\n' "$mode" "$path" >&2; return 1 ;;
    esac
  done < <(find secrets -maxdepth 1 -type f ! -name .gitkeep -print)
}

production_policy() {
  run_app pnpm --filter @mitm/server config:validate:production || return
  local expected configured
  expected="$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$base_url")" || return
  configured="$(sed -n 's/^ADMIN_ORIGIN=//p' .env | tail -n 1)"
  printf '%s' "$configured" | tr ',' '\n' | sed 's:/*$::' | grep -Fxq "$expected"
}

certificate_validity() {
  openssl x509 -in secrets/stratum-tls-cert.pem -noout -checkend 1209600 >/dev/null || return
  local cert_key_hash private_key_hash
  cert_key_hash="$(openssl x509 -in secrets/stratum-tls-cert.pem -pubkey -noout | openssl pkey -pubin -outform der | sha256sum | cut -d' ' -f1)" || return
  private_key_hash="$(openssl pkey -in secrets/stratum-tls-key.pem -pubout -outform der | sha256sum | cut -d' ' -f1)" || return
  [ "$cert_key_hash" = "$private_key_hash" ]
}

compose_configuration() {
  docker compose -f compose.yaml -f "$compose_overlay" \
    --env-file .env.infrastructure \
    --profile core --profile bitcoin --profile monero \
    --profile observability --profile backup config --quiet
}

live_readiness() {
  local host port
  host="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$base_url")" || return
  port="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.port||"443")' "$base_url")" || return
  curl --noproxy '*' --resolve "$host:$port:127.0.0.1" --fail --silent --show-error "$base_url/health/ready" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.status!=="ok")process.exit(1)})'
}

public_portal() {
  local host port
  host="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$base_url")" || return
  port="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.port||"443")' "$base_url")" || return
  curl --noproxy '*' --resolve "$host:$port:127.0.0.1" --fail --silent --show-error "$base_url/portal" |
    grep -Fq '<div id="root"></div>'
}

trusted_stratum_tls() {
  openssl s_client -connect "${stratum_host}:${stratum_port}" \
    -servername "$stratum_host" -verify_hostname "$stratum_host" \
    -verify_return_error </dev/null 2>/dev/null | grep -Fq 'Verify return code: 0 (ok)'
}

check 'Node.js 24+' node_24
check 'TLS validation environment' safe_tls_environment
check 'No sensitive files tracked by Git' no_tracked_secrets
check 'Configuration, secrets and backup recipient' required_configuration
check 'Secret file permissions' restricted_secret_permissions
check 'Production configuration policy and admin origin' production_policy
check 'TLS certificate, key match and 14-day validity' certificate_validity
check 'Docker engine' docker info
check 'Production Compose configuration' compose_configuration

if [ "$skip_quality" != "true" ]; then
  check 'Frozen dependency install' run_app pnpm install --frozen-lockfile
  check 'Production dependency audit' run_app pnpm audit --prod --audit-level high
  check 'Formatting' run_app pnpm format:check
  check 'Lint' run_app pnpm lint
  check 'TypeScript' run_app pnpm typecheck
  check 'Server tests and coverage' run_app pnpm --filter @mitm/server test:coverage
  check 'Admin tests' run_app pnpm --filter @mitm/admin test
  check 'Shared tests' run_app pnpm --filter @mitm/shared test
  check 'Production build' run_app pnpm build
fi

if [ "$skip_live" != "true" ]; then
  check 'Wallets and real upstream protocol authentication' run_app pnpm --filter @mitm/server self-test:operational
  check 'API readiness' live_readiness
  check 'Public customer portal' public_portal
  check 'Trusted Stratum TLS hostname handshake' trusted_stratum_tls
fi

if [ "${#failures[@]}" -gt 0 ]; then
  printf '\nProduction preflight failed (%s checks):\n' "${#failures[@]}" >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi

printf '\nProduction preflight passed.\n'
