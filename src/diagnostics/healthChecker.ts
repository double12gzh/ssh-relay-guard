import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { isPortReachable, isRunningLocally } from '../utils/portProbe';
import { getMonitoredProcess, execAsync } from '../utils/processUtils';
import { ConfigService } from '../core/configService';
import { getSSHConfigPath } from '../core/sshConfigManager';

/** Known Google IP prefixes for CDN/API endpoints. */
const GOOGLE_IP_PREFIXES = ['142.250.', '172.217.', '216.58.', '74.125.', '173.194.', '108.177.'];

/**
 * Returns true when running inside a Windows-based environment
 * that was mistakenly detected as Linux (e.g. Windows paths on
 * a Linux extension host). Used to guard remote-only checks.
 */
function isWindowsEnvironmentError(input: string): boolean {
	return (
		input.includes(':\\\\') || input.includes('\\\\Users\\\\') || input.includes('系统找不到')
	);
}

/**
 * Known IDE server directory patterns.
 * Currently only Antigravity is supported. To add more IDEs (VS Code, Cursor, etc.),
 * append their server directory names here (e.g. '.vscode-server', '.cursor-server').
 */
const IDE_SERVER_DIRS = [
	'.antigravity-ide-server',
	'.antigravity-server',
	'.vscode-server',
	'.cursor-server',
	'.windsurf-server',
];

/**
 * Derive the IDE server root from extensionPath.
 * e.g. "~/.antigravity-server/extensions/srg-1.0.0" → "~/.antigravity-server"
 * Returns null if the path doesn't match the expected pattern.
 */
function deriveServerRoot(extensionPath: string): string | null {
	const extIdx = extensionPath.indexOf('/extensions/');
	if (extIdx > 0) {
		return extensionPath.substring(0, extIdx);
	}
	return null;
}

export interface DiagnosticCheck {
	id: string;
	name: string;
	status: 'pending' | 'running' | 'success' | 'warning' | 'error';
	message?: string;
	suggestion?: string;
	/**
	 * Machine-readable action for one-click fix. Rendered as a 🔧 button in the panel.
	 * Values: 'setup', 'enableForwarding', 'killReload', 'reloadWindow',
	 *         'switchProtocol:<type>', 'copyCommand:<text>'
	 */
	fixAction?: string;
	// For external connectivity check - protocol test results
	protocolResults?: ProtocolTestResult[];
	currentProtocol?: string;
}

export interface ProtocolTestResult {
	protocol: 'http' | 'socks5';
	success: boolean;
	httpCode?: string;
	error?: string;
	isCurrent: boolean;
}

export interface DiagnosticReport {
	timestamp: Date;
	checks: DiagnosticCheck[];
	overallStatus: 'healthy' | 'degraded' | 'broken';
}

type ProgressCallback = (checks: DiagnosticCheck[]) => void;

/**
 * Check local proxy service
 */
async function checkLocalProxy(localProxyPort: number): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'local-proxy',
		name: 'Local Proxy Service',
		status: 'running',
	};

	try {
		const reachable = await isPortReachable('127.0.0.1', localProxyPort, 3000);
		if (reachable) {
			check.status = 'success';
			check.message = `Local proxy is running on port ${localProxyPort}`;
		} else {
			check.status = 'error';
			check.message = `Cannot connect to local proxy on port ${localProxyPort}`;
			check.suggestion =
				'Please ensure your local proxy (e.g., Clash, V2Ray) is running and listening on the configured port.';
		}
	} catch (error) {
		check.status = 'error';
		check.message = `Error checking local proxy: ${error}`;
		check.suggestion = 'Please check if your proxy software is installed and running.';
	}

	return check;
}

/**
 * Check SSH config for RemoteForward
 */
