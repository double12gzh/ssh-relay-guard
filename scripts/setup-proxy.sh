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
#
# Note: Proxy address/type/rewrite are NOT checked here because the wrapper
# reads them from environment variables at runtime (multi-user isolation).
# Only the extension version triggers a wrapper rewrite.
check_needs_update() {
    local target="$1"
    
    # Check 1: Not a wrapper script (original binary) → needs wrapper creation
    if ! is_srg_wrapper "$target"; then
        # Check 1b: Was it previously a wrapper? (checksum sidecar exists but binary changed)
        # This detects IDE updates that replaced the wrapper with a fresh ELF binary.
        if [ -f "${target}.srg-checksum" ]; then
            echo "overwritten_by_ide"
        else
            echo "new_install"
        fi
        return 0
    fi
    
    # Check 2: Checksum mismatch → wrapper was tampered with
    if [ -f "${target}.srg-checksum" ]; then
        local saved_checksum
        saved_checksum=$(cat "${target}.srg-checksum" 2>/dev/null || echo "")
        local current_checksum
        current_checksum=$(md5sum "$target" 2>/dev/null | awk '{print $1}' || echo "")
        if [ -n "$saved_checksum" ] && [ -n "$current_checksum" ] && [ "$saved_checksum" != "$current_checksum" ]; then
            echo "checksum_mismatch"
            return 0
        fi
    fi

    # Check 3: Version mismatch → needs update (covers upgrade, downgrade, legacy)
    local wrapper_version=$(get_wrapper_version "$target")
    if [ "$EXTENSION_VERSION" != "$wrapper_version" ]; then
        echo "version:$wrapper_version->$EXTENSION_VERSION"
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
    
    # Multi-window safety: use flock to prevent concurrent writes to the same wrapper.
    # Falls back to mkdir-based atomic lock if flock is unavailable (POSIX mkdir is atomic).
    LOCK_FILE="${TARGET}.srg.lock"
    LOCK_DIR="${TARGET}.srg.lockdir"
    _SRG_USED_FLOCK=0
    if command -v flock >/dev/null 2>&1; then
        exec 9>"$LOCK_FILE"
        flock -w 10 9 || { warn_log "Could not acquire lock for $TARGET, skipping"; continue; }
        _SRG_USED_FLOCK=1
    else
        # mkdir is atomic on all POSIX systems — use as lock primitive
        _lock_attempts=0
        while ! mkdir "$LOCK_DIR" 2>/dev/null; do
            _lock_attempts=$((_lock_attempts + 1))
            if [ $_lock_attempts -ge 100 ]; then
                # Stale lock detection: if lockdir is older than 60s, force remove
                if [ -d "$LOCK_DIR" ]; then
                    _lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
                    if [ "$_lock_age" -gt 60 ]; then
                        warn_log "Removing stale lock for $TARGET (${_lock_age}s old)"
                        rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR"
                        continue
                    fi
                fi
                warn_log "Could not acquire mkdir lock for $TARGET after 10s, skipping"
                continue 2
            fi
            sleep 0.1
        done
        debug_log "Acquired mkdir lock for $TARGET"
    fi

    echo "----------------------------------------"
    echo "Target: $TARGET"
    BAK="${TARGET}.bak"
    
    # Check if update is needed
    if UPDATE_REASON=$(check_needs_update "$TARGET"); then
        info_log "Update needed: $UPDATE_REASON"
        
        # Log current wrapper state for debugging
        if is_srg_wrapper "$TARGET"; then
            debug_log "Current wrapper version: $(get_wrapper_version "$TARGET")"
        fi
    else
        # Already up-to-date
        info_log "Already up-to-date (v$EXTENSION_VERSION)"
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
    # Note: proxy addr/type/rewrite are NOT baked in — read from env at runtime
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

    # Write checksum sidecar for IDE overwrite detection.
    # If the IDE updates and replaces the wrapper with a fresh ELF binary,
    # the checksum won't match and the LS wrapper's self-check will trigger
    # a re-setup on next activation.
    CHECKSUM_FILE="${TARGET}.srg-checksum"
    md5sum "$TARGET" 2>/dev/null | awk '{print $1}' > "$CHECKSUM_FILE" || true

    info_log "Wrapper created successfully"
    info_log "  Version: $EXTENSION_VERSION"
    info_log "  Proxy: $PROXY_ADDR ($PROXY_TYPE)"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))

    # Release lock
    if [ "$_SRG_USED_FLOCK" = "1" ]; then
        rm -f "$LOCK_FILE"
        exec 9>&-
    else
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi

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
    # Emit JSON result before exit for structured parsing
    echo "SRG_RESULT:{\"status\":\"error\",\"configured\":0,\"skipped\":0,\"version\":\"$EXTENSION_VERSION\",\"proxy\":\"$PROXY_ADDR\"}"
    exit 1
fi

# ============================================================================
# Machine-readable JSON summary (parsed by remoteInstaller.ts)
# Keeps backward compatibility: human-readable output above is unchanged.
# ============================================================================
_SRG_STATUS="new_config"
if [ $CONFIGURED_COUNT -eq 0 ] && [ $SKIPPED_COUNT -gt 0 ]; then
    _SRG_STATUS="already_configured"
fi
echo "SRG_RESULT:{\"status\":\"$_SRG_STATUS\",\"configured\":$CONFIGURED_COUNT,\"skipped\":$SKIPPED_COUNT,\"version\":\"$EXTENSION_VERSION\",\"proxy\":\"$PROXY_ADDR\"}"
