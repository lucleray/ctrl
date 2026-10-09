#!/bin/sh
# Runs digest.mjs with node, or with ctrl's bundled runtime (Electron as node) when
# node isn't installed. ctrl writes its executable's path to .ctrl-exec on install.
dir=$(cd "$(dirname "$0")" && pwd)
if command -v node >/dev/null 2>&1; then
  exec node "$dir/digest.mjs" "$@"
fi
for app in "$(cat "$dir/.ctrl-exec" 2>/dev/null)" /Applications/ctrl.app/Contents/MacOS/ctrl; do
  if [ -n "$app" ] && [ -x "$app" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$app" "$dir/digest.mjs" "$@"
  fi
done
echo "read-session: needs node, or ctrl.app in /Applications" >&2
exit 1