async function checkSSHConfig(remoteProxyPort: number): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'ssh-config',
		name: 'SSH Configuration',
		status: 'running',
	};

	try {
		const configPath = getSSHConfigPath();
		const content = await fs.readFile(configPath, 'utf-8');

		if (content.includes('Include config.srg')) {
			// Current format: per-host blocks in config.srg
			const srgConfigPath = path.join(os.homedir(), '.ssh', 'config.srg');
			try {
				const srgContent = await fs.readFile(srgConfigPath, 'utf-8');

				// Find all configured hosts
				const hostPattern = /^# --- SRG:(.*?) ---$/gm;
				const hosts: string[] = [];
				let m;
				while ((m = hostPattern.exec(srgContent)) !== null) {
					if (!m[1].endsWith(' END')) {
						hosts.push(m[1]);
					}
				}

				if (hosts.length === 0) {
					check.status = 'error';
					check.message = 'config.srg exists but has no host blocks configured';
					check.suggestion =
						'Click 🔧 to open "Add Host Forwarding" and configure a host.';
					check.fixAction = 'enableForwarding';
				} else {
					// Check if any host has the expected remotePort
					const portMatches = [
						...srgContent.matchAll(/# SRG_REMOTE_PORT=(\d+)/g),
						...srgContent.matchAll(/RemoteForward\s+(\d+)/g),
					];
					const configuredPorts = portMatches.map((pm) => parseInt(pm[1]));
					const hasExpectedPort = configuredPorts.includes(remoteProxyPort);

					if (hasExpectedPort) {
						check.status = 'success';
						check.message = `SSH Proxy Port configured as ${remoteProxyPort} (${hosts.length} host(s): ${hosts.join(', ')})`;
					} else if (configuredPorts.length > 0) {
						check.status = 'warning';
						check.message = `Proxy Port mismatch: configured [${configuredPorts.join(', ')}], expected ${remoteProxyPort}`;
						check.suggestion =
							'Update port in SRG panel or run "Add Host Forwarding" command.';
					} else {
						check.status = 'error';
						check.message = 'Proxy Port configuration not found in config.srg';
						check.suggestion =
							'Click 🔧 to open "Add Host Forwarding" and configure SSH.';
						check.fixAction = 'enableForwarding';
					}
				}
			} catch {
				check.status = 'error';
				check.message = 'config.srg file not found despite Include line in ~/.ssh/config';
				check.suggestion =
					'Click 🔧 to open "Add Host Forwarding" and recreate SSH configuration.';
				check.fixAction = 'enableForwarding';
			}
		} else {
			check.status = 'error';
			check.message = 'SSH config does not include config.srg';
			check.suggestion = 'Click 🔧 to open "Add Host Forwarding" and configure SSH.';
			check.fixAction = 'enableForwarding';
		}
	} catch {
		check.status = 'error';
		check.message = 'Cannot read SSH config file';
		check.suggestion = 'Ensure ~/.ssh/config exists and is readable.';
	}

	return check;
}

/**
 * Check remote port forwarding
 */
async function checkRemotePortForward(
	remoteProxyHost: string,
	remoteProxyPort: number,
	localProxyPort: number,
): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'remote-forward',
		name: 'Remote Port Forwarding',
		status: 'running',
	};

	try {
		const reachable = await isPortReachable(remoteProxyHost, remoteProxyPort, 3000);
		if (reachable) {
			check.status = 'success';
			check.message = `Remote proxy port ${remoteProxyHost}:${remoteProxyPort} is reachable`;
		} else {
			check.status = 'error';
			check.message = `Cannot connect to ${remoteProxyHost}:${remoteProxyPort}`;
			check.suggestion = `Run on LOCAL terminal: ssh -fN -R ${remoteProxyPort}:127.0.0.1:${localProxyPort} &lt;your-host&gt;`;
			check.fixAction = `copyCommand:ssh -fN -R ${remoteProxyPort}:127.0.0.1:${localProxyPort} <your-host>`;
		}
	} catch (error) {
		check.status = 'error';
		check.message = `Error checking remote port: ${error}`;
		check.suggestion = `Run on LOCAL terminal: ssh -fN -R ${remoteProxyPort}:127.0.0.1:${localProxyPort} &lt;your-host&gt;`;
	}

	return check;
}

/**
 * Check mgraftcp-fakedns availability
 * Uses the exact extension path for precise detection
 */
async function checkMgraftcp(extensionPath?: string): Promise<DiagnosticCheck> {
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

/**
 * Check language server wrapper
 */
async function checkLanguageServerWrapper(extensionPath?: string): Promise<DiagnosticCheck> {
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
			check.suggestion =
				'Please install "SSH Relay Guard" on the remote server: Open Extensions (Ctrl+Shift+X), search "SSH Relay Guard", click "Install in SSH: <host>".';
			return check;
		}

		// Derive server root from extensionPath, fall back to known IDE directories
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

		// Check if it's a wrapper script
		const content = await fs.readFile(targetPath, 'utf-8');
		if (content.startsWith('#!/bin/bash') && content.includes('mgraftcp')) {
			check.status = 'success';

			// Extract wrapper version
			let wrapperVersion = 'unknown';
			const versionMatch = content.match(/WRAPPER_VERSION="([^"]+)"/);
			if (versionMatch) {
				wrapperVersion = versionMatch[1];
			}

			// Get extension version
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

			// Warn if versions mismatch
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
			check.suggestion =
				'Please install "SSH Relay Guard" on the remote server: Open Extensions (Ctrl+Shift+X), search "SSH Relay Guard", click "Install in SSH: <host>".';
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
 * Delegates to processUtils.getMonitoredProcess() to avoid duplicating
 * the `ps aux | grep language_server_linux` parsing logic.
 */
async function checkLanguageServerProcess(): Promise<DiagnosticCheck> {
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
		// Persistent mode but not using proxy — this is the known bug scenario
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

/**
 * Check external connectivity through proxy
 * Tests both HTTP and SOCKS5 protocols and reports availability of each
 */
async function checkExternalConnectivity(
	remoteProxyHost: string,
	remoteProxyPort: number,
	currentProxyType: string,
): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'external-connectivity',
		name: 'External Connectivity',
		status: 'running',
		currentProtocol: currentProxyType,
	};

	// Test both protocols in parallel
	const protocols: Array<'http' | 'socks5'> = ['http', 'socks5'];

	const testProtocol = async (protocol: 'http' | 'socks5'): Promise<ProtocolTestResult> => {
		const result: ProtocolTestResult = {
			protocol,
			success: false,
			isCurrent: protocol === currentProxyType,
		};

		try {
			const { stdout } = await execAsync(
				`curl -x ${protocol}://${remoteProxyHost}:${remoteProxyPort} https://www.google.com -o /dev/null -s -w "%{http_code}" --connect-timeout 10`,
				{ timeout: 15000 },
			);
			const httpCode = stdout.trim();

			if (httpCode === '200' || httpCode === '301' || httpCode === '302') {
				result.success = true;
				result.httpCode = httpCode;
			} else {
				result.error = `HTTP ${httpCode}`;
			}
		} catch {
			result.error = 'Connection failed';
		}

		return result;
	};

	const results = await Promise.all(protocols.map(testProtocol));

	check.protocolResults = results;

	// Determine status based on current protocol and available protocols
	const currentResult = results.find((r) => r.isCurrent);
	const anySuccess = results.some((r) => r.success);
	const currentSuccess = currentResult?.success ?? false;

	if (currentSuccess) {
		// Current protocol works
		check.status = 'success';
		const availableCount = results.filter((r) => r.success).length;
		check.message = `Current protocol (${currentProxyType.toUpperCase()}) is working. ${availableCount}/${protocols.length} protocols available.`;
	} else if (anySuccess) {
		// Current protocol doesn't work, but others do
		check.status = 'warning';
		const workingProtocols = results
			.filter((r) => r.success)
			.map((r) => r.protocol)
			.join(', ');
		const firstWorking = results.find((r) => r.success);
		check.message = `Current protocol (${currentProxyType.toUpperCase()}) is not working.`;
		check.suggestion = `Click 🔧 to switch to ${workingProtocols.toUpperCase()} which is available.`;
		if (firstWorking) {
			check.fixAction = `switchProtocol:${firstWorking.protocol}`;
		}
	} else {
		// No protocols work
		check.status = 'error';
		check.message = 'No proxy protocol is working.';
		check.suggestion =
			'Check if the proxy is properly forwarding traffic. Verify your local proxy has internet access.';
	}

	return check;
}

/**
 * Check for DNS pollution by comparing system DNS vs trusted DNS (8.8.8.8).
 * DNS pollution is a common issue in restricted networks where DNS queries
 * return incorrect IPs, causing TLS certificate mismatch errors.
 */
async function checkDNSPollution(): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'dns-pollution',
		name: 'DNS Pollution Detection',
		status: 'running',
	};

	const testDomain = 'daily-cloudcode-pa.googleapis.com';
	let systemIP = '';
	let trustedIP = '';

	try {
		// Get system DNS resolution
		try {
			const { stdout } = await execAsync(
				`dig +short ${testDomain} 2>/dev/null | head -1 || nslookup ${testDomain} 2>/dev/null | grep -A1 'Name:' | grep 'Address:' | awk '{print $2}' | head -1`,
				{ timeout: 5000 },
			);
			systemIP = stdout.trim().split('\n')[0].trim();
		} catch {
			// dig/nslookup not available
		}

		if (!systemIP) {
			check.status = 'warning';
			check.message = 'Cannot resolve DNS (dig/nslookup not available)';
			check.suggestion = 'Install dnsutils to enable DNS pollution detection';
			return check;
		}

		// Get trusted DNS resolution (Google Public DNS)
		try {
			const { stdout } = await execAsync(
				`dig +short ${testDomain} @8.8.8.8 2>/dev/null | head -1`,
				{ timeout: 5000 },
			);
			trustedIP = stdout.trim().split('\n')[0].trim();
		} catch {
			// Can't reach 8.8.8.8 (likely blocked)
		}

		if (!trustedIP) {
			// Fallback: check if the system IP is in known-good Google ranges
			const isLikelyGoogle = GOOGLE_IP_PREFIXES.some((p) => systemIP.startsWith(p));

			if (isLikelyGoogle) {
				check.status = 'success';
				check.message = `DNS OK: ${testDomain} → ${systemIP} (matches Google IP range)`;
			} else {
				check.status = 'warning';
				check.message = `DNS suspicious: ${testDomain} → ${systemIP} (not a known Google IP)`;
				check.suggestion =
					'Cannot verify against trusted DNS (8.8.8.8 blocked). Ensure mgraftcp-fakedns is working for LS traffic.';
			}
			return check;
		}

		// Compare system DNS vs trusted DNS
		if (systemIP === trustedIP) {
			check.status = 'success';
			check.message = `DNS clean: ${testDomain} → ${systemIP}`;
		} else {
			// Check if both resolve to Google ranges (CDN can return different IPs)
			const systemIsGoogle = GOOGLE_IP_PREFIXES.some((p) => systemIP.startsWith(p));
			const trustedIsGoogle = GOOGLE_IP_PREFIXES.some((p) => trustedIP.startsWith(p));

			if (systemIsGoogle && trustedIsGoogle) {
				check.status = 'success';
				check.message = `DNS OK: ${testDomain} → ${systemIP} (CDN, trusted: ${trustedIP})`;
			} else {
				check.status = 'error';
				check.message = `DNS POLLUTED: ${testDomain} → ${systemIP} (trusted: ${trustedIP})`;
				check.suggestion =
					'DNS is poisoned — but each layer already has a bypass: ' +
					'(1) LS autocomplete: mgraftcp-fakedns wrapper handles it automatically. ' +
					'(2) Terminal (curl/pip/npm): run "srg-on" to set HTTP_PROXY → proxy resolves DNS. ' +
					'(3) Resistant programs: run "srg-proxy <cmd>" for transparent proxy with FakeDNS.';
			}
		}
	} catch (error) {
		check.status = 'warning';
		check.message = `DNS check failed: ${error}`;
	}

	return check;
}

/**
 * Run all diagnostic checks
 * @param configService - Centralized configuration service
 * @param onProgress - Optional callback for progress updates
 * @param extensionPath - Optional path to the current extension for precise binary detection
 */
export async function runDiagnostics(
	configService: ConfigService,
	onProgress?: ProgressCallback,
	extensionPath?: string,
): Promise<DiagnosticReport> {
	const localProxyPort = configService.localProxyPort;
	const remoteProxyPort = configService.remoteProxyPort;
	const remoteProxyHost = configService.remoteProxyHost;
	const proxyType = configService.proxyType;
	const isLocal = isRunningLocally();

	// Initialize all checks as pending
	const checks: DiagnosticCheck[] = [
		{ id: 'local-proxy', name: 'Local Proxy Service', status: 'pending' },
		{ id: 'ssh-config', name: 'SSH Configuration', status: 'pending' },
		{ id: 'remote-forward', name: 'Remote Port Forwarding', status: 'pending' },
		{ id: 'mgraftcp', name: 'mgraftcp-fakedns Binary', status: 'pending' },
		{ id: 'ls-wrapper', name: 'Language Server Wrapper', status: 'pending' },
		{ id: 'ls-process', name: 'Language Server Process', status: 'pending' },
		{ id: 'external-connectivity', name: 'External Connectivity', status: 'pending' },
		{ id: 'dns-pollution', name: 'DNS Pollution Detection', status: 'pending' },
	];

	const updateCheck = (index: number, check: DiagnosticCheck) => {
		checks[index] = check;
		onProgress?.(checks);
	};

	// Run checks sequentially
	if (isLocal) {
		// Local environment: check steps 1-2
		checks[0].status = 'running';
		onProgress?.(checks);
		updateCheck(0, await checkLocalProxy(localProxyPort));

		checks[1].status = 'running';
		onProgress?.(checks);
		updateCheck(1, await checkSSHConfig(remoteProxyPort));

		// Skip all remote-only checks — declared by ID so adding new checks never breaks this
		const REMOTE_ONLY_IDS = new Set([
			'remote-forward',
			'mgraftcp',
			'ls-wrapper',
			'ls-process',
			'external-connectivity',
			'dns-pollution',
		]);
		checks.forEach((c) => {
			if (REMOTE_ONLY_IDS.has(c.id)) {
				c.status = 'warning';
				c.message = 'Skipped (remote-only check)';
			}
		});
		onProgress?.(checks);
	} else {
		// Remote environment: skip local checks
		checks[0].status = 'warning';
		checks[0].message = 'Skipped (local-only check)';
		checks[1].status = 'warning';
		checks[1].message = 'Skipped (local-only check)';
		onProgress?.(checks);

		// Phase 1: Run independent checks in parallel
		// port, mgraftcp, ls-process, and dns have no dependencies between them
		[2, 3, 5, 7].forEach((i) => {
			checks[i].status = 'running';
		});
		onProgress?.(checks);

		const [portResult, mgraftcpResult, lsProcessResult, dnsResult] = await Promise.all([
			checkRemotePortForward(remoteProxyHost, remoteProxyPort, localProxyPort),
			checkMgraftcp(extensionPath),
			checkLanguageServerProcess(),
			checkDNSPollution(),
		]);
		updateCheck(2, portResult);
		updateCheck(3, mgraftcpResult);
		updateCheck(5, lsProcessResult);
		updateCheck(7, dnsResult);

		// Phase 2: Run checks that benefit from port result in parallel
		[4, 6].forEach((i) => {
			checks[i].status = 'running';
		});
		onProgress?.(checks);

		const [wrapperResult, connResult] = await Promise.all([
			checkLanguageServerWrapper(extensionPath),
			checkExternalConnectivity(remoteProxyHost, remoteProxyPort, proxyType),
		]);
		updateCheck(4, wrapperResult);
		updateCheck(6, connResult);
	}

	// Determine overall status
	const errorCount = checks.filter((c) => c.status === 'error').length;
	const warningCount = checks.filter(
		(c) => c.status === 'warning' && !c.message?.includes('Skipped'),
	).length;

	let overallStatus: 'healthy' | 'degraded' | 'broken';
	if (errorCount > 0) {
		overallStatus = 'broken';
	} else if (warningCount > 0) {
		overallStatus = 'degraded';
	} else {
		overallStatus = 'healthy';
	}

	return {
		timestamp: new Date(),
		checks,
		overallStatus,
	};
}

/**
 * Generate a text report for copying
 */
export function generateReportText(report: DiagnosticReport): string {
	const lines: string[] = [
		'=== SSH Relay Guard — Health Report ===',
		`Timestamp: ${report.timestamp.toISOString()}`,
		`Overall Status: ${report.overallStatus.toUpperCase()}`,
		`Environment: ${isRunningLocally() ? 'Local' : 'Remote'}`,
		'',
		'--- Checks ---',
	];

	for (const check of report.checks) {
		const icon =
			check.status === 'success'
				? '✓'
				: check.status === 'warning'
					? '⚠'
					: check.status === 'error'
						? '✗'
						: '○';
		lines.push(`[${icon}] ${check.name}: ${check.message || check.status}`);

		// Add protocol test results for external-connectivity check
		if (check.protocolResults && check.protocolResults.length > 0) {
			for (let i = 0; i < check.protocolResults.length; i++) {
				const result = check.protocolResults[i];
				const isLast = i === check.protocolResults.length - 1;
				const prefix = isLast ? '└──' : '├──';
				const statusIcon = result.success ? '✓' : '✗';
				const statusText = result.success ? 'Available' : 'Not working';
				const currentLabel = result.isCurrent ? ' ← Current' : '';
				lines.push(
					`    ${prefix} ${result.protocol.toUpperCase()}: ${statusIcon} ${statusText}${currentLabel}`,
				);
			}
		}

		if (check.suggestion) {
			lines.push(`    Suggestion: ${check.suggestion}`);
		}
	}

	lines.push('');
	lines.push('=== End of Report ===');
	return lines.join('\n');
}
