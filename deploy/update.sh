#!/usr/bin/env bash
# Applies the downloaded Raazdar release (in /root/ghostchat) to the running server.
# Run automatically by `ghostchat-update`.
set -e
SRC=/root/ghostchat; APP=/opt/ghostchat
[ -d "$SRC/public" ] || { echo "Download missing: run ghostchat-update"; exit 1; }
cp -r "$SRC/public" "$APP/"
[ -d "$SRC/admin" ] && rm -rf "$APP/admin" && cp -r "$SRC/admin" "$APP/"
cp "$SRC/server.js" "$SRC/package.json" "$APP/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$APP/"
(cd "$APP" && (npm ci --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1) || true)

# Waiting messages survive updates/restarts by being handed over in /run/ghostchat (RAM, never disk).
mkdir -p /etc/systemd/system/ghostchat.service.d
cat > /etc/systemd/system/ghostchat.service.d/runtime.conf <<UNIT
[Service]
RuntimeDirectory=ghostchat
RuntimeDirectoryPreserve=yes
RuntimeDirectoryMode=0700
# Plus/Work: the licence signing key, used voucher serials and the owner-panel key (no user data)
StateDirectory=raazdar
StateDirectoryMode=0700
TimeoutStopSec=20
UNIT

# keep this updater itself current
cat > /usr/local/bin/ghostchat-update <<'UPD'
#!/usr/bin/env bash
set -e
cd /root && rm -rf ghostchat ghostchat.zip
wget -q https://github.com/Ghostchat1/raazdar/raw/main/ghostchat.zip && unzip -oq ghostchat.zip
bash /root/ghostchat/deploy/update.sh
UPD
chmod +x /usr/local/bin/ghostchat-update

systemctl daemon-reload
systemctl restart ghostchat
sleep 2
if systemctl is-active --quiet ghostchat; then
  echo "✅ Raazdar updated: $(grep -oE '(GhostChat|Raazdar) v[0-9.]*' $APP/public/app.js | tail -1)"
  sleep 1
  if [ -f /var/lib/raazdar/admin.key ]; then
    echo "🔑 Owner panel: https://raazdar.app/admin  ·  admin key: $(cat /var/lib/raazdar/admin.key)"
    echo "   (keep this key secret; to change it: rm /var/lib/raazdar/admin.key && systemctl restart ghostchat)"
  fi
else
  echo "❌ Raazdar didn't start. Send a screenshot of: journalctl -u ghostchat -n 20"
fi
