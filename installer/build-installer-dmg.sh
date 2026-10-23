#!/usr/bin/env bash
# Builds the small "installer" DMG (about 1 MB). The app inside is a launcher script that
# downloads the matching Electron runtime on first launch into
# ~/Library/Application Support/Board Daddy, then runs the app code shipped in the DMG.
#
# Use this when you can't run electron-builder on a Mac (it builds fine on Linux).
# On a Mac, `npm run dist` (the full, self-contained DMGs) is the normal route.
#
#   npm install                 # once, so node_modules/electron and pdf-lib exist
#   npm run dist:installer      # -> dist/Board-Daddy-<version>-installer.dmg
#
# macOS: uses hdiutil (built in).
# Linux: needs mkfs.hfsplus (apt install hfsprogs), cmake, a C compiler and git; it builds
#        mozilla/libdmg-hfsplus into .cache/ the first time (or set LIBDMG_BUILD=/path/to/build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP_VER="$(node -p "require('./package.json').version")"
EL_VER="$(node -p "require('./node_modules/electron/package.json').version")"
OUT="$ROOT/dist/Board-Daddy-$APP_VER-installer.dmg"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/root/Board Daddy.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$ROOT/dist"

echo "Board Daddy $APP_VER, Electron $EL_VER"
# Launcher with the Electron version the app is developed and tested against
sed "s/^VER=.*/VER=\"$EL_VER\"/" installer/launcher.sh > "$APP/Contents/MacOS/BoardDaddy"
chmod 755 "$APP/Contents/MacOS/BoardDaddy"
sed "s#<string>[0-9][0-9.]*</string>#<string>$APP_VER</string>#g; s#<key>LSMinimumSystemVersion</key><string>$APP_VER</string>#<key>LSMinimumSystemVersion</key><string>11.0</string>#" installer/Info.plist > "$APP/Contents/Info.plist"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"

# App code + production dependencies only
R="$APP/Contents/Resources/app"
cp -R main.js preload.js lib renderer "$R/"
mkdir -p "$R/build" && cp build/icon.png "$R/build/"
node -e "const p=require('./package.json');process.stdout.write(JSON.stringify({name:p.name,productName:p.productName,version:p.version,main:p.main,dependencies:p.dependencies}))" > "$R/package.json"
(cd "$R" && npm install --omit=dev --no-package-lock --ignore-scripts --no-audit --no-fund --silent)
# Trim duplicate builds and source maps (pdf-lib ships cjs, es, umd and TypeScript copies)
rm -rf "$R/node_modules/pdf-lib/"{dist,es,src,ts} "$R/node_modules/pako/dist"
find "$R/node_modules" \( -name "*.map" -o -name "*.d.ts" -o -name "*.md" \) -type f -delete
node -e "require('$R/node_modules/pdf-lib').PDFDocument.create().then(()=>console.log('pdf-lib OK'))"
cp installer/DMG-README.txt "$STAGE/root/README.txt"
rm -f "$OUT"

if [ "$(uname)" = "Darwin" ]; then
  ln -s /Applications "$STAGE/root/Applications"
  hdiutil create -volname "Board Daddy" -srcfolder "$STAGE/root" -ov -format UDZO "$OUT" >/dev/null
else
  command -v mkfs.hfsplus >/dev/null || { echo "Need mkfs.hfsplus: sudo apt install hfsprogs" >&2; exit 1; }
  B="${LIBDMG_BUILD:-$ROOT/.cache/libdmg-hfsplus/build}"
  if [ ! -x "$B/dmg/dmg" ] || [ ! -x "$B/hfs/hfsplus" ]; then
    echo "Building libdmg-hfsplus (one time)…"
    mkdir -p "$ROOT/.cache"
    [ -d "$ROOT/.cache/libdmg-hfsplus" ] || git clone --depth 1 https://github.com/mozilla/libdmg-hfsplus "$ROOT/.cache/libdmg-hfsplus"
    cmake -S "$ROOT/.cache/libdmg-hfsplus" -B "$B" >/dev/null
    make -C "$B" -j4 dmg-bin hfsplus >/dev/null 2>&1 || make -C "$B" -j4 >/dev/null
  fi
  SIZE=$(( $(du -sm "$STAGE/root" | cut -f1) + 20 ))
  dd if=/dev/zero of="$STAGE/vol.hfs" bs=1M count="$SIZE" status=none
  mkfs.hfsplus -v "Board Daddy" "$STAGE/vol.hfs" >/dev/null
  "$B/hfs/hfsplus" "$STAGE/vol.hfs" addall "$STAGE/root" / >/dev/null
  "$B/hfs/hfsplus" "$STAGE/vol.hfs" symlink /Applications /Applications >/dev/null
  "$B/hfs/hfsplus" "$STAGE/vol.hfs" chmod 755 "/Board Daddy.app/Contents/MacOS/BoardDaddy" >/dev/null
  "$B/dmg/dmg" build "$STAGE/vol.hfs" "$OUT" >/dev/null
fi
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
