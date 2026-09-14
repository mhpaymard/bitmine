#!/bin/sh
set -eu

rpc_password="$(cat /run/secrets/bitcoin_rpc_password)"
wallet_passphrase="$(cat /run/secrets/bitcoin_wallet_passphrase)"
chain="${BITCOIN_CHAIN:-regtest}"
wallet_name="${BITCOIN_WALLET_NAME:-mining-gateway}"
rpc_user="${BITCOIN_RPC_USER:-miningrpc}"
rpc_salt="$(openssl rand -hex 16)"
rpc_digest="$(printf '%s' "$rpc_password" | openssl dgst -sha256 -hmac "$rpc_salt" | awk '{print $2}')"
rpc_auth="${rpc_user}:${rpc_salt}\$${rpc_digest}"
unset rpc_password

case "$chain" in
  mainnet) network_flag="" ;;
  testnet) network_flag="-testnet" ;;
  signet) network_flag="-signet" ;;
  regtest) network_flag="-regtest" ;;
  *) echo "Unsupported BITCOIN_CHAIN: $chain" >&2; exit 1 ;;
esac

mkdir -p /bitcoin
chown -R bitcoin:bitcoin /bitcoin

gosu bitcoin bitcoind \
  $network_flag \
  -datadir=/bitcoin \
  -server=1 \
  -listen=1 \
  -prune="${BITCOIN_PRUNE_MIB:-100000}" \
  -rpcbind=0.0.0.0 \
  -rpcallowip=127.0.0.1 \
  -rpcallowip=172.16.0.0/12 \
  -rpcport=18443 \
  -rpcauth="$rpc_auth" \
  -fallbackfee=0.0002 \
  -printtoconsole=1 &
daemon_pid=$!

shutdown() {
  bitcoin-cli $network_flag -datadir=/bitcoin -rpcport=18443 stop >/dev/null 2>&1 || true
  wait "$daemon_pid" || true
}
trap shutdown INT TERM

until bitcoin-cli $network_flag -datadir=/bitcoin -rpcport=18443 getblockchaininfo >/dev/null 2>&1; do
  kill -0 "$daemon_pid" 2>/dev/null || { wait "$daemon_pid"; exit $?; }
  sleep 2
done

cli="bitcoin-cli $network_flag -datadir=/bitcoin -rpcport=18443"
if ! $cli listwalletdir | grep -Fq "\"$wallet_name\""; then
  printf '%s\n' "$wallet_name" false false "$wallet_passphrase" true true true | $cli -stdin createwallet >/dev/null
elif ! $cli listwallets | grep -Fq "\"$wallet_name\""; then
  $cli loadwallet "$wallet_name" >/dev/null
fi
unset wallet_passphrase

wait "$daemon_pid"
