/**
 * Diagnostic health check orchestrator.
 *
 * Individual checks live in ./checks/*.ts.
 * This module coordinates execution order, parallelism, progress reporting,
 * and report generation.
 */

import { isRunningLocally } from '../utils/portProbe';
import { ConfigService } from '../core/configService';

import { checkLocalProxy } from './checks/localProxy';
import { checkSSHConfig } from './checks/sshConfig';
import { checkRemotePortForward } from './checks/remoteForward';
import { checkMgraftcp } from './checks/mgraftcp';
import { checkLanguageServerWrapper, checkLanguageServerProcess } from './checks/languageServer';
import { checkExternalConnectivity, checkDNSPollution } from './checks/connectivity';

// ---------------------------------------------------------------------------
// Public types (re-exported so consumers keep the same import path)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all diagnostic checks.
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

// ---------------------------------------------------------------------------
// Report text generation
// ---------------------------------------------------------------------------

/**
 * Generate a text report for copying.
 */
export function generateReportText(report: DiagnosticReport): string {
	const lines: string[] = [
		'=== SSH Relay Guard — Health Report ===',
		`Timestamp: ${report.timestamp.toISOString()}`,
		`Overall Status: ${report.overallStatus.toUpperCase()}`,
		'',
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
