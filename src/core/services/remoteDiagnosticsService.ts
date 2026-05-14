import * as vscode from 'vscode';
import { ConfigService } from '../configService';
import { isPortReachable, isProxyFunctional, isSrgSetupCompleted } from '../../utils/portProbe';
import {
	isMgraftcpRunning,
	getMonitoredProcess,
	killTargetProcess,
} from '../../utils/processUtils';
import { RemoteProcessService } from './remoteProcessService';

/**
 * Service for running startup connectivity checks, diagnosing the proxy state,
 * and resolving actions (like showing warnings).
 */
export class RemoteDiagnosticsService {
	constructor(
		private configService: ConfigService,
		private processService: RemoteProcessService,
		private log: (message: string) => void,
	) {}

	/**
	 * Diagnose startup state and return a structured result.
	 */
	public async diagnoseStartup(
		proxyHost: string,
		proxyPort: number,
	): Promise<{
		proxyReachable: boolean;
		proxyActive: boolean;
		proxyFunctional: boolean;
		lsProcess: Awaited<ReturnType<typeof getMonitoredProcess>>;
		httpOk: boolean;
		socks5Ok: boolean;
	}> {
		this.log('');
		this.log('========== Startup Status Check ==========');
		this.log(`Proxy endpoint: ${proxyHost}:${proxyPort}`);
		this.log('');

		this.log(`[Test 1] Checking port connectivity...`);
		const proxyReachable = await isPortReachable(proxyHost, proxyPort);
		this.log(`  Result: ${proxyReachable ? '✓ Port is reachable' : '✗ Port is NOT reachable'}`);
		this.log('');

		this.log(`[Test 2] Checking if mgraftcp is running...`);
		const proxyActive = await isMgraftcpRunning();
		this.log(
			`  Result: ${proxyActive ? '✓ mgraftcp is running (proxy active)' : '✗ mgraftcp is NOT running'}`,
		);
		this.log('');

		this.log(`[Test 2.5] Checking Language Server process status...`);
		const lsProcess = await getMonitoredProcess();
		if (lsProcess) {
			const modeLabel = lsProcess.isPersistent ? 'persistent mode' : 'normal mode';
			const proxyLabel = lsProcess.isUsingProxy ? 'using proxy' : 'NOT using proxy';
			const statusIcon = lsProcess.isUsingProxy ? '✓' : lsProcess.isPersistent ? '✗' : '⚠';
			this.log(
				`  Result: ${statusIcon} Language Server (PID ${lsProcess.pid}) is running in ${modeLabel}, ${proxyLabel}`,
			);

			if (lsProcess.isPersistent && !lsProcess.isUsingProxy) {
				this.log(`  ⚠️ WARNING: LS is in persistent_mode but not using proxy!`);
				this.log(`    Will auto-fix by killing LS process...`);
			}
		} else {
			this.log(`  Result: ○ Language Server is not running (will start on demand)`);
		}
		this.log('');

		// Protocol-level connectivity tests (curl google.com) are intentionally
		// skipped during startup to avoid the 10-30s delay they cause.
		// They are available on-demand via the "Run Diagnostics" button in the
		// SRG panel (healthChecker → checkExternalConnectivity).
		// Instead, derive proxyFunctional from the fast protocol handshake below.
		let proxyFunctional = false;
		if (proxyReachable) {
			const proxyType = this.configService.proxyType as 'http' | 'socks5' | 'any';
			proxyFunctional = await isProxyFunctional(proxyHost, proxyPort, proxyType, 3000);
			this.log(`[Test 3] Proxy protocol handshake: ${proxyFunctional ? '✓ OK' : '✗ Failed'}`);
		}
		this.log('');

		this.log('==========================================');
		this.log('');

		return {
			proxyReachable,
			proxyActive,
			proxyFunctional,
			lsProcess,
			httpOk: false, // Not tested at startup; use "Run Diagnostics" for full protocol tests
			socks5Ok: false,
		};
	}

	/**
	 * Resolve startup diagnosis into a user-facing action.
	 * Returns null if a special flow (first-run / tunnel warning) was shown instead.
	 */
	public async resolveStartupAction(
		proxyHost: string,
		proxyPort: number,
		diag: Awaited<ReturnType<typeof this.diagnoseStartup>>,
	): Promise<{ message: string; actions: string[] } | null> {
		const { proxyReachable, proxyActive, proxyFunctional, lsProcess } = diag;
		const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
		const lsNeedsRestart = lsProcess && !lsActuallyUsingProxy;

		// Case 1: Port unreachable
		if (!proxyReachable) {
			const setupDone = await isSrgSetupCompleted();
			if (!setupDone) {
				await this.showFirstRunGuide();
			} else {
				this.log('Proxy not reachable — SSH tunnel may not be established');
				await this.showSSHTunnelNotEstablishedWarning(proxyHost, proxyPort);
			}
			return null; // Special flow handled
		}

		// Case 2: Port reachable but proxy not functional
		if (!proxyFunctional) {
			this.log('Port is reachable but proxy connectivity test failed');
			return {
				message:
					`⚠️ Port ${proxyPort} is reachable but proxy is not responding. ` +
					`The port may be occupied by another process, or the local proxy may not be running.`,
				actions: ['Run Health Check', 'Open SRG Panel', 'Dismiss'],
			};
		}

		// Case 3: Everything working, LS using proxy
		if (lsActuallyUsingProxy) {
			return { message: `✅ Proxy active (${proxyHost}:${proxyPort})`, actions: [] };
		}

		// Case 4: Proxy working but LS needs restart
		if (lsNeedsRestart) {
			this.log(
				`Startup: LS running (PID ${lsProcess!.pid}) but not using proxy, auto-fixing...`,
			);
			const killed = await killTargetProcess((m) => this.log(m));
			if (killed) {
				return {
					message: `🔄 Language Server stopped to apply proxy settings.`,
					actions: ['Reload Now', 'Later'],
				};
			}
			return {
				message: `⚠️ Proxy configured but Language Server needs manual restart.`,
				actions: ['Kill & Reload', 'Dismiss'],
			};
		}

		// Case 5: Proxy working but mgraftcp not active
		if (!proxyActive) {
			return {
				message: `⚠️ Proxy configured but not active. Reload to enable.`,
				actions: ['Reload Now', 'Dismiss'],
			};
		}

		// Fallback: unknown state
		return { message: `⚠️ Proxy status unknown`, actions: ['Run Health Check', 'Dismiss'] };
	}

	/**
	 * Handle user's selection from startup status notification.
	 */
	public async handleStartupAction(selection: string | undefined): Promise<void> {
		switch (selection) {
			case 'Reload Now':
				vscode.commands.executeCommand('workbench.action.reloadWindow');
				break;
			case 'Kill & Reload':
				await killTargetProcess((m) => this.log(m));
				vscode.window
					.showInformationMessage(
						'🔄 Language Server stopped. Reload window to take effect.',
						'Reload Now',
						'Later',
					)
					.then((sel) => {
						if (sel === 'Reload Now') {
							vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
				break;
			case 'Run Health Check':
				vscode.commands.executeCommand('ssh-relay-guard.diagnose');
				break;
			case 'Open SRG Panel':
				vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
				break;
		}
	}

	/**
	 * Show a friendly getting-started guide for first-time users.
	 */
	private async showFirstRunGuide(): Promise<void> {
		this.log('First-run detected: showing getting started guide');

		const message =
			'👋 Welcome to SSH Relay Guard!\n\n' +
			'The proxy tunnel is not yet established. ' +
			'SSH tunnels can only be created when the SSH connection starts, ' +
			'so you need to configure the LOCAL side first, then reconnect.\n\n' +
			'Step 1: Install SRG extension on your LOCAL machine\n' +
			'Step 2: In the local SRG panel, run "Add Host Forwarding" for this host\n' +
			'Step 3: Disconnect and reconnect to this remote server\n\n' +
			'⚠️ Important: You MUST reconnect SSH (not just reload window) for the tunnel to work.';

		const selection = await vscode.window.showInformationMessage(
			message,
			{ modal: true },
			'Open Dashboard',
			'Dismiss',
		);

		if (selection === 'Open Dashboard') {
			vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
		}
	}

	/**
	 * Show detailed warning when proxy is not reachable on the remote side.
	 */
	private async showSSHTunnelNotEstablishedWarning(
		proxyHost: string,
		proxyPort: number,
	): Promise<void> {
		const lp = this.configService.localProxyPort;
		const tunnelCmd = `ssh -fN -R ${proxyPort}:127.0.0.1:${lp} <your-host>`;
		const autosshCmd = `autossh -M 0 -fN -R ${proxyPort}:127.0.0.1:${lp} -o ServerAliveInterval=30 -o ServerAliveCountMax=3 <your-host>`;

		const detailMessage =
			`Proxy not reachable at ${proxyHost}:${proxyPort}\n\n` +
			`Fix steps (try in order):\n\n` +
			`1. Start local proxy\n` +
			`   Ensure Clash / V2Ray is running and listening on port ${lp}\n\n` +
			`2. Run "Add Host Forwarding" on LOCAL SRG panel\n` +
			`   This writes RemoteForward to SSH config and establishes the tunnel\n` +
			`   Manual fallback (auto-reconnect): ${autosshCmd}\n` +
			`   Manual fallback (basic): ${tunnelCmd}\n\n` +
			`3. Disconnect and reconnect this remote window\n` +
			`   SSH tunnel only takes effect on new connections\n\n` +
			`4. Check if port is occupied (run on REMOTE terminal)\n` +
			`   ss -tlnp | grep ${proxyPort}\n\n` +
			`5. Verify port settings match\n` +
			`   Local panel "Remote Port" must equal remote panel "Proxy Port"`;

		this.log('Showing proxy not reachable warning dialog');

		const selection = await vscode.window.showWarningMessage(
			detailMessage,
			{ modal: true },
			'Copy Tunnel Command',
			'Run Health Check',
			'Open SRG Panel',
			'Dismiss',
		);

		if (selection === 'Copy Tunnel Command') {
			await vscode.env.clipboard.writeText(tunnelCmd);
			vscode.window.showInformationMessage(
				`Copied to clipboard: ${tunnelCmd}\n\nPaste in your LOCAL terminal and replace <your-host> with your SSH hostname.`,
			);
		} else if (selection === 'Run Health Check') {
			vscode.commands.executeCommand('ssh-relay-guard.diagnose');
		} else if (selection === 'Open SRG Panel') {
			vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
		}
	}
}
