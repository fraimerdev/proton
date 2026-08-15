#!/usr/bin/env bash
# Mirror the Windows working tree into the WSL copy (which has Linux
# node_modules and native Docker) and run the full suite there.
set -e
SRC="/mnt/c/Users/fraim/Projects/proton"
DEST="$HOME/proton"
export PATH="$HOME/.bun/bin:$PATH"

cd "$SRC"
tar --exclude='./node_modules' --exclude='./**/node_modules' --exclude='./.git' \
    --exclude='./.turbo' --exclude='./apps/dashboard/dist' \
    -cf - . | (cd "$DEST" && tar -xf -)

cd "$DEST"
bun install >/dev/null 2>&1
echo "=== integration suites, real Docker ==="
bun test 2>&1 | tail -12
