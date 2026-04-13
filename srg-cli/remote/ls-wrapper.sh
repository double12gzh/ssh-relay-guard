#!/bin/bash
# ============================================================================
# SRG - Language Server Proxy Wrapper
# ============================================================================
# 此 wrapper 替代原始 LS 二进制，始终通过 mgraftcp 走代理。
# 独立于 srg-on/off 的环境变量，LS 流量始终被代理。
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Proxy configuration
PROXY_ADDR="__SRG_ADDR__"
PROXY_TYPE="__SRG_TYPE__"
REWRITE_CLOUDCODE="__REWRITE_CLOUDCODE_PLACEHOLDER__"
EXTENSION_BIN_PATH="__EXTENSION_BIN_PATH__"

# Dynamically find mgraftcp-fakedns and libdnsredir
find_binaries() {
    local IDE_SERVER_DIRS=(".antigravity-server" ".vscode-server" ".cursor-server" ".windsurf-server")
    local arch=$(uname -m)
    local binary_name=""
    local lib_name=""
    case "$arch" in
        x86_64|amd64) 
            binary_name="mgraftcp-fakedns-linux-amd64"
            lib_name="libdnsredir-linux-amd64.so"
            ;;
        aarch64|arm64) 
            binary_name="mgraftcp-fakedns-linux-arm64"
            lib_name="libdnsredir-linux-arm64.so"
            ;;
        *) return 1 ;;
    esac
    
    # Method 1: Use exact extension path if provided (preferred)
    if [ -n "${EXTENSION_BIN_PATH}" ] && [ -d "${EXTENSION_BIN_PATH}" ] && [ "${EXTENSION_BIN_PATH}" != "__EXTENSION_BIN_PATH__" ]; then
        if [ -f "$EXTENSION_BIN_PATH/$binary_name" ]; then
            echo "$EXTENSION_BIN_PATH/$binary_name"
            if [ -f "$EXTENSION_BIN_PATH/$lib_name" ]; then
                echo "$EXTENSION_BIN_PATH/$lib_name"
            fi
            return 0
        fi
    fi

    # Method 2: Check standalone CLI installation (~/bin)
    if [ -f "$HOME/bin/$binary_name" ]; then
        echo "$HOME/bin/$binary_name"
        if [ -f "$HOME/bin/$lib_name" ]; then
            echo "$HOME/bin/$lib_name"
        fi
        return 0
    fi
    
    # Method 3: Fallback - search in all IDE versions
    for _d in "${IDE_SERVER_DIRS[@]}"; do
        for dir in $(ls -d "$HOME/$_d/extensions/"*ssh-relay-guard*/resources/bin 2>/dev/null | sort -t'-' -k3 -V -r); do
            if [ -f "$dir/$binary_name" ]; then
                echo "$dir/$binary_name"
                if [ -f "$dir/$lib_name" ]; then
                    echo "$dir/$lib_name"
                fi
                return 0
            fi
        done
    done
    return 1
}

BINARIES=$(find_binaries)
MGRAFTCP_PATH=$(echo "$BINARIES" | head -1)

# 如果 mgraftcp 不存在，直接运行原始 LS
if [ -z "$MGRAFTCP_PATH" ] || [ ! -x "$MGRAFTCP_PATH" ]; then
    exec "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi

# Go 程序需要 cgo DNS 解析器 (LD_PRELOAD 必需)
export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

if [ "$REWRITE_CLOUDCODE" = "true" ]; then
    ARGS=()
    for arg in "$@"; do
        ARGS+=("$(echo "$arg" | sed 's|daily-cloudcode-pa\.googleapis\.com|cloudcode-pa.googleapis.com|g')")
    done
    set -- "${ARGS[@]}"
fi

if [ "$PROXY_TYPE" = "socks5" ]; then
    exec "$MGRAFTCP_PATH" --socks5 "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
else
    exec "$MGRAFTCP_PATH" --http_proxy "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi
