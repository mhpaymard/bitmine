#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo 'Run this script as root.' >&2
	exit 1
fi

: "${PANEL_DOMAIN:?PANEL_DOMAIN is required}"
: "${MINING_DOMAIN:?MINING_DOMAIN is required}"
: "${LE_EMAIL:?LE_EMAIL is required}"
: "${ADMIN_CIDR:?ADMIN_CIDR is required}"

project_root="${PROJECT_ROOT:-/opt/mining-gateway}"
service_user="${SERVICE_USER:-mining-gateway}"
cert_name="${CERT_NAME:-$PANEL_DOMAIN}"
web_bind_ip="${WEB_BIND_IP:-0.0.0.0}"
xmr_domain="${XMR_DOMAIN:-$MINING_DOMAIN}"
nginx_template="$project_root/infra/nginx/mining-gateway.conf.template"
proxy_template="$project_root/infra/nginx/proxy-params.conf"
hook_template="$project_root/infra/nginx/deploy-certificate.sh.template"
cert_domains="$PANEL_DOMAIN"
if [ "$MINING_DOMAIN" != "$PANEL_DOMAIN" ]; then
	cert_domains="$cert_domains $MINING_DOMAIN"
fi
if [ "$xmr_domain" != "$PANEL_DOMAIN" ] && [ "$xmr_domain" != "$MINING_DOMAIN" ]; then
	cert_domains="$cert_domains $xmr_domain"
fi

for domain_value in "$PANEL_DOMAIN" "$MINING_DOMAIN" "$xmr_domain" "$cert_name"; do
	case "$domain_value" in
		*[!A-Za-z0-9.-]*|'') echo 'Invalid domain or certificate name.' >&2; exit 1 ;;
	esac
done
case "$web_bind_ip" in
	*[!0-9.]*|'') echo 'WEB_BIND_IP must be an IPv4 address.' >&2; exit 1 ;;
esac
case "$ADMIN_CIDR" in
	*[!0-9A-Fa-f:./]*|'') echo 'Invalid ADMIN_CIDR.' >&2; exit 1 ;;
esac
case "$ADMIN_CIDR" in
	0.0.0.0/0|::/0) echo 'ADMIN_CIDR cannot allow the entire Internet.' >&2; exit 1 ;;
esac
case "$LE_EMAIL" in
	*@*.*) ;;
	*) echo 'Invalid LE_EMAIL.' >&2; exit 1 ;;
esac

command -v nginx >/dev/null
command -v certbot >/dev/null
test -f "$nginx_template"
test -f "$proxy_template"
test -f "$hook_template"

install -d -o root -g root -m 0755 /var/www/certbot/.well-known/acme-challenge
install -d -o root -g root -m 0755 /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy

bootstrap_tmp="$(mktemp)"
nginx_tmp="$(mktemp)"
hook_tmp="$(mktemp)"
cleanup() {
	rm -f "$bootstrap_tmp" "$nginx_tmp" "$hook_tmp"
}
trap cleanup EXIT HUP INT TERM

cat >"$bootstrap_tmp" <<EOF
server {
	listen ${web_bind_ip}:80;
	server_name ${cert_domains};
	location ^~ /.well-known/acme-challenge/ {
		root /var/www/certbot;
		default_type text/plain;
	}
	location / { return 404; }
}
EOF

install -o root -g root -m 0644 "$bootstrap_tmp" /etc/nginx/sites-available/mining-gateway-bootstrap
rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/mining-gateway
ln -sfn /etc/nginx/sites-available/mining-gateway-bootstrap /etc/nginx/sites-enabled/mining-gateway-bootstrap
nginx -t
systemctl enable --now nginx
systemctl reload nginx

certbot_domains=(--domain "$PANEL_DOMAIN")
if [ "$MINING_DOMAIN" != "$PANEL_DOMAIN" ]; then
	certbot_domains+=(--domain "$MINING_DOMAIN")
fi
if [ "$xmr_domain" != "$PANEL_DOMAIN" ] && [ "$xmr_domain" != "$MINING_DOMAIN" ]; then
	certbot_domains+=(--domain "$xmr_domain")
fi
certbot certonly --webroot --webroot-path /var/www/certbot \
	--cert-name "$cert_name" \
	"${certbot_domains[@]}" \
	--email "$LE_EMAIL" \
	--agree-tos --no-eff-email --non-interactive --keep-until-expiring

sed \
	-e "s|__PANEL_DOMAIN__|$PANEL_DOMAIN|g" \
	-e "s|__CERT_DOMAINS__|$cert_domains|g" \
	-e "s|__CERT_NAME__|$cert_name|g" \
	-e "s|__ADMIN_CIDR__|$ADMIN_CIDR|g" \
	-e "s|__WEB_BIND_IP__|$web_bind_ip|g" \
	"$nginx_template" >"$nginx_tmp"
sed \
	-e "s|__PROJECT_ROOT__|$project_root|g" \
	-e "s|__CERT_NAME__|$cert_name|g" \
	-e "s|__SERVICE_USER__|$service_user|g" \
	"$hook_template" >"$hook_tmp"

install -o root -g root -m 0644 "$nginx_tmp" /etc/nginx/sites-available/mining-gateway
install -o root -g root -m 0644 "$proxy_template" /etc/nginx/snippets/mining-gateway-proxy.conf
install -o root -g root -m 0750 "$hook_tmp" /etc/letsencrypt/renewal-hooks/deploy/mining-gateway
rm -f /etc/nginx/sites-enabled/mining-gateway-bootstrap
ln -sfn /etc/nginx/sites-available/mining-gateway /etc/nginx/sites-enabled/mining-gateway
/etc/letsencrypt/renewal-hooks/deploy/mining-gateway
nginx -t
systemctl reload nginx
