#!/usr/bin/env bash
# package.sh — Bundle the concurrent-demo into a self-contained zip that can
# be shared with non-technical users (marketers, presenters).
#
# Output:  dist/concurrent-demo-<version>.zip
#
# The archive contains ONLY what the end user needs to run the demo:
#   • READ_ME_FIRST.txt     Plain-text step-by-step instructions.
#   • Start Demo.command    macOS double-clickable launcher (preflight + run).
#   • README.md             Developer-oriented reference (optional to read).
#   • run.sh                Thin bash wrapper (for CLI power users).
#   • pyproject.toml        Python project manifest.
#   • uv.lock               Pinned dependency graph (reproducible installs).
#   • demo/                 The actual Python package.
#
# Everything else (.venv, website_build/, .git/, __pycache__, .DS_Store) is
# excluded so the archive stays tiny (<200 KB).
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-$(date +%Y%m%d)}"
DIST_DIR="dist"
BUNDLE_NAME="concurrent-demo-${VERSION}"
STAGE_DIR="${DIST_DIR}/${BUNDLE_NAME}"
ZIP_PATH="${DIST_DIR}/${BUNDLE_NAME}.zip"

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

say() { printf '%s▸%s %s\n' "$CYAN" "$RESET" "$*"; }
ok()  { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

say "Preparing ${BOLD}${BUNDLE_NAME}${RESET}…"

rm -rf "$STAGE_DIR" "$ZIP_PATH"
mkdir -p "$STAGE_DIR"

# ─── Copy the files the end user actually needs ───────────────────────────
cp "READ_ME_FIRST.txt"     "$STAGE_DIR/"
cp "Start Demo.command"    "$STAGE_DIR/"
cp "README.md"             "$STAGE_DIR/"
cp "run.sh"                "$STAGE_DIR/"
cp "pyproject.toml"        "$STAGE_DIR/"
cp "uv.lock"               "$STAGE_DIR/"

# Copy the demo/ package while excluding __pycache__, *.pyc, .DS_Store.
rsync -a \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.DS_Store' \
    "demo/" "$STAGE_DIR/demo/"

# Make sure the double-clickable launcher stays executable inside the zip.
chmod +x "$STAGE_DIR/Start Demo.command"
chmod +x "$STAGE_DIR/run.sh"

# ─── Create the zip (keeps the inner folder name so unzip produces a
# single tidy directory rather than spraying files into cwd). ─────────────
say "Compressing…"
(
    cd "$DIST_DIR"
    # -X strips extra metadata (timestamps, uid/gid) for cleaner archives;
    # -r recursive, -q quiet.
    zip -r -q -X "${BUNDLE_NAME}.zip" "$BUNDLE_NAME"
)

SIZE=$(du -h "$ZIP_PATH" | awk '{print $1}')
FILES=$(find "$STAGE_DIR" -type f | wc -l | tr -d ' ')

ok "Bundle ready: ${BOLD}${ZIP_PATH}${RESET}  ${DIM}(${SIZE}, ${FILES} files)${RESET}"
echo
echo "  Share this file with your teammate. On the other end:"
echo "    1. Unzip → opens a folder named '${BUNDLE_NAME}'"
echo "    2. Double-click 'Start Demo.command' inside that folder"
echo "    3. Follow the prompts in the Terminal window"
echo
