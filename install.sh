#!/bin/sh
# Installs (or reinstalls) the latest ctrl release into /Applications.
#   curl -fsSL https://raw.githubusercontent.com/lucleray/ctrl/main/install.sh | sh
# curl doesn't quarantine what it downloads (browsers do), so the ad-hoc signed app opens
# without a Gatekeeper prompt.
set -e

REPO=lucleray/ctrl
APP=${CTRL_APP:-/Applications/ctrl.app}

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading the latest ctrl ($ARCH)…"
curl -fL --progress-bar -o "$TMP/ctrl.zip" "https://github.com/$REPO/releases/latest/download/ctrl-mac-$ARCH.zip"
ditto -x -k "$TMP/ctrl.zip" "$TMP/unpacked"

if pgrep -f "^$APP/Contents/MacOS/" >/dev/null 2>&1; then
  echo "Quitting the running ctrl…"
  osascript -e 'tell application id "im.luc.ctrl" to quit' || true
  i=0
  while pgrep -f "^$APP/Contents/MacOS/" >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
fi

rm -rf "$APP"
ditto "$TMP/unpacked/ctrl.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "Installed $APP"

if ! command -v opencode >/dev/null 2>&1 && [ ! -x "$HOME/.opencode/bin/opencode" ]; then
  echo "ctrl needs opencode V2: curl -fsSL https://opencode.ai/v2/install | bash"
fi

[ -n "$CTRL_NO_OPEN" ] || open "$APP"
