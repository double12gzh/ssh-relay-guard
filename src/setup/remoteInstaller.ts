import * as fs from 'fs/promises';
import * as path from 'path';

// eslint-disable-next-line prefer-const
export let customReadFileForTesting:
	| ((path: string, encoding: string) => Promise<string>)
	| undefined = undefined;

/**
 * Build the remote setup script by reading the template and replacing placeholders.
 * @param proxyHost - Remote proxy host. Must be a valid hostname/IP.
 * @param proxyPort - Remote proxy port number.
 * @param extensionPath - Absolute path to the extension root (used to locate template).
 */
export async function buildInstallScript(
	proxyHost: string,
	proxyPort: number,
	rewriteCloudCode: boolean,
	extensionPath: string,
): Promise<string> {
	// Basic input validation to prevent shell injection
	if (!/^[\w.\-:]+$/.test(proxyHost)) {
		throw new Error(`Invalid proxy host: ${proxyHost}`);
	}

	const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');
	const read = customReadFileForTesting ?? fs.readFile;
	let script = await read(scriptPath, 'utf-8');

	// Dynamically inject tools from srg-cli/remote/ to avoid code duplication
	const buildCatCmd = async (filename: string) => {
		const filePath = path.join(extensionPath, 'srg-cli', 'remote', filename);
		let content = await read(filePath, 'utf-8');
		// Convert srg-cli placeholders to bash sed placeholders
		content = content.replace(/__SRG_PORT__/g, '__SRG_PORT_PH__');
		content = content.replace(/__SRG_TYPE__/g, '__SRG_TYPE_PH__');

		return (
			`cat > "$SRG_BIN_DIR/${filename}" << 'EOF'\n${content}\nEOF\n` +
			`sed -i "s|__SRG_PORT_PH__|$PROXY_PORT|g" "$SRG_BIN_DIR/${filename}"\n` +
			`sed -i "s|__SRG_TYPE_PH__|$PROXY_TYPE|g" "$SRG_BIN_DIR/${filename}"\n` +
			`chmod +x "$SRG_BIN_DIR/${filename}"\n` +
			`TOOLS_DEPLOYED=$((TOOLS_DEPLOYED + 1))`
		);
	};

	script = script.replace('__INJECT_SRG_ON__', await buildCatCmd('srg-on'));
	script = script.replace('__INJECT_SRG_OFF__', await buildCatCmd('srg-off'));
	script = script.replace('__INJECT_SRG_PROXY__', await buildCatCmd('srg-proxy'));
	script = script.replace('__INJECT_SRG_STATUS__', await buildCatCmd('srg-status'));
	script = script.replace('__INJECT_SRG_SHELL__', await buildCatCmd('srg-shell'));

	const lsWrapperPath = path.join(extensionPath, 'srg-cli', 'remote', 'ls-wrapper.sh');
	let lsWrapperContent = await read(lsWrapperPath, 'utf-8');
	// Convert srg-cli placeholders to bash sed placeholders
	// Note: __SRG_ADDR__ and __SRG_TYPE__ were removed from ls-wrapper.sh
	// for multi-user isolation (proxy config is now env-var only).
	lsWrapperContent = lsWrapperContent.replace(
		/__EXTENSION_BIN_PATH__/g,
		'__EXTENSION_BIN_PATH_PLACEHOLDER__',
	);

	// The wrapper requires some specific header comments that setup-proxy.sh sed replaces
	const wrapperPrefix =
		`cat > "$TARGET" << 'WRAPPER_EOF'\n` +
		`#!/bin/bash\n` +
		`# ============================================================================\n` +
		`# SSH Relay Guard (SRG) - Language Server Wrapper\n` +
		`# ============================================================================\n` +
		`# WRAPPER_VERSION="__EXTENSION_VERSION_PLACEHOLDER__"\n` +
		`# GENERATED="__TIMESTAMP_PLACEHOLDER__"\n` +
		`# ============================================================================\n`;

	// Strip the bash shebang from lsWrapperContent since we prepend our own header
	const cleanLsWrapperContent = lsWrapperContent.replace(/^#!\/bin\/bash\n/, '');

	const wrapperCmd = wrapperPrefix + cleanLsWrapperContent + `\nWRAPPER_EOF`;
	script = script.replace('__INJECT_LS_WRAPPER__', wrapperCmd);

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
