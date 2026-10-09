#!/bin/sh
# Installs (or reinstalls) the latest ctrl release into /Applications.
#   gh api repos/lucleray/ctrl/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
# Goes through gh because the repo is private. Files gh downloads aren't quarantined,
# so the ad-hoc signed app opens without a Gatekeeper prompt.
set -e

REPO=lucleray/ctrl
APP=/Applications/ctrl.app

if ! command -v gh >/dev/null 2>&1; then
  echo "ctrl installs through the GitHub CLI: brew install gh && gh auth login" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Log in to GitHub first: gh auth login" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading the latest ctrl ($ARCH)…"
gh release download --repo "$REPO" --pattern "ctrl-*-mac-$ARCH.zip" --dir "$TMP"
ditto -x -k "$TMP"/ctrl-*-mac-"$ARCH".zip "$TMP/unpacked"

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

open "$APP"
