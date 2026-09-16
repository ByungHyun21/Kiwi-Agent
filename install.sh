#!/bin/sh
# Kiwi installer — downloads a release binary, falls back to building with Go.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ByungHyun21/Kiwi-Agent/main/install.sh | sh            # kiwi (agent)
#   curl -fsSL https://raw.githubusercontent.com/ByungHyun21/Kiwi-Agent/main/install.sh | sh -s -- kiwi-server
set -eu

REPO="ByungHyun21/Kiwi-Agent"
BIN="${1:-kiwi}"
INSTALL_DIR="${HOME}/.local/bin"

say()  { printf 'kiwi: %s\n' "$1"; }
err()  { printf 'kiwi: error: %s\n' "$1" >&2; exit 1; }

[ "$BIN" = "kiwi" ] || [ "$BIN" = "kiwi-server" ] || err "unknown binary name: $BIN (expected kiwi or kiwi-server)"

case "$(uname -s)" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS: $(uname -s) (linux and darwin are supported)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) err "unsupported architecture: $(uname -m) (amd64 and arm64 are supported)" ;;
esac

mkdir -p "$INSTALL_DIR"

# 1) Prebuilt release from GitHub Releases
if command -v curl >/dev/null 2>&1; then
  url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
        | grep -o "\"browser_download_url\": *\"[^\"]*\"" \
        | grep "${BIN}_${os}_${arch}" \
        | head -1 \
        | sed 's/.*"\(https[^"]*\)".*/\1/') || url=""
  if [ -n "$url" ]; then
    say "downloading $url"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$url" | tar -xz -C "$tmp"
    [ -f "$tmp/$BIN" ] || err "release archive did not contain ./$BIN"
    install -m 755 "$tmp/$BIN" "$INSTALL_DIR/$BIN"
    say "installed $INSTALL_DIR/$BIN"
    case ":$PATH:" in
      *":$INSTALL_DIR:"*) ;;
      *) say "note: add $INSTALL_DIR to your PATH" ;;
    esac
    exit 0
  fi
fi

# 2) Build from source with Go
if command -v go >/dev/null 2>&1; then
  say "no prebuilt release for ${os}/${arch}; building with Go"
  GOBIN="$INSTALL_DIR" go install "github.com/$REPO/cmd/$BIN@latest"
  say "installed $INSTALL_DIR/$BIN"
  exit 0
fi

err "no release found for ${os}/${arch} and Go is not installed.
       Install Go from https://go.dev/dl/ and re-run this script."
