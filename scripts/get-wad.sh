#!/usr/bin/env bash
# Downloads Freedoom Phase 1 (BSD-3) into wads/freedoom1.wad, verifying the release checksum.
set -euo pipefail
VER="${FREEDOOM_VERSION:-0.13.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/wads/freedoom1.wad"
[ -f "$OUT" ] && { echo "already present: $OUT"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/freedoom/freedoom/releases/download/v$VER"
curl -fsSL -o "$TMP/freedoom.zip" "$BASE/freedoom-$VER.zip"
curl -fsSL -o "$TMP/CHECKSUM" "$BASE/freedoom-$VER-CHECKSUM"
EXPECTED="$(grep "freedoom-$VER.zip" "$TMP/CHECKSUM" | grep -oE '[0-9a-f]{64}' | head -1)"
ACTUAL="$(shasum -a 256 "$TMP/freedoom.zip" | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "checksum mismatch: $ACTUAL != $EXPECTED"; exit 1; }
mkdir -p "$ROOT/wads"
unzip -q -j -o "$TMP/freedoom.zip" "freedoom-$VER/freedoom1.wad" -d "$ROOT/wads"
echo "wrote $OUT"
