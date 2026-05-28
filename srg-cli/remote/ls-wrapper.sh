#!/bin/bash
# ============================================================================
# SRG - Language Server Proxy Wrapper
# ============================================================================
# 此 wrapper 替代原始 LS 二进制，始终通过 mgraftcp 走代理。
# 独立于 srg-on/off 的环境变量，LS 流量始终被代理。
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Debug log file — always write so we can diagnose startup issues
SRG_LOG="/tmp/srg-ls-wrapper-$(date +%Y%m%d).log"
_srg_log() {
    echo "[$(date '+%H:%M:%S')] [PID:$$] $*" >> "$SRG_LOG" 2>/dev/null
}

_srg_log "=== LS wrapper invoked ==="
_srg_log "SCRIPT_DIR=$SCRIPT_DIR"
_srg_log "SCRIPT_NAME=$SCRIPT_NAME"
_srg_log "ARGS=$*"

# Proxy configuration
# Dynamic: read from environment (per-session isolation for multi-user)
# No hardcoded fallback — prevents cross-user conflicts on shared accounts
PROXY_ADDR="${SRG_PROXY_ADDR:-}"
PROXY_TYPE="${SRG_PROXY_TYPE:-http}"
REWRITE_CLOUDCODE="${SRG_REWRITE_CLOUDCODE:-false}"
EXTENSION_BIN_PATH="__EXTENSION_BIN_PATH__"

# Fallback: if environment variable is not passed (due to IDE Server parent-child process isolation),
# read the port dynamically written by the extension to ~/.srg/port_<session_key>
if [ -z "$PROXY_ADDR" ]; then
    # Try all candidates in order to find the state file.
    # The LS process may have different environment variables from the Extension Host.
    for key in "$VSCODE_IPC_HOOK_CLI" "$SSH_CLIENT" "$SSH_CONNECTION" "default"; do
        [ -z "$key" ] && continue
        SAFE_NAME=$(echo -n "$key" | tr -c 'a-zA-Z0-9' '_')
        STATE_FILE="$HOME/.srg/port_${SAFE_NAME}"
        if [ -f "$STATE_FILE" ]; then
            DETECTED_PORT=$(cat "$STATE_FILE" 2>/dev/null | tr -d '[:space:]')
            if [ -n "$DETECTED_PORT" ]; then
                PROXY_ADDR="127.0.0.1:$DETECTED_PORT"
                _srg_log "Fallback to state file port (key: $key): $PROXY_ADDR"
                break
            fi
        fi
    done
fi

_srg_log "SRG_PROXY_ADDR=$PROXY_ADDR"
_srg_log "SRG_PROXY_TYPE=$PROXY_TYPE"
_srg_log "SRG_REWRITE_CLOUDCODE=$REWRITE_CLOUDCODE"
_srg_log "EXTENSION_BIN_PATH=$EXTENSION_BIN_PATH"
_srg_log "HTTP_PROXY=${HTTP_PROXY:-<unset>}"
_srg_log "HTTPS_PROXY=${HTTPS_PROXY:-<unset>}"

# ============================================================================
# Always clean proxy env vars FIRST, before any exec fallback.
# The VS Code Server process sets HTTP_PROXY/HTTPS_PROXY for extensions,
# but these MUST NOT leak into the Language Server process because:
#   - If using mgraftcp: double-proxy loop (ptrace + HTTP_PROXY)
#   - If NOT using mgraftcp: the LS may try to connect via a proxy addr
#     that expects mgraftcp-level interception, causing connection failures
#     and self-termination (SIGTERM from process_state.cc)
# ============================================================================
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"
_srg_log "Cleared HTTP_PROXY/HTTPS_PROXY, set NO_PROXY"

# Dynamically find mgraftcp-fakedns and libdnsredir
find_binaries() {
    local IDE_SERVER_DIRS=(".antigravity-ide-server" ".antigravity-server" ".vscode-server" ".cursor-server" ".windsurf-server")
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
            _srg_log "find_binaries: Method 1 (extension path): $EXTENSION_BIN_PATH/$binary_name"
            echo "$EXTENSION_BIN_PATH/$binary_name"
            if [ -f "$EXTENSION_BIN_PATH/$lib_name" ]; then
                echo "$EXTENSION_BIN_PATH/$lib_name"
            fi
            return 0
        fi
        _srg_log "find_binaries: Method 1 MISS: $EXTENSION_BIN_PATH/$binary_name not found"
    fi

    # Method 2: Check standalone CLI installation (~/bin)
    if [ -f "$HOME/bin/$binary_name" ]; then
        _srg_log "find_binaries: Method 2 (~/bin): $HOME/bin/$binary_name"
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
                _srg_log "find_binaries: Method 3 (IDE scan): $dir/$binary_name"
                echo "$dir/$binary_name"
                if [ -f "$dir/$lib_name" ]; then
                    echo "$dir/$lib_name"
                fi
                return 0
            fi
        done
    done
    _srg_log "find_binaries: FAILED - no binary found"
    return 1
}

BINARIES=$(find_binaries)
MGRAFTCP_PATH=$(echo "$BINARIES" | head -1)

# 如果没有代理地址（无环境变量，如外部 SSH 终端），直接运行原始 LS
if [ -z "$PROXY_ADDR" ]; then
    _srg_log "FALLBACK: No PROXY_ADDR, running original LS directly"
    exec "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi

# 如果 mgraftcp 不存在，直接运行原始 LS
if [ -z "$MGRAFTCP_PATH" ] || [ ! -x "$MGRAFTCP_PATH" ]; then
    _srg_log "FALLBACK: mgraftcp not found or not executable (MGRAFTCP_PATH=$MGRAFTCP_PATH), running original LS directly"
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
    _srg_log "EXEC: $MGRAFTCP_PATH --socks5 $PROXY_ADDR $SCRIPT_DIR/$SCRIPT_NAME.bak $*"
    exec "$MGRAFTCP_PATH" --socks5 "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
else
    _srg_log "EXEC: $MGRAFTCP_PATH --http_proxy $PROXY_ADDR $SCRIPT_DIR/$SCRIPT_NAME.bak $*"
    exec "$MGRAFTCP_PATH" --http_proxy "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi
