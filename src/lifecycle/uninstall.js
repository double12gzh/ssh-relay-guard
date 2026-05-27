/**
 * SSH Relay Guard — Uninstall Cleanup
 *
 * Runs automatically when the extension is uninstalled (via the IDE's
 * vscode:uninstall lifecycle hook). Cleans up local SSH config artifacts:
 *   1. Removes ~/.ssh/config.srg
 *   2. Removes the "Include config.srg" line from ~/.ssh/config
 *
 * NOTE: This script runs as a standalone Node.js process (no IDE API).
 * It executes on the NEXT Antigravity restart after uninstall.
 *
 * Remote artifacts (LS wrapper, ~/bin/srg-* tools, .bashrc functions) are
 * NOT cleaned up here because:
 *   - This script runs locally, with no SSH access to remote servers
 *   - The LS wrapper has a built-in fallback: if mgraftcp is missing,
 *     it executes the original binary directly (no breakage)
 *   - Remote tools (srg-on/off/proxy) are harmless without the tunnel
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRG_CONFIG_FILENAME = 'config.srg';
const INCLUDE_LINE = `Include ${SRG_CONFIG_FILENAME}`;
const sshDir = path.join(os.homedir(), '.ssh');
const srgConfigPath = path.join(sshDir, SRG_CONFIG_FILENAME);
const mainConfigPath = path.join(sshDir, 'config');

// 1. Remove config.srg
try {
    if (fs.existsSync(srgConfigPath)) {
        fs.unlinkSync(srgConfigPath);
    }
} catch (_) {
    // Ignore — file may already be deleted or permissions issue
}

// 2. Remove "Include config.srg" from ~/.ssh/config
try {
    if (fs.existsSync(mainConfigPath)) {
        let content = fs.readFileSync(mainConfigPath, 'utf-8');
        if (content.includes(INCLUDE_LINE)) {
            content = content.replace(`${INCLUDE_LINE}\n`, '');
            content = content.replace(INCLUDE_LINE, '');
            fs.writeFileSync(mainConfigPath, content, { mode: 0o600 });
        }
    }
} catch (_) {
    // Ignore — best-effort cleanup
}

// 3. Remove ~/.srg/ state directory (session port files, etc.)
try {
    const srgStateDir = path.join(os.homedir(), '.srg');
    fs.rmSync(srgStateDir, { recursive: true, force: true });
} catch (_) {
    // Ignore — directory may not exist or permissions issue
}
