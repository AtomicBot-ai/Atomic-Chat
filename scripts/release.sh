#!/usr/bin/env bash
#
# Bump the Atomic Chat version, commit, and create a git tag.
#
# Usage:
#   ./scripts/release.sh patch        # 0.6.599 → 0.6.600
#   ./scripts/release.sh minor        # 0.6.599 → 0.7.0
#   ./scripts/release.sh major        # 0.6.599 → 1.0.0
#   ./scripts/release.sh 1.2.3        # explicit version
#
# The script will:
#   1. Update version in src-tauri/tauri.conf.json
#   2. Update version in src-tauri/Cargo.toml
#   3. Update version in web-app/package.json
#   4. Create a commit: "release: vX.Y.Z"
#   5. Create an annotated git tag: vX.Y.Z
#
# After running, push with:
#   git push && git push --tags
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"
CARGO_TOML="$ROOT_DIR/src-tauri/Cargo.toml"
WEB_PKG="$ROOT_DIR/web-app/package.json"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <patch|minor|major|X.Y.Z>"
  exit 1
fi

BUMP="$1"

CURRENT=$(node -p "require('$TAURI_CONF').version")
echo "Current version: $CURRENT"

IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT"

case "$BUMP" in
  patch)
    NEW_VERSION="$CUR_MAJOR.$CUR_MINOR.$((CUR_PATCH + 1))"
    ;;
  minor)
    NEW_VERSION="$CUR_MAJOR.$((CUR_MINOR + 1)).0"
    ;;
  major)
    NEW_VERSION="$((CUR_MAJOR + 1)).0.0"
    ;;
  *)
    if [[ ! "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Error: version must be 'patch', 'minor', 'major', or a valid semver (X.Y.Z)"
      exit 1
    fi
    NEW_VERSION="$BUMP"
    ;;
esac

TAG="v$NEW_VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists"
  exit 1
fi

if ! git diff --quiet HEAD; then
  echo "Error: you have uncommitted changes. Commit or stash them first."
  exit 1
fi

echo "Bumping: $CURRENT → $NEW_VERSION (tag: $TAG)"

# 1. Update src-tauri/tauri.conf.json
node -e "
  const fs = require('fs');
  const raw = fs.readFileSync('$TAURI_CONF', 'utf-8');
  const updated = raw.replace(
    /\"version\":\s*\"[^\"]+\"/,
    '\"version\": \"$NEW_VERSION\"'
  );
  fs.writeFileSync('$TAURI_CONF', updated);
"
echo "  Updated tauri.conf.json → $NEW_VERSION"

# 2. Update src-tauri/Cargo.toml (first version = line in [package])
sed -i.bak -E "0,/^version = \"[^\"]+\"/s//version = \"$NEW_VERSION\"/" "$CARGO_TOML"
rm -f "${CARGO_TOML}.bak"
echo "  Updated Cargo.toml → $NEW_VERSION"

# 3. Update web-app/package.json
node -e "
  const fs = require('fs');
  const raw = fs.readFileSync('$WEB_PKG', 'utf-8');
  const updated = raw.replace(
    /\"version\":\s*\"[^\"]+\"/,
    '\"version\": \"$NEW_VERSION\"'
  );
  fs.writeFileSync('$WEB_PKG', updated);
"
echo "  Updated web-app/package.json → $NEW_VERSION"

# Verify
VERIFY=$(node -p "require('$TAURI_CONF').version")
if [[ "$VERIFY" != "$NEW_VERSION" ]]; then
  echo "Error: version update failed (got $VERIFY, expected $NEW_VERSION)"
  exit 1
fi

git add "$TAURI_CONF" "$CARGO_TOML" "$WEB_PKG"
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Atomic Chat $TAG"

echo ""
echo "Done! Created commit and tag $TAG."
echo ""
echo "Next steps:"
echo "  git push && git push --tags"
echo ""
echo "This will trigger the CI workflow to build and create a draft GitHub Release."
echo "After the build completes, go to GitHub Releases and publish the draft."
