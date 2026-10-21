#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/manifest.json" | head -n 1)"

if [[ -z "$VERSION" ]]; then
  echo "Unable to read version from manifest.json" >&2
  exit 1
fi

DIST="$ROOT/dist"
STAGE="$DIST/md2xarticle-v$VERSION"
VERSIONED_ZIP="$DIST/md2xarticle-v$VERSION.zip"
LATEST_ZIP="$DIST/md2xarticle.zip"

rm -rf "$STAGE"
mkdir -p "$STAGE"

cp "$ROOT/manifest.json" "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/"
cp -R "$ROOT/src" "$ROOT/vendor" "$STAGE/"
find "$STAGE" -name ".DS_Store" -delete

rm -f "$VERSIONED_ZIP" "$LATEST_ZIP" "$DIST/SHA256SUMS"
(
  cd "$STAGE"
  zip -qr "$VERSIONED_ZIP" .
)
cp "$VERSIONED_ZIP" "$LATEST_ZIP"
rm -rf "$STAGE"

(
  cd "$DIST"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "md2xarticle-v$VERSION.zip" "md2xarticle.zip" > SHA256SUMS
  else
    shasum -a 256 "md2xarticle-v$VERSION.zip" "md2xarticle.zip" > SHA256SUMS
  fi
)

unzip -tq "$VERSIONED_ZIP"
echo
echo "Created:"
echo "  $VERSIONED_ZIP"
echo "  $LATEST_ZIP"
echo "  $DIST/SHA256SUMS"
