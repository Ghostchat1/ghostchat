#!/usr/bin/env bash
# Serves Raazdar on an extra web address (e.g. raazdar.app) alongside the existing one.
# Both addresses keep working, so people already using the old one don't lose their chats
# (a browser keeps each address's data separately).   Usage:  bash add-domain.sh raazdar.app
set -euo pipefail
NEW="${1:-}"; [ -n "$NEW" ] || { echo "Usage: bash add-domain.sh newdomain.com"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
command -v caddy >/dev/null || { echo "Caddy isn't installed. Run setup-domain.sh first."; exit 1; }

echo "==> Checking that $NEW points to this server…"
MYIP=$(curl -4 -s https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$NEW" | awk 'NR==1{print $1}' || true)
if [ -z "$DNSIP" ] || [ "$DNSIP" != "$MYIP" ]; then
  echo "!! $NEW points to '${DNSIP:-nothing}', but this server is $MYIP."
  echo "   In Hostinger DNS add:  A  @  ->  $MYIP   and   A  www  ->  $MYIP   then wait 15 minutes and run this again."
  exit 1
fi

if grep -q "^$NEW," /etc/caddy/Caddyfile; then echo "✅ $NEW is already set up."; exit 0; fi
# No "log" directive = no access log, so visitors' IP addresses are never recorded.
cat >> /etc/caddy/Caddyfile <<CADDY

$NEW, www.$NEW {
	@www host www.$NEW
	redir @www https://$NEW{uri} permanent
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	reverse_proxy 127.0.0.1:3000 {
		header_up -X-Forwarded-For
		header_up -X-Real-IP
	}
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl restart caddy
sleep 8
if curl -s -o /dev/null -w "%{http_code}" "https://$NEW/" | grep -q "200"; then
  echo "✅ Raazdar is live at https://$NEW"
else
  echo "⏳ Set up. The https certificate can take a minute; open https://$NEW shortly."
fi
