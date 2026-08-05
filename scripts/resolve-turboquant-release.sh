#!/usr/bin/env bash
# Resolve the newest *stable* TurboQuant release for one backend id and print
# "<tag> <asset>" on stdout.
#
# No release tag is pinned anywhere in this repository: the fork's own
# `releases/latest` is the single source of truth, so a new fork release is
# picked up by the next build without a commit here. Pass a tag as the second
# argument (the Makefile forwards TURBOQUANT_TAG) for a reproducible CI build.
#
# Resolution order, first usable answer wins:
#   1. index.json published as an asset of the latest release
#   2. the /releases/latest redirect, which names the newest stable tag
#   3. the legacy backends/turboquant-manifest.json in atomic-chat-conf@main
set -euo pipefail

backend="${1:-}"
override="${2:-}"
if [ -z "$backend" ]; then
  echo "usage: $(basename "$0") <backend-id> [tag-override]" >&2
  exit 2
fi

INDEX_URL='https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest/download/index.json'
LATEST_URL='https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest'
DOWNLOAD_URL='https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download'
LEGACY_URL='https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json'
STABLE_TAG_RE='^b[0-9]+-[0-9]+\.[0-9]+\.[0-9]+$'

# GitHub's asset CDN answers HEAD with 403, so ask for a single byte instead.
asset_exists() {
  curl -fsSL --retry 2 --retry-delay 1 -r 0-0 -o /dev/null \
    -H 'User-Agent: atomic-chat-ci' "$1" 2>/dev/null
}

case "$backend" in
  windows-*|win-*) default_asset="llama-turboquant-${backend}.zip" ;;
  *) default_asset="llama-turboquant-${backend}.tar.gz" ;;
esac

if [ -n "$override" ]; then
  echo "Using pinned release: $override" >&2
  echo "$override $default_asset"
  exit 0
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# 1. index.json
if curl -fsSL --retry 3 --retry-delay 2 -H 'User-Agent: atomic-chat-ci' \
    "$INDEX_URL" -o "$tmp" 2>/dev/null; then
  resolved="$(jq -r --arg id "$backend" '
    [ .releases[]?
      | select((.prerelease // false) == false)
      | select(.tag | test("^b[0-9]+-[0-9]+\\.[0-9]+\\.[0-9]+$"))
      | . as $release
      | .variants[]?
      | select(.id == $id)
      | { tag: $release.tag, asset: (.asset // "") }
    ]
    | sort_by(.tag | capture("^b(?<build>[0-9]+)-(?<x>[0-9]+)\\.(?<y>[0-9]+)\\.(?<z>[0-9]+)$")
                   | [.build, .x, .y, .z] | map(tonumber))
    | reverse | .[0] // empty
    | "\(.tag) \(.asset)"' "$tmp" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    tag="${resolved%% *}"
    asset="${resolved#* }"
    [ -n "$asset" ] || asset="$default_asset"
    echo "Resolved from the release index: $tag" >&2
    echo "$tag $asset"
    exit 0
  fi
  echo "Release index carries no stable ${backend} variant, trying /releases/latest" >&2
fi

# 2. /releases/latest -> /releases/tag/<tag>
final_url="$(curl -fsSL --retry 3 --retry-delay 2 -o /dev/null \
  -H 'User-Agent: atomic-chat-ci' -w '%{url_effective}' "$LATEST_URL" 2>/dev/null || true)"
tag="${final_url##*/releases/tag/}"
if [ -n "$final_url" ] && [ "$tag" != "$final_url" ] &&
   printf '%s' "$tag" | grep -Eq "$STABLE_TAG_RE"; then
  # This step has no variant list to consult, so the asset name is a guess
  # from the fork's naming convention. Confirm it before handing it to a build
  # that would otherwise fail much later on an unexplained 404.
  if asset_exists "${DOWNLOAD_URL}/${tag}/${default_asset}"; then
    echo "Resolved from the /releases/latest redirect: $tag" >&2
    echo "$tag $default_asset"
    exit 0
  fi
  echo "Release $tag publishes no ${default_asset}, trying the legacy manifest" >&2
fi

# 3. legacy conf manifest
if curl -fsSL --retry 3 --retry-delay 2 -H 'User-Agent: atomic-chat-ci' \
    "$LEGACY_URL" -o "$tmp" 2>/dev/null; then
  resolved="$(jq -r --arg id "$backend" '
    .backends[]? | select(.id == $id) | "\(.tag) \(.asset // "")"' "$tmp" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    tag="${resolved%% *}"
    asset="${resolved#* }"
    [ -n "$asset" ] || asset="$default_asset"
    echo "Resolved from the legacy atomic-chat-conf manifest: $tag" >&2
    echo "$tag $asset"
    exit 0
  fi
fi

echo "Error: could not resolve a stable TurboQuant release for '${backend}'." >&2
echo "       Tried ${INDEX_URL}, ${LATEST_URL} and ${LEGACY_URL}." >&2
echo "       Pass TURBOQUANT_TAG=<tag> to pin one explicitly." >&2
exit 1
