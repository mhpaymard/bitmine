#!/usr/bin/env bash
# Privileged helper for mining-gateway-netproxy.service.
#
# Runs as root, outside the hardened mining-gateway.service sandbox. Polls a small state file
# written by the application's ProxySettingsService (apps/server/src/network) and brings a
# system-wide OpenVPN or WireGuard tunnel up or down accordingly. This script never touches
# firewall rules and never manipulates routes directly -- it only starts/stops the standard
# client tool (openvpn / wg-quick), which is responsible for its own safe default-route
# handling (an OpenVPN config with `redirect-gateway` keeps a specific host route to the VPN
# server itself via the original gateway; wg-quick's fwmark-based policy routing does the
# same for the WireGuard endpoint). A malformed or missing config simply means the tunnel
# never comes up -- this script fails closed, not open.
set -Eeuo pipefail

state_dir="${NETPROXY_STATE_DIR:-/opt/mining-gateway/.local/netproxy}"
state_file="$state_dir/state.json"
vpn_config_file="$state_dir/vpn-config.conf"
marker_file="$state_dir/active.marker"
wg_interface="mgnetproxy"
wg_config_path="/etc/wireguard/${wg_interface}.conf"
openvpn_pid_file="/run/mining-gateway-netproxy-openvpn.pid"
openvpn_log_file="/var/log/mining-gateway-netproxy-openvpn.log"
poll_seconds="${NETPROXY_POLL_SECONDS:-5}"
min_retry_seconds=30
last_start_attempt=0

log() {
	logger -t mining-gateway-netproxy "$1" 2>/dev/null || true
	echo "$(date -Is) $1" >&2
}

read_state_field() {
	# Minimal JSON field reader; state.json is written by our own trusted code with a fixed shape.
	local field="$1"
	[ -f "$state_file" ] || { echo ''; return; }
	grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"\?[A-Za-z0-9_]*\"\?" "$state_file" |
		sed -E "s/\"$field\"[[:space:]]*:[[:space:]]*\"?([A-Za-z0-9_]*)\"?/\1/"
}

wireguard_active() {
	[ -e "/sys/class/net/$wg_interface" ]
}

openvpn_active() {
	[ -f "$openvpn_pid_file" ] && kill -0 "$(cat "$openvpn_pid_file" 2>/dev/null)" 2>/dev/null
}

start_wireguard() {
	command -v wg-quick >/dev/null || {
		log "wg-quick is not installed; cannot start WireGuard tunnel"
		return 1
	}
	install -o root -g root -m 0600 "$vpn_config_file" "$wg_config_path"
	if wg-quick up "$wg_interface" 2>>"$openvpn_log_file"; then
		log "WireGuard tunnel $wg_interface is up"
		touch "$marker_file"
	else
		log "WireGuard tunnel failed to start"
		return 1
	fi
}

stop_wireguard() {
	wireguard_active || return 0
	wg-quick down "$wg_interface" 2>>"$openvpn_log_file" || true
	log "WireGuard tunnel $wg_interface stopped"
}

start_openvpn() {
	command -v openvpn >/dev/null || {
		log "openvpn is not installed; cannot start OpenVPN tunnel"
		return 1
	}
	if openvpn --config "$vpn_config_file" --daemon mining-gateway-netproxy \
		--writepid "$openvpn_pid_file" --log "$openvpn_log_file"; then
		sleep 3
		if openvpn_active; then
			log "OpenVPN tunnel is up"
			touch "$marker_file"
		else
			log "OpenVPN process exited immediately; check $openvpn_log_file"
			return 1
		fi
	else
		log "OpenVPN failed to start"
		return 1
	fi
}

stop_openvpn() {
	openvpn_active || return 0
	kill "$(cat "$openvpn_pid_file")" 2>/dev/null || true
	rm -f "$openvpn_pid_file"
	log "OpenVPN tunnel stopped"
}

tunnel_up() {
	wireguard_active || openvpn_active
}

ensure_down() {
	stop_wireguard
	stop_openvpn
	rm -f "$marker_file"
}

ensure_up() {
	local vpn_type="$1"
	if tunnel_up; then return 0; fi
	local now
	now="$(date +%s)"
	if [ $((now - last_start_attempt)) -lt "$min_retry_seconds" ]; then
		return 0
	fi
	last_start_attempt="$now"
	if [ ! -s "$vpn_config_file" ]; then
		log "No VPN configuration uploaded yet; staying on direct routing"
		return 1
	fi
	case "$vpn_type" in
		WIREGUARD) start_wireguard ;;
		OPENVPN) start_openvpn ;;
		*)
			log "Unknown or unset VPN config type ($vpn_type); staying on direct routing"
			return 1
			;;
	esac
}

main_loop() {
	log "netproxy-agent starting; polling $state_file every ${poll_seconds}s"
	while true; do
		local apply_to_system active vpn_type
		apply_to_system="$(read_state_field applyToSystem)"
		active="$(read_state_field active)"
		vpn_type="$(read_state_field vpnConfigType)"
		if [ "$apply_to_system" = "true" ] && [ "$active" = "true" ]; then
			ensure_up "$vpn_type" || true
		else
			ensure_down
		fi
		sleep "$poll_seconds"
	done
}

trap 'ensure_down' EXIT

main_loop
