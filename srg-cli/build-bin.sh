#!/bin/bash
# ============================================================================
# build-bin.sh — 编译 mgraftcp-fakedns 预编译二进制
# ============================================================================
# 在 Linux 上运行，交叉编译 amd64 和 arm64 两个版本。
# 产物输出到 srg-cli/bin/，供 srg setup 部署到远程。
#
# 前提条件 (amd64 主机):
#   - git, make, gcc, go
#   - aarch64-linux-gnu-gcc (用于交叉编译 arm64)
#
# 用法:
#   bash srg-cli/build-bin.sh              # 编译两个架构
#   bash srg-cli/build-bin.sh amd64        # 只编译 amd64
#   bash srg-cli/build-bin.sh arm64        # 只编译 arm64
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/bin"
GO_VERSION="1.23.4"

# graftcp 源码路径（可通过环境变量覆盖）
GRAFTCP_PATH="${GRAFTCP_PATH:-}"

# ============================================================================
# 准备依赖
# ============================================================================
ensure_go() {
    if command -v go &>/dev/null; then
        echo "[INFO] Go 已安装: $(go version)"
        return
    fi
    echo "[INFO] 安装 Go $GO_VERSION..."
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64|amd64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
    esac
    local tar="go${GO_VERSION}.linux-${arch}.tar.gz"
    wget -q "https://go.dev/dl/${tar}" -O "/tmp/${tar}"
    sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf "/tmp/${tar}"
    rm "/tmp/${tar}"
    export PATH="/usr/local/go/bin:$PATH"
    echo "[INFO] Go 已安装: $(go version)"
}

ensure_cross_compiler() {
    if command -v aarch64-linux-gnu-gcc &>/dev/null; then
        echo "[INFO] ARM64 交叉编译器已安装"
        return
    fi
    echo "[INFO] 安装 ARM64 交叉编译器..."
    sudo apt-get update -qq && sudo apt-get install -y -qq gcc-aarch64-linux-gnu
}

ensure_graftcp_source() {
    if [ -n "$GRAFTCP_PATH" ] && [ -d "$GRAFTCP_PATH" ]; then
        echo "[INFO] 使用本地 graftcp: $GRAFTCP_PATH"
        return
    fi
    GRAFTCP_PATH="/tmp/graftcp-build"
    echo "[INFO] 克隆 graftcp 源码..."
    rm -rf "$GRAFTCP_PATH"
    git clone --depth 1 https://github.com/hmgle/graftcp.git "$GRAFTCP_PATH"
}

# ============================================================================
# 编译
# ============================================================================
build_for_arch() {
    local arch=$1
    local cross_prefix=$2

    echo ""
    echo "============================================"
    echo "  编译 linux-$arch"
    echo "============================================"

    cd "$GRAFTCP_PATH"
    make -C local clean 2>/dev/null || true

    if [ -n "$cross_prefix" ]; then
        make CROSS_COMPILE="$cross_prefix"
        cd local/dnsredir
        ${cross_prefix}gcc -Wall -Wextra -O2 -fPIC -o libdnsredir.so dnsredir.c -shared -ldl
        cd "$GRAFTCP_PATH"
    else
        make
    fi

    # 复制产物（注意：mgraftcp → mgraftcp-fakedns）
    mkdir -p "$OUTPUT_DIR"
    cp local/mgraftcp "$OUTPUT_DIR/mgraftcp-fakedns-linux-$arch"
    cp local/dnsredir/libdnsredir.so "$OUTPUT_DIR/libdnsredir-linux-$arch.so"
    chmod +x "$OUTPUT_DIR/mgraftcp-fakedns-linux-$arch"

    echo "[DONE] $OUTPUT_DIR/mgraftcp-fakedns-linux-$arch"
    echo "[DONE] $OUTPUT_DIR/libdnsredir-linux-$arch.so"
}

# ============================================================================
# 主入口
# ============================================================================
TARGET_ARCH="${1:-all}"

ensure_go
ensure_graftcp_source

case "$TARGET_ARCH" in
    amd64)
        build_for_arch "amd64" ""
        ;;
    arm64)
        ensure_cross_compiler
        build_for_arch "arm64" "aarch64-linux-gnu-"
        ;;
    all)
        build_for_arch "amd64" ""
        ensure_cross_compiler
        build_for_arch "arm64" "aarch64-linux-gnu-"
        ;;
    *)
        echo "用法: $0 [amd64|arm64|all]"
        exit 1
        ;;
esac

echo ""
echo "编译完成！"
ls -lh "$OUTPUT_DIR"/mgraftcp-* "$OUTPUT_DIR"/libdnsredir-* 2>/dev/null
