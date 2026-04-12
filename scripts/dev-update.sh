#!/bin/bash
# ============================================================================
# SRG Plugin Dev Update Script
# 在不重装插件的情况下，将源码改动同步到本地编辑器和远程主机。
#
# 用法:
#   ./scripts/dev-update.sh                # 仅更新本地
#   ./scripts/dev-update.sh <远程主机>      # 更新本地 + 手动部署远程
#
# 环境变量:
#   SRG_PORT  覆盖代理端口 (默认读取 package.json)
#   SRG_TYPE  覆盖代理类型 (默认读取 package.json, http 或 socks5)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "  ${GREEN}✓${NC} $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $*"; }
error() { echo -e "  ${RED}✗${NC} $*"; }
dim()   { echo -e "  ${DIM}$*${NC}"; }

REMOTE_HOST="${1:-}"

# 从 package.json 读取默认配置，支持环境变量覆盖
PROXY_PORT="${SRG_PORT:-$(node -e "console.log(require('./package.json').contributes.configuration.properties['ssh-relay-guard.remoteProxyPort'].default)")}"
PROXY_TYPE="${SRG_TYPE:-$(node -e "console.log(require('./package.json').contributes.configuration.properties['ssh-relay-guard.proxyType'].default)")}"

echo ""
echo -e "  ${BOLD}SRG Plugin Dev Update${NC}"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
dim "代理端口: $PROXY_PORT  类型: $PROXY_TYPE"
echo ""

# ============================================================================
# Step 1: 自动查找插件安装目录
# ============================================================================
echo -e "  ${BOLD}[1/5] 查找插件安装目录${NC}"

EXT_DIR=$(find "$HOME" -maxdepth 5 -type d -name "double12gzh.ssh-relay-guard*" 2>/dev/null | head -1)

if [ -z "$EXT_DIR" ]; then
    error "未找到已安装的插件目录"
    echo "  请确认已在编辑器中安装过 SSH Relay Guard 插件"
    exit 1
fi

info "找到: $EXT_DIR"

# ============================================================================
# Step 2: 自动递增版本号
# ============================================================================
echo ""
echo -e "  ${BOLD}[2/5] 递增版本号${NC}"

OLD_VERSION=$(node -e "console.log(require('./package.json').version)")
node -e "
const p = require('./package.json');
const v = p.version.split('.');
v[2] = +v[2] + 1;
p.version = v.join('.');
require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log(p.version);
" > /dev/null

NEW_VERSION=$(node -e "console.log(require('./package.json').version)")
info "$OLD_VERSION → $NEW_VERSION"

# ============================================================================
# Step 3: 构建
# ============================================================================
echo ""
echo -e "  ${BOLD}[3/5] 构建${NC}"

node esbuild.js > /dev/null 2>&1
info "dist/extension.js 已构建"

# ============================================================================
# Step 4: 覆盖本地插件文件
# ============================================================================
echo ""
echo -e "  ${BOLD}[4/5] 覆盖本地插件文件${NC}"

cp dist/extension.js "$EXT_DIR/dist/extension.js"
info "dist/extension.js"

cp package.json "$EXT_DIR/package.json"
info "package.json (v$NEW_VERSION)"

cp scripts/setup-proxy.sh "$EXT_DIR/scripts/setup-proxy.sh"
info "scripts/setup-proxy.sh"

# ============================================================================
# Step 5: 远程更新 (可选)
# ============================================================================
echo ""
echo -e "  ${BOLD}[5/5] 远程更新${NC}"

if [ -n "$REMOTE_HOST" ]; then
    dim "正在部署到 $REMOTE_HOST ..."
    scp -q scripts/setup-proxy.sh "$REMOTE_HOST:/tmp/setup-proxy.sh"
    ssh "$REMOTE_HOST" "PROXY_HOST=127.0.0.1 PROXY_PORT=$PROXY_PORT PROXY_TYPE=$PROXY_TYPE EXTENSION_VERSION=$NEW_VERSION bash /tmp/setup-proxy.sh" 2>&1 | sed 's/^/    /'
    info "远程部署完成: $REMOTE_HOST"
else
    dim "未指定远程主机, 跳过远程部署"
    dim "连接远程后插件会自动检测版本变化并重新 setup"
    dim "或手动: ./scripts/dev-update.sh <远程主机>"
fi

# ============================================================================
# Done
# ============================================================================
echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "本地更新完成 (v$NEW_VERSION)"
echo ""
echo -e "  ${YELLOW}→${NC} 在编辑器中执行 ${BOLD}Reload Window${NC} 使改动生效"
if [ -z "$REMOTE_HOST" ]; then
    echo -e "  ${YELLOW}→${NC} 连接远程后会自动重新部署"
fi
echo ""
