#!/usr/bin/env bash
# Applies the fixes from the November 2026 internal security assessment to an existing server.
# Safe to run more than once.   Usage:  bash /root/ghostchat/deploy/harden.sh
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
ok() { echo "✅ $*"; }; warn() { echo "⚠️  $*"; }

# H1 — call relay may only relay between Raazdar callers (itself), never to the rest of the internet
if [ -f /etc/turnserver.conf ]; then
  IP=$(grep -m1 '^external-ip=' /etc/turnserver.conf | cut -d= -f2)
  if [ -n "$IP" ]; then
    sed -i '/^denied-peer-ip=/d; /^allowed-peer-ip=/d; /^no-tcp-relay/d; /^# never relay into private/d' /etc/turnserver.conf
    printf '%s\n' "no-tcp-relay" "denied-peer-ip=0.0.0.0-255.255.255.255" "denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" "allowed-peer-ip=$IP" >> /etc/turnserver.conf
    systemctl restart coturn && ok "Call relay locked to Raazdar calls only" || warn "coturn didn't restart: systemctl status coturn"
  fi
fi

# M1 — no logs that could hold visitors' IP addresses
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "output discard" /etc/caddy/Caddyfile; then
  python3 - <<'PY'
p="/etc/caddy/Caddyfile"; s=open(p).read()
s=s.replace("{\n\tadmin off\n}", "{\n\tadmin off\n\tlog default {\n\t\toutput discard\n\t}\n}", 1)
open(p,"w").write(s)
PY
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl restart caddy && ok "Web server: all logs off" || warn "Caddy config check failed; left unchanged"
else ok "Web server: all logs off"; fi
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' > /etc/systemd/journald.conf.d/raazdar.conf
systemctl restart systemd-journald && journalctl --rotate >/dev/null 2>&1; journalctl --vacuum-time=1s >/dev/null 2>&1
rm -rf /var/log/journal/* 2>/dev/null; ok "System logs kept in memory only (erased on reboot)"
# old copies of web-server messages forwarded to syslog may hold visitor IPs: remove them
[ -f /var/log/syslog ] && sed -i '/caddy/d' /var/log/syslog; rm -f /var/log/syslog.* 2>/dev/null
[ -d /etc/rsyslog.d ] && printf ':programname, isequal, "caddy" stop\n:programname, isequal, "turnserver" stop\n' > /etc/rsyslog.d/10-raazdar-nolog.conf && systemctl restart rsyslog 2>/dev/null; ok "Old web-server log lines removed"
command -v ufw >/dev/null && ufw logging off >/dev/null 2>&1 && ok "Firewall logging off"

# M4 — supported Node.js (Ubuntu's Node 18 no longer gets free security updates)
NODEV=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODEV" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1
  NODEV=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$NODEV" -ge 22 ] && { systemctl restart ghostchat; ok "Node.js $(node -v) (supported LTS)"; } || warn "Node.js upgrade failed; still $(node -v)"
else ok "Node.js $(node -v) (supported LTS)"; fi

# automatic security updates
apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 && dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 && ok "Automatic security updates on"

# report-only checks (changing these could lock you out, so they are left to you)
if grep -qiE '^\s*PasswordAuthentication\s+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
  warn "SSH still accepts passwords. Use SSH keys only (see the security report)."
else ok "SSH: password login is not enabled"; fi
sleep 2; systemctl is-active --quiet ghostchat && ok "Raazdar is running" || warn "Raazdar isn't running: journalctl -u ghostchat -n 20"
