#!/bin/sh
set -eu
mkdir -p /monero /wallet
chown -R monero:monero /monero /wallet

if [ "${1:-}" = "monerod" ]; then
  case "${MONERO_NETWORK:-stagenet}" in
    mainnet) ;;
    stagenet) set -- "$@" --stagenet ;;
    testnet) set -- "$@" --testnet ;;
    *) echo "Unsupported MONERO_NETWORK" >&2; exit 1 ;;
  esac
fi
exec gosu monero "$@"
