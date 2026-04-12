#!/bin/bash
set -e

# ============================================================================
# SSH Relay Guard (SRG) - Setup Script
# ============================================================================
# This script creates wrapper scripts for language servers to route their
# traffic through a proxy using mgraftcp-fakedns.
#
# Environment Variables:
#   PROXY_HOST       - Proxy server host (default: __PROXY_HOST__)
#   PROXY_PORT       - Proxy server port (default: __PROXY_PORT__)
#   PROXY_TYPE       - Proxy type: http or socks5 (default: __PROXY_TYPE__)
#   EXTENSION_PATH   - Current extension's exact path (optional)
#   EXTENSION_VERSION - Current extension version for update detection
#   DEBUG            - Set to 1 for verbose output
# ============================================================================

# Use environment variables with defaults
PROXY_HOST="${PROXY_HOST:-__PROXY_HOST__}"
PROXY_PORT="${PROXY_PORT:-__PROXY_PORT__}"
PROXY_TYPE="${PROXY_TYPE:-__PROXY_TYPE__}"
EXTENSION_PATH="${EXTENSION_PATH:-}"
EXTENSION_VERSION="${EXTENSION_VERSION:-unknown}"
PROXY_ADDR="${PROXY_HOST}:${PROXY_PORT}"

# Supported IDE server directories (add more to support other IDEs, e.g. .vscode-server)
IDE_SERVER_DIRS=(".antigravity-server")

# ============================================================================
# Debug Logging
# ============================================================================
DEBUG="${DEBUG:-0}"

debug_log() {
    if [ "$DEBUG" = "1" ]; then
        echo "[DEBUG] $*"
    fi
}

info_log() {
    echo "[INFO] $*"
}

warn_log() {
    echo "[WARN] $*"
}

error_log() {
    echo "[ERROR] $*"
}

# ============================================================================
# Header
# ============================================================================
echo "========================================"
echo "SSH Relay Guard (SRG) - Setup"
echo "========================================"
echo ""

# System info
ARCH=$(uname -m)
info_log "System Architecture: $ARCH"
info_log "Proxy Config: $PROXY_ADDR ($PROXY_TYPE)"
info_log "Extension Version: $EXTENSION_VERSION"
if [ -n "$EXTENSION_PATH" ]; then
    info_log "Extension Path: $EXTENSION_PATH"
fi
echo ""

# Determine expected binary names based on architecture
case "$ARCH" in
    x86_64|amd64) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-amd64"
        EXPECTED_LIB="libdnsredir-linux-amd64.so"
        ;;
    aarch64|arm64) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-arm64"
        EXPECTED_LIB="libdnsredir-linux-arm64.so"
        ;;
    *) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-$ARCH"
        EXPECTED_LIB="libdnsredir-linux-$ARCH.so"
        ;;
esac

debug_log "Expected Binary: $EXPECTED_BINARY"
debug_log "Expected Library: $EXPECTED_LIB"

