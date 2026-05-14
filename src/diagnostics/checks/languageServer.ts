import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { execAsync, getMonitoredProcess } from '../../utils/processUtils';
import { IDE_SERVER_DIRS } from '../../utils/constants';
import { DiagnosticCheck } from '../healthChecker';
import { isWindowsEnvironmentError, deriveServerRoot } from './mgraftcp';

/**
 * Check language server wrapper configuration.
 */
export async function checkLanguageServerWrapper(extensionPath?: string): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'ls-wrapper',
		name: 'Language Server Wrapper',
		status: 'running',
	};

	try {
		const homeDir = os.homedir();

		if (isWindowsEnvironmentError(homeDir)) {
			check.status = 'error';
			check.message = 'Remote extension not installed on the remote server';
			check.suggestion = 'Please install "SSH Relay Guard" on the remote server.';
			return check;
		}

		const serverRoot = extensionPath ? deriveServerRoot(extensionPath) : null;
		const searchRoots = serverRoot
			? [serverRoot]
			: IDE_SERVER_DIRS.map((d) => `${homeDir}/${d}`);

		let targetPath = '';
		for (const root of searchRoots) {
			try {
				const { stdout } = await execAsync(
					`find "${root}" -type f -name "language_server_linux_*" 2>/dev/null | grep -v "\\.bak$" | head -1`,
				);
				if (stdout.trim()) {
					targetPath = stdout.trim();
					break;
				}
			} catch {
				/* not found in this root, try next */
			}
		}

		if (!targetPath) {
			check.status = 'warning';
			check.message = 'Language server binary not found';
			check.suggestion = 'This may be normal if the target extension is not installed.';
			return check;
		}

		const content = await fs.readFile(targetPath, 'utf-8');
		if (content.startsWith('#!/bin/bash') && content.includes('mgraftcp')) {
			check.status = 'success';

			let wrapperVersion = 'unknown';
			const versionMatch = content.match(/WRAPPER_VERSION="([^"]+)"/);
			if (versionMatch) {
				wrapperVersion = versionMatch[1];
			}

			let extensionVersion = 'unknown';
			if (extensionPath) {
				try {
					const packageJsonPath = path.join(extensionPath, 'package.json');
					const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
					const packageJson = JSON.parse(packageJsonContent);
					extensionVersion = packageJson.version || 'unknown';
				} catch {
					// Ignore error
				}
			}

			check.message = `Language server wrapper is configured (Wrapper v${wrapperVersion}, Extension v${extensionVersion})`;

			if (
				extensionVersion !== 'unknown' &&
				wrapperVersion !== 'unknown' &&
				wrapperVersion !== extensionVersion &&
				extensionVersion !== '__EXTENSION_VERSION_PLACEHOLDER__'
			) {
				check.status = 'warning';
				check.message += ' - Version mismatch, update recommended';
				check.suggestion =
					'Click 🔧 to run "Setup Remote Environment" and update the wrapper.';
				check.fixAction = 'setup';
			}
		} else {
			check.status = 'warning';
			check.message = 'Language server is not wrapped with mgraftcp';
			check.suggestion =
				'Click 🔧 to run "Setup Remote Environment" and configure the wrapper.';
			check.fixAction = 'setup';
		}
	} catch (error) {
		if (isWindowsEnvironmentError(String(error))) {
			check.status = 'error';
			check.message = 'Remote extension not installed on the remote server';
			check.suggestion = 'Please install "SSH Relay Guard" on the remote server.';
		} else {
			check.status = 'warning';
			check.message = `Could not verify wrapper: ${error}`;
			check.suggestion =
				'Click 🔧 to run "Setup Remote Environment" if language server proxy is needed.';
			check.fixAction = 'setup';
		}
	}

	return check;
}

/**
 * Check Language Server process status.
 */
export async function checkLanguageServerProcess(): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'ls-process',
		name: 'Language Server Process',
		status: 'running',
	};

	const proc = await getMonitoredProcess();

	if (!proc) {
		check.status = 'warning';
		check.message = 'Language Server is not running';
		check.suggestion =
			"This may be normal if you haven't used any AI features yet. The LS starts on demand.";
		return check;
	}

	const modeLabel = proc.isPersistent ? 'persistent mode' : 'normal mode';
	const proxyLabel = proc.isUsingProxy ? 'using proxy' : 'NOT using proxy';

	if (proc.isUsingProxy) {
		check.status = 'success';
	} else if (proc.isPersistent) {
		check.status = 'error';
		check.suggestion = `LS was started before proxy wrapper was configured. Click 🔧 to auto-fix (kill PID ${proc.pid} + reload).`;
		check.fixAction = 'killReload';
	} else {
		check.status = 'warning';
		check.suggestion = 'Click 🔧 to reload the window and restart LS with proxy support.';
		check.fixAction = 'reloadWindow';
	}

	check.message = `Language Server (PID ${proc.pid}) is running in ${modeLabel}, ${proxyLabel}`;
	return check;
}
