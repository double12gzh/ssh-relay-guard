import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Build the remote setup script by reading the template and replacing placeholders.
 * @param proxyHost - Remote proxy host. Must be a valid hostname/IP.
 * @param proxyPort - Remote proxy port number.
 * @param extensionPath - Absolute path to the extension root (used to locate template).
 */
export async function buildInstallScript(proxyHost: string, proxyPort: number, extensionPath: string): Promise<string> {
    // Basic input validation to prevent shell injection
    if (!/^[\w.\-:]+$/.test(proxyHost)) {
        throw new Error(`Invalid proxy host: ${proxyHost}`);
    }

    const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');
    let script = await fs.readFile(scriptPath, 'utf-8');

    // Replace placeholders
    script = script.replace(/__PROXY_HOST__/g, proxyHost);
    script = script.replace(/__PROXY_PORT__/g, String(proxyPort));

    return script;
}

export function buildRestoreScript(): string {
    // Currently only searches .antigravity-server.
    // To support more IDEs, add their server directories to the find command.
    return `#!/bin/bash
set -e

# Find all backup files and restore them in multiple IDE server directories
BAKS=$(find "$HOME" -maxdepth 3 -type f -path "*/.antigravity-server/*" -name "language_server_linux_*.bak" -o -path "*/.vscode-server/*" -name "language_server_linux_*.bak" -o -path "*/.cursor-server/*" -name "language_server_linux_*.bak" -o -path "*/.windsurf-server/*" -name "language_server_linux_*.bak" 2>/dev/null || true)
[ -z "$BAKS" ] && echo "Nothing to rollback" && exit 0

RESTORED=0
while IFS= read -r BAK; do
    [ -z "$BAK" ] && continue
TARGET="\${BAK%.bak}"
    echo "Restoring: $TARGET"
[ -f "$TARGET" ] && rm -f "$TARGET"
mv "$BAK" "$TARGET"
    RESTORED=$((RESTORED + 1))
done <<< "$BAKS"

echo "Rollback complete: $RESTORED file(s) restored"
`;
}
