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
if command -v sha256sum >/dev/null; then ACTUAL="$(sha256sum "$TMP/freedoom.zip" | cut -d' ' -f1)"
else ACTUAL="$(shasum -a 256 "$TMP/freedoom.zip" | cut -d' ' -f1)"; fi
[ "$EXPECTED" = "$ACTUAL" ] || { echo "checksum mismatch: $ACTUAL != $EXPECTED"; exit 1; }
mkdir -p "$ROOT/wads"
if command -v unzip >/dev/null; then
  unzip -q -j -o "$TMP/freedoom.zip" "freedoom-$VER/freedoom1.wad" -d "$ROOT/wads"
else
  python3 -c 'import sys,zipfile; open(sys.argv[3],"wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' \
    "$TMP/freedoom.zip" "freedoom-$VER/freedoom1.wad" "$OUT"
fi
echo "wrote $OUT"
