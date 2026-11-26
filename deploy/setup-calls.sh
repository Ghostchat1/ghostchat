#!/usr/bin/env bash
# Turns on encrypted voice & video calls: installs a TURN relay (coturn) so callers never see each
# other's IP address. Audio/video stay end-to-end encrypted (DTLS-SRTP); the relay only forwards
# scrambled packets and keeps NO logs.  Usage:  bash setup-calls.sh quietline.chat
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DOMAIN="${1:-}"; [ -n "$DOMAIN" ] || { echo "Usage: bash setup-calls.sh your-domain"; exit 1; }
echo "==> Installing the call relay (coturn)…"
apt-get update -qq && apt-get install -y -qq coturn >/dev/null
SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
IP=$(curl -4 -s https://api.ipify.org)
cat > /etc/turnserver.conf <<CONF
listening-port=3478
listening-ip=$IP
external-ip=$IP
relay-ip=$IP
min-port=49160
max-port=49200
realm=$DOMAIN
use-auth-secret
static-auth-secret=$SECRET
fingerprint
stale-nonce=600
user-quota=12
total-quota=200
max-bps=3000000
no-multicast-peers
no-loopback-peers
no-cli
no-tlsv1
no-tlsv1_1
# never relay into private/internal networks
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# no logs
log-file=/dev/null
no-stdout-log
CONF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable coturn >/dev/null 2>&1; systemctl restart coturn
if command -v ufw >/dev/null; then ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 49160:49200/udp >/dev/null; fi
mkdir -p /etc/systemd/system/ghostchat.service.d
cat > /etc/systemd/system/ghostchat.service.d/calls.conf <<UNIT
[Service]
Environment=TURN_SECRET=$SECRET TURN_HOST=$DOMAIN
UNIT
chmod 600 /etc/systemd/system/ghostchat.service.d/calls.conf
systemctl daemon-reload && systemctl restart ghostchat
sleep 2
systemctl is-active --quiet coturn && echo "✅ Calls are on. Relay: $DOMAIN:3478" || echo "❌ The call relay didn't start. Send me a screenshot of: systemctl status coturn --no-pager"
echo "   If DigitalOcean's cloud firewall is on, also allow UDP 3478, TCP 3478 and UDP 49160-49200."
