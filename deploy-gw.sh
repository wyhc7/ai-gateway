#!/usr/bin/env bash
set -euo pipefail

export PATH="/root/.nvm/versions/node/v20.20.2/bin:$PATH"
cd /opt/ai-gateway/server

OLD_REV="$(git rev-parse --short HEAD)"
echo "[$(date +%T)] repo at $OLD_REV, fetching"
git -c http.version=HTTP/1.1 fetch --prune origin
FULL_REV="$(git rev-parse origin/main)"
NEW_REV="$(git rev-parse --short origin/main)"

if [ "$OLD_REV" = "$NEW_REV" ]; then
  echo "no update: already at $OLD_REV"
  exit 0
fi

echo "[$(date +%T)] merge $OLD_REV -> $NEW_REV"
git merge --ff-only origin/main

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "working tree dirty, refusing:"
  echo "$DIRTY"
  exit 1
fi

TEST_DATA="$(mktemp -d)"
echo "[$(date +%T)] test gate"
if ! DATA_DIR="$TEST_DATA" npm test > /tmp/gw-deploy-test.log 2>&1; then
  echo "TEST FAILED:"
  grep -E '^(# (tests|pass|fail))|not ok' /tmp/gw-deploy-test.log | head -20
  rm -rf "$TEST_DATA"
  exit 1
fi
grep -E '^# (tests|pass|fail)' /tmp/gw-deploy-test.log
rm -rf "$TEST_DATA"
rm -f /tmp/gw-deploy-test.log

if git diff --name-only "$OLD_REV"..HEAD | grep -qE '^web/'; then
  echo "[$(date +%T)] build web"
  npm --prefix /opt/ai-gateway/web run build
else
  echo "no web change, skip build"
fi

echo "[$(date +%T)] restart"
systemctl restart ai-gateway.service

OK=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    echo "[$(date +%T)] healthy after ${i}s"
    OK=1
    break
  fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  echo "health check FAILED"
  systemctl --no-pager -n 20 status ai-gateway.service || true
  exit 1
fi

REVISION="$FULL_REV" node -e '
const fs = require("fs")
const p = "/opt/ai-gateway/data/deployed-revision.json"
fs.writeFileSync(p, JSON.stringify({
  revision: process.env.REVISION,
  at: Date.now(),
  via: "manual-deploy"
}, null, 2) + "\n")
console.log("wrote", p, "->", process.env.REVISION)
'

echo "[$(date +%T)] served check"
curl -fsS http://127.0.0.1:3001/ >/dev/null && echo "root OK"

echo "[$(date +%T)] done $OLD_REV -> $NEW_REV"
