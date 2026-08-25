#!/usr/bin/env bash
# Update a running Proton deployment in place. Run as the proton user:
#   bash /srv/proton/deploy/deploy.sh [--no-pull] [--with-gateway]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2="${PM2:-pm2}"
BUN="${PROTON_BUN:-$HOME/.bun/bin/bun}"

PULL=1
WITH_GATEWAY=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --with-gateway) WITH_GATEWAY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

if [ "$PULL" -eq 1 ]; then
  echo "==> pulling"
  git pull --ff-only
fi

echo "==> installing dependencies"
"$BUN" install --frozen-lockfile

echo "==> building dashboard"
"$BUN" run build

echo "==> applying migrations"
"$BUN" --env-file="$ROOT/.env" "$ROOT/packages/db/src/migrate.ts"

# The gateway is excluded on purpose: Discord allows 1000 session starts a day and every restart
# spends one, so it is reloaded only when its own code changed. Pass --with-gateway for that.
SERVICES="proton-rest-proxy proton-api proton-worker proton-dashboard"
if [ "$WITH_GATEWAY" -eq 1 ]; then
  SERVICES="$SERVICES proton-gateway"
fi

for name in $SERVICES; do
  echo "==> reloading $name"
  "$PM2" reload "$name" --update-env
done

wait_for() {
  local name="$1" url="$2" i
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 2 "$url"; then
      echo "    $name ok"
      return 0
    fi
    sleep 1
  done
  echo "    $name DID NOT COME BACK: $url" >&2
  return 1
}

echo "==> smoke test"
failed=0
wait_for rest-proxy http://127.0.0.1:9001/healthz || failed=1
wait_for api http://127.0.0.1:9002/healthz || failed=1
wait_for dashboard http://127.0.0.1:9000/ || failed=1

if [ "$failed" -ne 0 ]; then
  echo "==> deploy finished with failures — check: $PM2 logs --lines 100" >&2
  exit 1
fi

"$PM2" save --force
echo "==> done"
