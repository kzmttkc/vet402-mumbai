#!/usr/bin/env bash
# Runs the backend tests from an empty temporary folder, so Bun never loads the
# app's .env and nothing can reach the app's data folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
env -u DATA_DIR -u BUYER_PRIVATE_KEY -u HOLD_PRIVATE_KEY bun test "$ROOT/server/__tests__"
