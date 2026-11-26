#!/usr/bin/env bash
# Adds a fast, normal web address (https://your-domain) to an existing GhostChat server.
# The .onion address keeps working. Usage:  bash setup-domain.sh chat.example.com
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Usage: bash setup-domain.sh your-domain.com"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }

echo "==> Checking that $DOMAIN points to this server…"
MYIP=$(curl -4 -s https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -z "$DNSIP" ] || [ "$DNSIP" != "$MYIP" ]; then
  echo "!! $DOMAIN points to '${DNSIP:-nothing}', but this server is $MYIP."
  echo "   In your domain settings add an A record:  @  ->  $MYIP   then wait 10 minutes and run this again."
  exit 1
fi

echo "==> Installing Caddy (gets and renews the https certificate automatically)…"
if ! command -v caddy >/dev/null; then
  apt-get update -qq && apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

# No "log" directive = Caddy keeps NO access log, so visitors' IP addresses are not recorded.
cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
}
$DOMAIN, www.$DOMAIN {
	@www host www.$DOMAIN
	redir @www https://$DOMAIN{uri} permanent
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
EOF
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl restart caddy

if command -v ufw >/dev/null; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

# one-word updates from now on: type  ghostchat-update
cat > /usr/local/bin/ghostchat-update <<'EOF'
#!/usr/bin/env bash
set -e
cd /root && rm -rf ghostchat ghostchat.zip
wget -q https://github.com/Ghostchat1/ghostchat/raw/main/ghostchat.zip && unzip -oq ghostchat.zip
cp -r ghostchat/public /opt/ghostchat/ && cp ghostchat/server.js /opt/ghostchat/
systemctl restart ghostchat 2>/dev/null || true
echo "GhostChat updated: $(grep -o 'GhostChat v[0-9.]*' /opt/ghostchat/public/app.js | tail -1)"
EOF
chmod +x /usr/local/bin/ghostchat-update

sleep 4
if curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN/" | grep -q 200; then
  echo; echo "✅ DONE. GhostChat is live at:  https://$DOMAIN"
else
  echo; echo "⏳ Almost done — the certificate can take a minute. Open https://$DOMAIN shortly."
fi
echo "   (.onion address still works.)  To update in future, just type:  ghostchat-update"
