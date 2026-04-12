#!/bin/bash
# ============================================================================
# SRG - Language Server Proxy Wrapper
# ============================================================================
# 此 wrapper 替代原始 LS 二进制，始终通过 mgraftcp 走代理。
# 独立于 srg-on/off 的环境变量，LS 流量始终被代理。
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
MGRAFTCP="$HOME/bin/mgraftcp-fakedns"
PROXY_ADDR="__SRG_ADDR__"
PROXY_TYPE="__SRG_TYPE__"

# 如果 mgraftcp 不存在，直接运行原始 LS
if [ ! -x "$MGRAFTCP" ]; then
    exec "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi

# Go 程序需要 cgo DNS 解析器 (LD_PRELOAD 必需)
export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

if [ "$PROXY_TYPE" = "socks5" ]; then
    exec "$MGRAFTCP" --socks5 "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
else
    exec "$MGRAFTCP" --http_proxy "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi
