import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { execAsync } from '../../utils/processUtils';
import { IDE_SERVER_DIRS } from '../../utils/constants';
import { DiagnosticCheck } from '../healthChecker';

/**
 * Returns true when running inside a Windows-based environment
 * that was mistakenly detected as Linux (e.g. Windows paths on
 * a Linux extension host). Used to guard remote-only checks.
 */
export function isWindowsEnvironmentError(input: string): boolean {
	return (
		input.includes(':\\\\') || input.includes('\\\\Users\\\\') || input.includes('系统找不到')
	);
}

/**
 * Derive the IDE server root from extensionPath.
 * e.g. "~/.antigravity-server/extensions/srg-1.0.0" → "~/.antigravity-server"
 * Returns null if the path doesn't match the expected pattern.
 */
export function deriveServerRoot(extensionPath: string): string | null {
	const extIdx = extensionPath.indexOf('/extensions/');
	if (extIdx > 0) {
		return extensionPath.substring(0, extIdx);
	}
	return null;
}

/**
 * Check mgraftcp-fakedns availability.
 * Uses the exact extension path for precise detection.
 */
export async function checkMgraftcp(extensionPath?: string): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'mgraftcp',
		name: 'mgraftcp-fakedns Binary',
		status: 'running',
	};

	try {
		const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
		// Use the correct binary name: mgraftcp-fakedns (not mgraftcp)
		const binaryName = `mgraftcp-fakedns-linux-${arch}`;
		const libName = `libdnsredir-linux-${arch}.so`;
		const homeDir = os.homedir();

		if (isWindowsEnvironmentError(homeDir)) {
			check.status = 'error';
			check.message = 'Remote extension not installed on the remote server';
			check.suggestion =
				'Please install "SSH Relay Guard" on the remote server: Open Extensions (Ctrl+Shift+X), search "SSH Relay Guard", click "Install in SSH: <host>".';
			return check;
		}

		let binaryPath = '';
		let libPath = '';

		// Method 1: Use exact extension path if provided (preferred)
		if (extensionPath) {
			const exactBinaryPath = path.join(extensionPath, 'resources', 'bin', binaryName);
			const exactLibPath = path.join(extensionPath, 'resources', 'bin', libName);
			try {
				await fs.access(exactBinaryPath, fs.constants.X_OK);
				binaryPath = exactBinaryPath;
				try {
					await fs.access(exactLibPath, fs.constants.R_OK);
					libPath = exactLibPath;
				} catch {
					// Lib file is optional
				}
			} catch {
				// Binary not found or not executable at exact path, fall through to search
			}
		}

		// Method 2: Fallback - search in server root (sorted by version, newest first)
		if (!binaryPath) {
			// Derive server root from extensionPath, fall back to known IDE directories
			const serverRoot = extensionPath ? deriveServerRoot(extensionPath) : null;
			const searchRoots = serverRoot
				? [serverRoot]
				: IDE_SERVER_DIRS.map((d) => `${homeDir}/${d}`);

			for (const root of searchRoots) {
				try {
					const { stdout } = await execAsync(
						`ls ${root}/extensions/*ssh-relay-guard*/resources/bin/${binaryName} 2>/dev/null | sort -V -r | head -1`,
					);
					const found = stdout.trim();
					if (found) {
						await fs.access(found, fs.constants.X_OK);
						binaryPath = found;
						break;
					}
				} catch {
					/* not found in this root, try next */
				}
			}
		}

		if (binaryPath) {
			check.status = 'success';
			if (libPath) {
				check.message = `mgraftcp-fakedns found at ${binaryPath} (with libdnsredir)`;
			} else {
				check.message = `mgraftcp-fakedns found at ${binaryPath}`;
			}
		} else {
			check.status = 'error';
			check.message = 'mgraftcp-fakedns binary not found';
			check.suggestion =
				'Please install "SSH Relay Guard" on the remote server: Open Extensions (Ctrl+Shift+X), search "SSH Relay Guard", click "Install in SSH: <host>".';
		}
	} catch (error) {
		check.status = 'error';
		check.message = isWindowsEnvironmentError(String(error))
			? 'Remote extension not installed on the remote server'
			: `Error checking mgraftcp-fakedns: ${error}`;
		check.suggestion =
			'Please install "SSH Relay Guard" on the remote server: Open Extensions (Ctrl+Shift+X), search "SSH Relay Guard", click "Install in SSH: <host>".';
	}

	return check;
}
