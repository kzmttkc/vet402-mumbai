#!/usr/bin/env bash
# Runs the backend tests from an empty temporary folder, so Bun never loads the
# app's .env and nothing can reach the app's data folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Bun may only be reachable through npx. Either way it runs from the empty folder.
if command -v bun > /dev/null 2>&1; then BUN=(bun); else BUN=(npx --yes bun); fi

cd "$TMP"
env -u DATA_DIR -u BUYER_PRIVATE_KEY -u HOLD_PRIVATE_KEY \
  -u ARKIV_WRITER_KEY -u ARKIV_ACCESS_KEY -u ARKIV_OTHER_KEY -u SELLER_TTL_SECONDS \
  "${BUN[@]}" test "$ROOT/server/__tests__"
