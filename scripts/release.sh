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

# The TUI embeds OpenTUI's native renderer, whose platform packages npm
# filters out by os/cpu — fetch every variant so cross builds can resolve them.
OTUI_VER=$(bun -e 'console.log(require("./node_modules/@opentui/core/package.json").version)')
for p in linux-x64 linux-arm64 linux-arm64-musl linux-x64-musl darwin-x64 darwin-arm64 win32-x64 win32-arm64; do
  if [ ! -f "node_modules/@opentui/core-$p/package.json" ]; then
    mkdir -p "node_modules/@opentui/core-$p"
    curl -fsSL "https://registry.npmjs.org/@opentui/core-$p/-/core-$p-${OTUI_VER}.tgz" | tar -xz -C "node_modules/@opentui/core-$p"
    if [ -d "node_modules/@opentui/core-$p/package" ]; then
      mv "node_modules/@opentui/core-$p/package"/* "node_modules/@opentui/core-$p/"
      rmdir "node_modules/@opentui/core-$p/package"
    fi
  fi
done

for os in linux darwin; do
  for arch in amd64 arm64; do
    bt_arch="$arch"; [ "$arch" = "amd64" ] && bt_arch=x64
    echo "building kiwi for $os/$arch..."
    bun run scripts/build-tui2.ts --target "bun-${os}-${bt_arch}" --outfile "$OUT/pkg/kiwi" >/dev/null
    tar -czf "$OUT/kiwi_${os}_${arch}.tar.gz" -C "$OUT/pkg" "kiwi"
    rm -rf "$OUT/pkg"
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
