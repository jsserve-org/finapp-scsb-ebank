#!/bin/sh
set -eu
umask 077

cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SCSB_HEADLESS=true

exec >> ./cron.log 2>&1
printf '\n[%s] SCSB run started\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"

if ! /usr/bin/lockf -t 0 ./.run.lock /bin/sh -c '
  set -eu
  bun run src/check-config.ts
  if ! docker info >/dev/null 2>&1; then
    orb start
  fi
  docker compose -f compose.yml run --rm --no-deps fetch
'; then
  printf '[%s] SCSB run failed or another run is active\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  exit 1
fi

printf '[%s] SCSB run completed\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
