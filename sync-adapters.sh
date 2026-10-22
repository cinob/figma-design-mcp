#!/usr/bin/env bash
# Link adapter files into OpenCLI's discovery directory.
# Usage: ./sync-adapters.sh [link|unlink|status]
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTERS_DIR="$PROJECT_DIR/adapters/figma"
OPENCLI_DIR="$HOME/.opencli/clis/figma"

cmd="${1:-link}"

case "$cmd" in
  link)
    mkdir -p "$OPENCLI_DIR"
    mkdir -p "$ADAPTERS_DIR"
    count=0
    for f in "$ADAPTERS_DIR"/*.js; do
      if [ -e "$f" ]; then
        target="$OPENCLI_DIR/$(basename "$f")"
        if [ -L "$target" ] || [ -f "$target" ]; then rm "$target"; fi
        ln -s "$f" "$target"
        count=$((count + 1))
      fi
    done
    echo "Linked $count adapters to $OPENCLI_DIR"
    ;;
  unlink)
    rm -f "$OPENCLI_DIR"/*.js
    echo "Removed symlinks from $OPENCLI_DIR"
    ;;
  status)
    echo "=== Project adapters ==="
    ls -1 "$ADAPTERS_DIR"/*.js 2>/dev/null | xargs -I{} basename {} || echo "(none)"
    echo ""
    echo "=== OpenCLI symlinks ==="
    ls -la "$OPENCLI_DIR"/*.js 2>/dev/null || echo "(none)"
    ;;
  *)
    echo "Usage: $0 [link|unlink|status]"
    exit 1
    ;;
esac
