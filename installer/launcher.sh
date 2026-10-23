#!/bin/bash
# Board Daddy launcher. On first run it downloads the Electron engine (once),
# then starts the app. Nothing else is installed.
VER="33.4.11"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$HERE/Resources/app"
case "$(uname -m)" in arm64) EA=arm64 ;; *) EA=x64 ;; esac
SUPPORT="$HOME/Library/Application Support/Board Daddy"
RT="$SUPPORT/electron-$VER-$EA"
BIN="$RT/Electron.app/Contents/MacOS/Electron"

alert() { osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"Board Daddy\" with icon caution" >/dev/null 2>&1; }

if [ ! -x "$BIN" ]; then
  osascript -e 'display dialog "Board Daddy needs to download its engine (about 110 MB). This happens only once.\n\nIt can take a minute or two; the app opens by itself when it is done." buttons {"Cancel","Download"} default button 2 with title "Board Daddy"' >/dev/null 2>&1 || exit 0
  mkdir -p "$SUPPORT" || { alert "Could not create $SUPPORT"; exit 1; }
  TMP="$(mktemp -d "$SUPPORT/dl.XXXXXX")"
  URL="https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-darwin-$EA.zip"
  if ! curl -fsSL --retry 3 -o "$TMP/electron.zip" "$URL"; then
    rm -rf "$TMP"; alert "Download failed. Check your internet connection and try again."; exit 1
  fi
  mkdir -p "$TMP/x"
  if ! ditto -x -k "$TMP/electron.zip" "$TMP/x"; then
    rm -rf "$TMP"; alert "Could not unpack the engine. Try again."; exit 1
  fi
  rm -rf "$RT"; mv "$TMP/x" "$RT"; rm -rf "$TMP"
fi

exec "$BIN" "$APPDIR"
