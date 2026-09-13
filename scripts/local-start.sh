#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

KELY_START_MODE="openai"
if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ] && [ "$1" = "--fixture" ]; then
    KELY_START_MODE="fixture"
  else
    echo "Usage: ./scripts/local-start.sh [--fixture]"
    exit 1
  fi
fi

KELY_RUNTIME_ROOT="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if [ -x "${KELY_RUNTIME_ROOT}/node/bin/node" ]; then
  PATH="${KELY_RUNTIME_ROOT}/node/bin:${KELY_RUNTIME_ROOT}/bin/fallback:${PATH}"
  export PATH
fi

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo "Kely requires Node 24 and pnpm 11.19.0. Install them or launch from Codex's bundled runtime."
  exit 1
fi
if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi
if ! docker info >/dev/null 2>&1; then
  echo "Start Docker Desktop, then run this script again. Existing Kely data will be preserved."
  exit 1
fi
docker compose up -d --wait postgres
pnpm db:migrate
if [ "${KELY_START_MODE}" = "fixture" ]; then
  exec pnpm dev
fi
exec node --import tsx scripts/founder-start.ts
