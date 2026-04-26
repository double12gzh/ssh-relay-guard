#!/bin/bash
# Build srg-tunnel-client (Go native daemon) for multiple platforms
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TUNNEL_DIR="$PROJECT_DIR/srg-cli/tunnel"
OUTPUT_DIR="$PROJECT_DIR/resources/bin"

mkdir -p "$OUTPUT_DIR"

cd "$TUNNEL_DIR"

build_for_arch() {
    local os=$1
    local arch=$2
    local ext=""
    if [ "$os" == "windows" ]; then
        ext=".exe"
    fi
    
    echo "Building Go daemon for $os-$arch..."
    GOOS=$os GOARCH=$arch go build -ldflags="-s -w" -trimpath -o "$OUTPUT_DIR/srg-tunnel-client-$os-$arch$ext" main.go
}

build_for_arch "darwin" "arm64"
build_for_arch "darwin" "amd64"
build_for_arch "linux" "amd64"
build_for_arch "linux" "arm64"
build_for_arch "windows" "amd64"

echo ""
echo "Go daemon build complete!"
ls -la "$OUTPUT_DIR" | grep srg-tunnel-client
