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
IDE_SERVER_DIRS=(".antigravity-ide-server" ".antigravity-server" ".vscode-server" ".cursor-server" ".windsurf-server")

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

# Extract rewrite cloudcode flag from a wrapper script
get_wrapper_rewrite_cloudcode() {
    local wrapper="$1"
    grep -oP 'REWRITE_CLOUDCODE="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Check if target is ANY bash script (broad check for backup safety)
# If the file starts with #!/bin/bash, it's NOT the original ELF binary
# and must NOT be backed up as .bak (regardless of who created it)
is_bash_script() {
    local target="$1"
    head -1 "$target" 2>/dev/null | grep -q "^#!/bin/bash"
}

# Check if target is specifically an SRG wrapper (strict check for version/update logic)
is_srg_wrapper() {
    local target="$1"
    is_bash_script "$target" \
        && grep -q "mgraftcp\|WRAPPER_VERSION" "$target" 2>/dev/null
}

# Determine if wrapper needs to be updated
# Returns: 0 = needs update (with reason in stdout), 1 = up-to-date
check_needs_update() {
    local target="$1"
    
    # Check 1: Not a wrapper script (original binary) → needs wrapper creation
    if ! is_srg_wrapper "$target"; then
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
    
    # Check 5: Rewrite CloudCode mismatch → needs update
    local wrapper_rewrite_cloudcode=$(get_wrapper_rewrite_cloudcode "$target")
    # Using REWRITE_CLOUDCODE string directly since we added sed substitution for it
    if [ "$REWRITE_CLOUDCODE" != "$wrapper_rewrite_cloudcode" ]; then
        echo "rewrite_cloudcode:$wrapper_rewrite_cloudcode->$REWRITE_CLOUDCODE"
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
    if [ -d "$HOME/$_d" ]; then
        _find_args+=("$HOME/$_d")
    fi
done
# Provide fallback to check at least something, preventing find error
if [ ${#_find_args[@]} -eq 0 ]; then
    _find_args+=("$HOME/.antigravity-ide-server" "$HOME/.antigravity-server" "$HOME/.vscode-server" "$HOME/.cursor-server" "$HOME/.windsurf-server")
fi
TARGETS=$(find "${_find_args[@]}" -type f -name "language_server_linux_*" 2>/dev/null | grep -v "\.bak$")

if [ -z "$TARGETS" ]; then
    error_log "No language servers found! Will continue to deploy tools."
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
        if is_srg_wrapper "$TARGET"; then
            debug_log "Current wrapper state:"
            debug_log "  Version: $(get_wrapper_version "$TARGET")"
            debug_log "  Proxy: $(get_wrapper_proxy_addr "$TARGET")"
            debug_log "  Type: $(get_wrapper_proxy_type "$TARGET")"
            debug_log "  Rewrite: $(get_wrapper_rewrite_cloudcode "$TARGET")"
        fi
    else
        # Already up-to-date
        info_log "Already up-to-date (v$EXTENSION_VERSION, $PROXY_ADDR, $PROXY_TYPE, Rewrite:$REWRITE_CLOUDCODE)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    # Create backup if needed
    if [ ! -f "$BAK" ]; then
        if is_bash_script "$TARGET"; then
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
__INJECT_LS_WRAPPER__

    # Replace placeholders with actual values
    sed -i "s|__PROXY_ADDR_PLACEHOLDER__|$PROXY_ADDR|g" "$TARGET"
    sed -i "s|__PROXY_TYPE_PLACEHOLDER__|$PROXY_TYPE|g" "$TARGET"
    sed -i "s|__EXTENSION_VERSION_PLACEHOLDER__|$EXTENSION_VERSION|g" "$TARGET"
    sed -i "s|__REWRITE_CLOUDCODE_PLACEHOLDER__|$REWRITE_CLOUDCODE|g" "$TARGET"
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

__INJECT_SRG_ON__
__INJECT_SRG_OFF__
__INJECT_SRG_PROXY__
__INJECT_SRG_STATUS__
__INJECT_SRG_SHELL__

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
