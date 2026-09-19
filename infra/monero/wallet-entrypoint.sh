#!/bin/sh
set -eu

wallet_name="${MONERO_WALLET_NAME:-mining-gateway}"
wallet_path="/wallet/$wallet_name"
wallet_password_file=/run/secrets/monero_wallet_passphrase
rpc_password="$(cat /run/secrets/monero_rpc_password)"
rpc_user="${MONERO_RPC_USER:-miningrpc}"
rpc_config=/tmp/monero-wallet-rpc.conf

case "${MONERO_NETWORK:-stagenet}" in
  mainnet) network_flag="" ;;
  stagenet) network_flag="--stagenet" ;;
  testnet) network_flag="--testnet" ;;
  *) echo "Unsupported MONERO_NETWORK" >&2; exit 1 ;;
esac

mkdir -p /wallet
chown -R monero:monero /wallet
umask 077
printf 'rpc-login=%s:%s\n' "$rpc_user" "$rpc_password" > "$rpc_config"
chown monero:monero "$rpc_config"
unset rpc_password
if [ ! -f "$wallet_path" ]; then
  if [ "${MONERO_BOOTSTRAP_WALLET:-false}" != "true" ]; then
    echo "Monero wallet is missing. Set MONERO_BOOTSTRAP_WALLET=true once, then secure its seed file." >&2
    exit 1
  fi
  umask 077
  gosu monero monero-wallet-cli $network_flag \
    --generate-new-wallet "$wallet_path" \
    --restore-height "${MONERO_WALLET_RESTORE_HEIGHT:-0}" \
    --password-file "$wallet_password_file" \
    --mnemonic-language English \
    --command exit > /wallet/INITIAL_WALLET_SEED.txt 2>&1
  chmod 0600 /wallet/INITIAL_WALLET_SEED.txt
  echo "A wallet was created. Immediately back up /wallet/INITIAL_WALLET_SEED.txt offline, then securely remove it." >&2
fi

exec gosu monero monero-wallet-rpc $network_flag \
  --wallet-file "$wallet_path" \
  --password-file "$wallet_password_file" \
  --daemon-address monerod:38081 \
  --trusted-daemon \
  --rpc-bind-ip 0.0.0.0 \
  --rpc-bind-port 38088 \
  --confirm-external-bind \
  --config-file "$rpc_config" \
  --no-initial-sync \
  --disable-rpc-ban \
  --non-interactive
