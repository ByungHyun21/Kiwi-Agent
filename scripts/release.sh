#!/bin/sh
# Kiwi release script — builds binaries for all supported platforms,
# packages them as install.sh/updater-compatible tarballs, tags the
# release and (when the gh CLI is authenticated) uploads it.
#
# Usage:
#   scripts/release.sh <version>          # e.g. scripts/release.sh 0.1.1
#
# Steps:
#   1. verifies src/updater.ts VERSION and package.json match <version>
#   2. builds kiwi + kiwi-server for linux/darwin × amd64/arm64
#   3. creates dist-release/kiwi[_server]_<os>_<arch>.tar.gz
#   4. tags v<version> (pushes it) and creates the GitHub release
set -eu

VER="${1:-}"
[ -n "$VER" ] || { echo "usage: scripts/release.sh <version>"; exit 1; }
case "$VER" in v*) echo "pass the version without the leading v"; exit 1;; esac

grep -q "VERSION = \"$VER\"" src/updater.ts || {
  echo "error: src/updater.ts VERSION does not match $VER"; exit 1; }
grep -q "\"version\": \"$VER\"" package.json || {
  echo "error: package.json version does not match $VER"; exit 1; }

OUT="dist-release"
rm -rf "$OUT"
mkdir -p "$OUT"

build_one() {
  os="$1"; arch="$2"; bin="$3"; src="$4"
  bt_arch="$arch"; [ "$arch" = "amd64" ] && bt_arch=x64
  echo "building $bin for $os/$arch..."
  bun build --compile --target="bun-${os}-${bt_arch}" --outfile "$OUT/pkg/$bin" "$src" >/dev/null
  tar -czf "$OUT/${bin}_${os}_${arch}.tar.gz" -C "$OUT/pkg" "$bin"
  rm -rf "$OUT/pkg"
}

for os in linux darwin; do
  for arch in amd64 arm64; do
    build_one "$os" "$arch" kiwi src/kiwi.ts
    build_one "$os" "$arch" kiwi-server src/kiwi-server.ts
  done
done

echo "built assets:"
ls -la "$OUT"

# tag (skips when it already exists)
if git rev-parse -q --verify "refs/tags/v$VER" >/dev/null; then
  echo "tag v$VER already exists, skipping"
else
  git tag "v$VER"
  git push origin "v$VER"
  echo "tagged v$VER"
fi

# upload when gh is available and authenticated
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release create "v$VER" "$OUT"/*.tar.gz --title "v$VER" --generate-notes
  echo "release v$VER published"
else
  echo
  echo "gh CLI not authenticated — upload manually:"
  echo "  gh auth login && gh release create v$VER $OUT/*.tar.gz --generate-notes"
  echo "  (or drag the tarballs in $OUT/ onto https://github.com/ByungHyun21/Kiwi-Agent/releases/new?tag=v$VER)"
fi
