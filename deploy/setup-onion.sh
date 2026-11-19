#!/usr/bin/env bash
# GhostChat — one-command install as a Tor onion service on Ubuntu 22.04+/Debian 12+.
# Run as root on a fresh VPS:   sudo bash deploy/setup-onion.sh
# Result: the app is reachable ONLY at a .onion address. No domain, no HTTPS certificate,
# no public ports. The server's IP is hidden from users and users' IPs are hidden from the server.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
APP_DIR=/opt/ghostchat
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Installing Tor and Node.js"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tor curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  apt-get install -y -qq nodejs npm >/dev/null
fi

echo "==> Installing app to $APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/public" "$APP_DIR/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$APP_DIR/"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --silent)

echo "==> Creating hardened service (RAM-only, localhost-only, no logs)"
cat > /etc/systemd/system/ghostchat.service <<UNIT
[Unit]
Description=GhostChat relay (onion only)
After=network.target tor.service

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Environment=HOST=127.0.0.1 PORT=3000 DATA_FILE=memory NODE_ENV=production
DynamicUser=yes
Restart=always
# No logs kept beyond the single startup line
StandardOutput=null
StandardError=null
# Sandbox
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
SystemCallArchitectures=native
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Configuring Tor onion service"
if ! grep -q "HiddenServiceDir /var/lib/tor/ghostchat/" /etc/tor/torrc; then
  { echo; cat "$SRC/deploy/torrc"; } >> /etc/tor/torrc
fi
if ! tor --verify-config -f /etc/tor/torrc >/dev/null 2>&1; then
  # Some Tor builds lack proof-of-work DoS defence: turn just that option off and continue
  sed -i 's/^HiddenServicePoWDefensesEnabled 1/# HiddenServicePoWDefensesEnabled 1 (not supported by this Tor build)/' /etc/tor/torrc
  tor --verify-config -f /etc/tor/torrc >/dev/null
fi

echo "==> Firewall: block all incoming except SSH"
if command -v ufw >/dev/null; then
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null; ufw --force enable >/dev/null
fi

echo "==> Turning off system logs that could record activity"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=16M\n' > /etc/systemd/journald.conf.d/ghostchat.conf
systemctl restart systemd-journald

systemctl daemon-reload
systemctl enable --now ghostchat >/dev/null
systemctl restart tor
for i in $(seq 1 30); do [ -f /var/lib/tor/ghostchat/hostname ] && break; sleep 1; done

echo
echo "============================================================"
echo " GhostChat is live at:"
echo "   http://$(cat /var/lib/tor/ghostchat/hostname)"
echo " Open it in Tor Browser (desktop or Android) or Onion Browser (iPhone)."
echo
echo " BACK UP /var/lib/tor/ghostchat/ — those keys ARE your .onion address."
echo "============================================================"