# ============================================================================
# Scan for extension directories (for debugging)
# ============================================================================
if [ "$DEBUG" = "1" ]; then
    echo ""
    echo "[SCAN] Searching for extension directories..."
    _scan_dirs=()
    for _d in "${IDE_SERVER_DIRS[@]}"; do
        _scan_dirs+=($(ls -d "$HOME/$_d/extensions/"*ssh-relay-guard* 2>/dev/null || true))
    done
    EXT_DIRS=$(printf '%s\n' "${_scan_dirs[@]}" | sort -t'-' -k3 -V -r)
    if [ -n "$EXT_DIRS" ]; then
        echo "$EXT_DIRS" | while read -r dir; do
            echo "  📦 $dir"
            BIN_DIR="$dir/resources/bin"
            if [ -d "$BIN_DIR" ]; then
                for f in "$BIN_DIR"/*; do
                    [ -e "$f" ] || continue
                    fname=$(basename "$f")
                    if [ -x "$f" ]; then
                        echo "    ├── $fname ✅"
                    else
                        echo "    ├── $fname"
                    fi
                done
            fi
        done
    else
        echo "  ⚠️  No extension directories found!"
    fi
    echo ""
fi

# ============================================================================
# Helper Functions
# ============================================================================

# Extract wrapper version from a wrapper script
get_wrapper_version() {
    local wrapper="$1"
    grep -oP 'WRAPPER_VERSION="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Extract proxy address from a wrapper script
get_wrapper_proxy_addr() {
    local wrapper="$1"
    grep -oP 'PROXY_ADDR="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Extract proxy type from a wrapper script
get_wrapper_proxy_type() {
    local wrapper="$1"
    grep -oP 'PROXY_TYPE="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Check if target is a wrapper script (bash script)
is_wrapper_script() {
    local target="$1"
    head -1 "$target" 2>/dev/null | grep -q "^#!/bin/bash"
}

# Determine if wrapper needs to be updated
# Returns: 0 = needs update (with reason in stdout), 1 = up-to-date
check_needs_update() {
    local target="$1"
    
    # Check 1: Not a wrapper script (original binary) → needs wrapper creation
    if ! is_wrapper_script "$target"; then
        echo "new_install"
        return 0
    fi
    
    # Check 2: Version mismatch → needs update (covers upgrade, downgrade, legacy)
    local wrapper_version=$(get_wrapper_version "$target")
    if [ "$EXTENSION_VERSION" != "$wrapper_version" ]; then
        echo "version:$wrapper_version->$EXTENSION_VERSION"
        return 0
    fi
    
    # Check 3: Proxy address mismatch → needs update
    local wrapper_proxy_addr=$(get_wrapper_proxy_addr "$target")
    if [ "$PROXY_ADDR" != "$wrapper_proxy_addr" ]; then
        echo "proxy_addr:$wrapper_proxy_addr->$PROXY_ADDR"
        return 0
    fi
    
    # Check 4: Proxy type mismatch → needs update
    local wrapper_proxy_type=$(get_wrapper_proxy_type "$target")
    if [ "$PROXY_TYPE" != "$wrapper_proxy_type" ]; then
        echo "proxy_type:$wrapper_proxy_type->$PROXY_TYPE"
        return 0
    fi
    
    # All checks passed → up-to-date
    return 1
}

# ============================================================================
# Find Language Servers
# ============================================================================
echo "[SEARCH] Looking for language servers..."
_find_args=()
for _d in "${IDE_SERVER_DIRS[@]}"; do
    _find_args+=("$HOME/$_d/bin")
done
TARGETS=$(find "${_find_args[@]}" -path "*/extensions/*/bin/language_server_linux_*" -type f 2>/dev/null | grep -v ".bak$")

if [ -z "$TARGETS" ]; then
    error_log "No language servers found!"
    exit 1
fi

TARGET_COUNT=$(echo "$TARGETS" | wc -l)
info_log "Found $TARGET_COUNT language server(s)"
echo ""

# ============================================================================
# Process Each Language Server
# ============================================================================
CONFIGURED_COUNT=0
SKIPPED_COUNT=0

echo "[PROCESS] Configuring language servers..."
echo ""

while IFS= read -r TARGET; do
    [ -z "$TARGET" ] && continue
    
    echo "----------------------------------------"
    echo "Target: $TARGET"
    BAK="${TARGET}.bak"
    
    # Check if update is needed
    if UPDATE_REASON=$(check_needs_update "$TARGET"); then
        info_log "Update needed: $UPDATE_REASON"
        
        # Log current wrapper state for debugging
        if is_wrapper_script "$TARGET"; then
            debug_log "Current wrapper state:"
            debug_log "  Version: $(get_wrapper_version "$TARGET")"
            debug_log "  Proxy: $(get_wrapper_proxy_addr "$TARGET")"
            debug_log "  Type: $(get_wrapper_proxy_type "$TARGET")"
        fi
    else
        # Already up-to-date
        info_log "Already up-to-date (v$EXTENSION_VERSION, $PROXY_ADDR, $PROXY_TYPE)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    # Create backup if needed
    if [ ! -f "$BAK" ]; then
        if is_wrapper_script "$TARGET"; then
            error_log "Target is a wrapper script but no backup exists!"
            error_log "Cannot proceed without original binary backup"
            continue
        fi
        mv "$TARGET" "$BAK"
        info_log "Backup created: $BAK"
    else
        debug_log "Backup already exists: $BAK"
    fi

    # ========================================================================
    # Create Wrapper Script
    # ========================================================================
    # The wrapper script dynamically finds mgraftcp-fakedns at runtime,
    # allowing version upgrades without breaking existing wrappers.
    # ========================================================================
cat > "$TARGET" << 'WRAPPER_EOF'
#!/bin/bash
# ============================================================================
# SSH Relay Guard (SRG) - Language Server Wrapper
# ============================================================================
# WRAPPER_VERSION="__EXTENSION_VERSION_PLACEHOLDER__"
# GENERATED="__TIMESTAMP_PLACEHOLDER__"
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Proxy configuration - can be updated without replacing the wrapper
PROXY_ADDR="__PROXY_ADDR_PLACEHOLDER__"
PROXY_TYPE="__PROXY_TYPE_PLACEHOLDER__"
EXTENSION_BIN_PATH="__EXTENSION_BIN_PATH_PLACEHOLDER__"

# Dynamically find mgraftcp-fakedns and libdnsredir at runtime
find_binaries() {
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
    if [ -n "$EXTENSION_BIN_PATH" ] && [ -d "$EXTENSION_BIN_PATH" ]; then
        if [ -f "$EXTENSION_BIN_PATH/$binary_name" ]; then
            echo "$EXTENSION_BIN_PATH/$binary_name"
            if [ -f "$EXTENSION_BIN_PATH/$lib_name" ]; then
                echo "$EXTENSION_BIN_PATH/$lib_name"
            fi
            return 0
        fi
    fi
    
    # Method 2: Fallback - search in all versions (sorted by version, newest first)
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

# Get both paths
BINARIES=$(find_binaries)
MGRAFTCP_PATH=$(echo "$BINARIES" | head -1)
DNSREDIR_PATH=$(echo "$BINARIES" | tail -1)

if [ -z "$MGRAFTCP_PATH" ] || [ ! -f "$MGRAFTCP_PATH" ]; then
    # Fallback: run without proxy if mgraftcp not found
    exec "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi

chmod +x "$MGRAFTCP_PATH" 2>/dev/null || true

# Force Go programs to use cgo DNS resolver (required for LD_PRELOAD to work)
export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

# Select proxy argument based on proxy type
if [ "$PROXY_TYPE" = "socks5" ]; then
    exec "$MGRAFTCP_PATH" --socks5 "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
else
    # Default to http proxy
    exec "$MGRAFTCP_PATH" --http_proxy "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi
WRAPPER_EOF

    # Replace placeholders with actual values
    sed -i "s|__PROXY_ADDR_PLACEHOLDER__|$PROXY_ADDR|g" "$TARGET"
    sed -i "s|__PROXY_TYPE_PLACEHOLDER__|$PROXY_TYPE|g" "$TARGET"
    sed -i "s|__EXTENSION_VERSION_PLACEHOLDER__|$EXTENSION_VERSION|g" "$TARGET"
    sed -i "s|__TIMESTAMP_PLACEHOLDER__|$(date -Iseconds)|g" "$TARGET"
    
    # Set extension bin path if provided
    if [ -n "$EXTENSION_PATH" ]; then
        EXTENSION_BIN_DIR="$EXTENSION_PATH/resources/bin"
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__|$EXTENSION_BIN_DIR|g" "$TARGET"
    else
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__||g" "$TARGET"
    fi

    chmod +x "$TARGET"
    info_log "Wrapper created successfully"
    info_log "  Version: $EXTENSION_VERSION"
    info_log "  Proxy: $PROXY_ADDR ($PROXY_TYPE)"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))

done <<< "$TARGETS"

# ============================================================================
# Deploy SRG Remote Tools (srg-on, srg-off, srg-proxy, srg-status, srg-shell)
# ============================================================================
echo ""
echo "[TOOLS] Deploying SRG remote tools..."

SRG_BIN_DIR="$HOME/bin"
mkdir -p "$SRG_BIN_DIR"
TOOLS_DEPLOYED=0

# --- srg-on: Session-level proxy enable (source'd) ---
cat > "$SRG_BIN_DIR/srg-on" << 'SRG_ON_EOF'
#!/bin/bash
_SRG_PORT="__SRG_PORT_PH__"
_SRG_ADDR="127.0.0.1:$_SRG_PORT"

export HTTP_PROXY="http://$_SRG_ADDR"
export HTTPS_PROXY="http://$_SRG_ADDR"
export http_proxy="http://$_SRG_ADDR"
export https_proxy="http://$_SRG_ADDR"
export ALL_PROXY="socks5://$_SRG_ADDR"
export all_proxy="socks5://$_SRG_ADDR"
export NO_PROXY="localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
export no_proxy="localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

echo "✓ Proxy enabled (current shell)"
echo "  HTTP_PROXY=$HTTP_PROXY"
echo "  Use srg-off to disable | exit shell to auto-disable"
SRG_ON_EOF
sed -i "s|__SRG_PORT_PH__|$PROXY_PORT|g" "$SRG_BIN_DIR/srg-on"
chmod +x "$SRG_BIN_DIR/srg-on"
TOOLS_DEPLOYED=$((TOOLS_DEPLOYED + 1))

# --- srg-off: Session-level proxy disable (source'd) ---
cat > "$SRG_BIN_DIR/srg-off" << 'SRG_OFF_EOF'
#!/bin/bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
unset ALL_PROXY all_proxy
unset NO_PROXY no_proxy

echo "✓ Proxy disabled (current shell)"
SRG_OFF_EOF
chmod +x "$SRG_BIN_DIR/srg-off"
TOOLS_DEPLOYED=$((TOOLS_DEPLOYED + 1))

# --- srg-proxy: Process-level transparent proxy via mgraftcp ---
cat > "$SRG_BIN_DIR/srg-proxy" << 'SRG_PROXY_EOF'
#!/bin/bash
_SRG_PORT="__SRG_PORT_PH__"
_SRG_TYPE="__SRG_TYPE_PH__"
_SRG_ADDR="127.0.0.1:$_SRG_PORT"

MGRAFTCP="$HOME/bin/mgraftcp-fakedns"

if [ ! -x "$MGRAFTCP" ]; then
    echo "✗ mgraftcp-fakedns not found: $MGRAFTCP" >&2
    exit 1
fi

if [ $# -eq 0 ]; then
    echo "Usage: srg-proxy <command> [args...]"
    echo "Example: srg-proxy curl https://www.google.com"
    exit 1
fi

export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

if [ "$_SRG_TYPE" = "socks5" ]; then
    exec "$MGRAFTCP" --socks5 "$_SRG_ADDR" "$@"
else
    exec "$MGRAFTCP" --http_proxy "$_SRG_ADDR" "$@"
fi
SRG_PROXY_EOF
sed -i "s|__SRG_PORT_PH__|$PROXY_PORT|g" "$SRG_BIN_DIR/srg-proxy"
sed -i "s|__SRG_TYPE_PH__|$PROXY_TYPE|g" "$SRG_BIN_DIR/srg-proxy"
chmod +x "$SRG_BIN_DIR/srg-proxy"
TOOLS_DEPLOYED=$((TOOLS_DEPLOYED + 1))

# --- srg-status: Show proxy status ---
cat > "$SRG_BIN_DIR/srg-status" << 'SRG_STATUS_EOF'
#!/bin/bash
_SRG_PORT="__SRG_PORT_PH__"
_SRG_ADDR="127.0.0.1:$_SRG_PORT"

echo "SRG Proxy Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -n "${HTTP_PROXY:-}" ]; then
    echo -e "  \033[0;32m✓\033[0m Shell proxy: $HTTP_PROXY"
else
    echo -e "  \033[2m○\033[0m Shell proxy: off (use srg-on or srg-shell)"
fi
if timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$_SRG_PORT" 2>/dev/null; then
    echo -e "  \033[0;32m✓\033[0m SSH tunnel :$_SRG_PORT: reachable"
else
    echo -e "  \033[0;31m✗\033[0m SSH tunnel :$_SRG_PORT: unreachable"
fi
if [ -x "$HOME/bin/mgraftcp-fakedns" ]; then
    echo -e "  \033[0;32m✓\033[0m mgraftcp-fakedns: installed"
else
    echo -e "  \033[0;31m✗\033[0m mgraftcp-fakedns: not installed"
fi
_find_args_status=()
for _d in "${IDE_SERVER_DIRS[@]}"; do
    _find_args_status+=("$HOME/$_d/bin")
done
LS=$(find "${_find_args_status[@]}" -path "*/extensions/*/bin/language_server_linux_*" -type f 2>/dev/null | grep -v ".bak$" | head -1 || true)
if [ -n "$LS" ] && head -1 "$LS" 2>/dev/null | grep -q "^#!/bin/bash"; then
    echo -e "  \033[0;32m✓\033[0m LS Wrapper: configured"
elif [ -z "$LS" ]; then
    echo -e "  \033[2m○\033[0m LS Wrapper: LS not installed"
else
    echo -e "  \033[0;31m✗\033[0m LS Wrapper: not configured"
fi
if timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$_SRG_PORT" 2>/dev/null; then
    CODE=$(curl -x http://$_SRG_ADDR -s -o /dev/null -w "%{http_code}" --connect-timeout 5 https://www.google.com 2>/dev/null || echo "000")
    if [[ "$CODE" =~ ^(200|301|302)$ ]]; then
        echo -e "  \033[0;32m✓\033[0m External connectivity: HTTP $CODE"
    else
        echo -e "  \033[0;31m✗\033[0m External connectivity: HTTP $CODE"
    fi
fi
# 6. DNS pollution check
_TEST_DOMAIN="daily-cloudcode-pa.googleapis.com"
_SYS_IP=$(dig +short "$_TEST_DOMAIN" 2>/dev/null | head -1 || true)
if [ -n "$_SYS_IP" ]; then
    _TRUSTED_IP=$(dig +short "$_TEST_DOMAIN" @8.8.8.8 2>/dev/null | head -1 || true)
    if [ -n "$_TRUSTED_IP" ]; then
        if [ "$_SYS_IP" = "$_TRUSTED_IP" ]; then
            echo -e "  \033[0;32m✓\033[0m DNS: clean ($_TEST_DOMAIN → $_SYS_IP)"
        else
            # Check if both are Google IPs (CDN difference is OK)
            _SYS_OK=$(echo "$_SYS_IP" | grep -cE '^(142\.250\.|172\.217\.|216\.58\.|74\.125\.|173\.194\.|108\.177\.)' || true)
            _TRU_OK=$(echo "$_TRUSTED_IP" | grep -cE '^(142\.250\.|172\.217\.|216\.58\.|74\.125\.|173\.194\.|108\.177\.)' || true)
            if [ "$_SYS_OK" -gt 0 ] && [ "$_TRU_OK" -gt 0 ]; then
                echo -e "  \033[0;32m✓\033[0m DNS: OK ($_SYS_IP, CDN diff from $_TRUSTED_IP)"
            else
                echo -e "  \033[0;31m✗\033[0m DNS: POLLUTED ($_TEST_DOMAIN → $_SYS_IP, should be $_TRUSTED_IP)"
                echo -e "    \033[2m修复方式:\033[0m"
                echo -e "    \033[2m  LS 自动补全: 已由 mgraftcp-fakedns wrapper 绕过 (无需操作)\033[0m"
                echo -e "    \033[2m  终端命令:    srg-on → curl/pip/npm 自动走代理DNS\033[0m"
                echo -e "    \033[2m  顽固程序:    srg-proxy <cmd> → 透明代理+FakeDNS\033[0m"
            fi
        fi
    else
        # Can't reach 8.8.8.8, check against known Google prefixes
        _SYS_OK=$(echo "$_SYS_IP" | grep -cE '^(142\.250\.|172\.217\.|216\.58\.|74\.125\.|173\.194\.|108\.177\.)' || true)
        if [ "$_SYS_OK" -gt 0 ]; then
            echo -e "  \033[0;32m✓\033[0m DNS: likely clean ($_SYS_IP matches Google range)"
        else
            echo -e "  \033[0;33m⚠\033[0m DNS: suspicious ($_SYS_IP not a known Google IP)"
        fi
    fi
else
    echo -e "  \033[2m○\033[0m DNS: dig not available (install dnsutils to check)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
SRG_STATUS_EOF
sed -i "s|__SRG_PORT_PH__|$PROXY_PORT|g" "$SRG_BIN_DIR/srg-status"
chmod +x "$SRG_BIN_DIR/srg-status"
TOOLS_DEPLOYED=$((TOOLS_DEPLOYED + 1))

# --- srg-shell: Sub-shell with proxy ---
cat > "$SRG_BIN_DIR/srg-shell" << 'SRG_SHELL_EOF'
#!/bin/bash
_SRG_PORT="__SRG_PORT_PH__"
_SRG_ADDR="127.0.0.1:$_SRG_PORT"

if ! timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$_SRG_PORT" 2>/dev/null; then
    echo "⚠ Proxy port $_SRG_PORT unreachable, SSH tunnel may not be established"
    echo ""
fi

export HTTP_PROXY="http://$_SRG_ADDR"
export HTTPS_PROXY="http://$_SRG_ADDR"
export http_proxy="http://$_SRG_ADDR"
export https_proxy="http://$_SRG_ADDR"
export ALL_PROXY="socks5://$_SRG_ADDR"
export all_proxy="socks5://$_SRG_ADDR"
export NO_PROXY="localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
export no_proxy="localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

echo "✓ Entered proxy shell (type exit to leave, proxy auto-disabled)"
echo "  HTTP_PROXY=$HTTP_PROXY"
echo ""

SRG_PS1="(srg) " exec bash --rcfile <(
    [ -f "$HOME/.bashrc" ] && cat "$HOME/.bashrc"
    echo 'export PS1="(srg) $PS1"'
)
SRG_SHELL_EOF
sed -i "s|__SRG_PORT_PH__|$PROXY_PORT|g" "$SRG_BIN_DIR/srg-shell"
chmod +x "$SRG_BIN_DIR/srg-shell"
TOOLS_DEPLOYED=$((TOOLS_DEPLOYED + 1))

info_log "$TOOLS_DEPLOYED SRG tools deployed to ~/bin/"

# ============================================================================
# Inject Shell Functions (.bashrc / .zshrc)
# ============================================================================
SRG_SHELL_MARKER="# --- SRG Shell Functions ---"
SRG_SHELL_MARKER_END="# --- SRG Shell Functions END ---"

inject_shell_functions() {
    local profile="$1"
    [ -f "$profile" ] || return 0

    # Remove old SRG block (idempotent update)
    if grep -q "$SRG_SHELL_MARKER" "$profile" 2>/dev/null; then
        sed -i "/$SRG_SHELL_MARKER/,/$SRG_SHELL_MARKER_END/d" "$profile"
    fi

    # Append new block
    cat >> "$profile" << FUNC_EOF
$SRG_SHELL_MARKER
# SRG convenience functions (proxy off by default, enable on demand)
srg-on()  { source "\$HOME/bin/srg-on"; }
srg-off() { source "\$HOME/bin/srg-off"; }
$SRG_SHELL_MARKER_END
FUNC_EOF
}

inject_shell_functions "$HOME/.bashrc"
[ -f "$HOME/.zshrc" ] && inject_shell_functions "$HOME/.zshrc"

# Ensure ~/bin is in PATH
if ! grep -q 'PATH="$HOME/bin' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/bin:$PATH"' >> "$HOME/.bashrc"
fi

info_log "Shell functions injected"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "========================================"
echo "Setup Summary"
echo "========================================"
echo "  Extension Version: $EXTENSION_VERSION"
echo "  Proxy Address: $PROXY_ADDR"
echo "  Proxy Type: $PROXY_TYPE"
echo "----------------------------------------"
if [ $CONFIGURED_COUNT -gt 0 ]; then
    echo "  ✅ Configured: $CONFIGURED_COUNT wrapper(s) created/updated"
fi
if [ $SKIPPED_COUNT -gt 0 ]; then
    echo "  ⏭️  Skipped: $SKIPPED_COUNT wrapper(s) already up-to-date"
fi
echo "  🔧 SRG Tools: $TOOLS_DEPLOYED tools deployed to ~/bin/"
echo "========================================"
echo ""
echo "Available remote commands:"
echo "  srg-on       Enable proxy (current shell)"
echo "  srg-off      Disable proxy (current shell)"
echo "  srg-shell    Proxy sub-shell (exit to disable)"
echo "  srg-proxy    Transparent proxy for single command"
echo "  srg-status   Show proxy status"

if [ $CONFIGURED_COUNT -gt 0 ]; then
    echo ""
    echo "Setup complete: proxy=$PROXY_ADDR"
    echo "Note: Reload window to apply changes to language server."
elif [ $SKIPPED_COUNT -gt 0 ]; then
    echo ""
    echo "Already configured with $PROXY_ADDR (v$EXTENSION_VERSION)"
else
    echo ""
    error_log "No language servers were configured!"
    exit 1
fi
