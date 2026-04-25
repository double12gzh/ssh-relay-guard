import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { buildInstallScript, buildRestoreScript } from '../setup/remoteInstaller';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { isPortReachable, isSrgSetupCompleted } from '../utils/portProbe';
import {
	isMgraftcpRunning,
	getMonitoredProcess,
	killTargetProcess,
	promptReloadWindow,
	execAsync,
} from '../utils/processUtils';

/**
 * RemoteModeController — Handles all remote-side SRG functionality.
 *
 * Responsibilities:
 * - Register remote-only VS Code commands (setup, rollback, checkProxy)
 * - Ensure mgraftcp binary has execute permission
 * - Auto-configure VS Code's http.proxy
 * - Run setup script silently (idempotent)
 * - Manage Language Server process lifecycle (kill + auto-reload)
 * - Run startup connectivity checks (port + curl + LS status)
 * - Show first-run guide and tunnel-not-established warnings
 * - Listen for configuration changes and re-run setup
 */
export class RemoteModeController {
	constructor(
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private dashboardManager: DashboardManager,
		private log: (message: string) => void,
	) {}

	/**
	 * Activate remote mode: ensure binaries, run setup, configure proxy,
	 * register commands, listen for config changes, run startup checks.
	 */
	async activate(): Promise<void> {
		const remoteHost = this.configService.remoteProxyHost;
		const remotePort = this.configService.remoteProxyPort;
		const proxyType = this.configService.proxyType;

		if (process.platform !== 'linux') {
			this.log(
				`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`,
			);
			this.dashboardManager.setVerifying(false);
			return;
		}

		const extensionPath = this.context.extensionUri.fsPath;

		await this.ensureMgraftcpExecutable(extensionPath);

		this.dashboardManager.setConfigChangeCallback(async () => {
			const host = this.configService.remoteProxyHost;
			const port = this.configService.remoteProxyPort;
			const type = this.configService.proxyType;
			const rewrite = this.configService.rewriteCloudCodeEndpoint;
			this.log(`Config changed from panel, re-running setup: ${host}:${port} (${type})`);
			const success = await this.runSetupScriptSilently(
				host,
				port,
				type,
				rewrite,
				extensionPath,
			);
			this.dashboardManager.updateLanguageServerStatus(success);
		});

		this.log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);

		this.log(`Extension path: ${extensionPath}`);
		this.log('Auto-running setup script...');
		const rewriteCloudCode = this.configService.rewriteCloudCodeEndpoint;
		const setupSuccess = await this.runSetupScriptSilently(
			remoteHost,
			remotePort,
			proxyType,
			rewriteCloudCode,
			extensionPath,
		);
		this.dashboardManager.updateLanguageServerStatus(setupSuccess);

		await this.configureHttpProxy(remoteHost, remotePort, proxyType);

		// Use ConfigService.onChange() — ConfigService handles reload internally,
		// so cached values are already up-to-date when this fires.
		this.context.subscriptions.push(
			this.configService.onChange(async () => {
				const host = this.configService.remoteProxyHost;
				const port = this.configService.remoteProxyPort;
				const type = this.configService.proxyType;
				const rewrite = this.configService.rewriteCloudCodeEndpoint;
				this.log(`Config changed, re-running setup: ${host}:${port} (${type})`);
				const success = await this.runSetupScriptSilently(
					host,
					port,
					type,
					rewrite,
					extensionPath,
				);
				this.dashboardManager.updateLanguageServerStatus(success);
				await this.dashboardManager.refreshStatus();
			}),
		);

		this.registerRemoteCommands(extensionPath, remoteHost, remotePort);

		// Run full startup connectivity check (non-blocking)
		// Status bar stays spinning until this completes, then shows the real result
		const showStatusOnStartup = this.configService.showStatusOnStartup;
		if (showStatusOnStartup) {
			this.runFullStartupCheck(remoteHost, remotePort);
		} else {
			await this.dashboardManager.refreshStatus();
			this.dashboardManager.setVerifying(false);
		}
	}

	// ── Commands ────────────────────────────────────────────────────────

	private registerRemoteCommands(
		extensionPath: string,
		remoteHost: string,
		remotePort: number,
	): void {
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ssh-relay-guard.setup', async () => {
				const host = this.configService.remoteProxyHost;
				const port = this.configService.remoteProxyPort;
				const rewrite = this.configService.rewriteCloudCodeEndpoint;
				const terminal = vscode.window.createTerminal('SRG Setup');
				terminal.show();
				const script = await buildInstallScript(host, port, rewrite, extensionPath);
				const tempFileCmd = `TMP_SCRIPT=$(mktemp /tmp/srg_setup.XXXXXX.sh) && cat > "$TMP_SCRIPT" << 'EOF'\n${script}\nEOF\nbash "$TMP_SCRIPT" && rm -f "$TMP_SCRIPT"`;
				terminal.sendText(tempFileCmd);
			}),

			vscode.commands.registerCommand('ssh-relay-guard.rollback', () => {
				const terminal = vscode.window.createTerminal('SRG Rollback');
				terminal.show();
				terminal.sendText(buildRestoreScript());
				this.dashboardManager.updateLanguageServerStatus(false);
			}),

			vscode.commands.registerCommand('ssh-relay-guard.checkProxy', async () => {
				const ok = await isPortReachable(remoteHost, remotePort);
				await this.dashboardManager.refreshStatus();
				vscode.window.showInformationMessage(ok ? `Proxy OK` : `Proxy NOT reachable`);
			}),
			vscode.commands.registerCommand(
				'ssh-relay-guard.remote.setReconnectingState',
				(state: boolean) => {
					this.dashboardManager.setLocalReconnectionState(state);
				},
			),

			// ── Stubs for local-only commands ──────────────────────────────
			// When users trigger these from a remote window, show a friendly
			// message instead of the confusing "command not found" error.
			...(
				[
					'enableForwarding',
					'disableForwarding',
					'tunnelStatus',
					'reconnectTunnel',
				] as const
			).map((cmd) =>
				vscode.commands.registerCommand(`ssh-relay-guard.${cmd}`, () => {
					vscode.window.showWarningMessage(
						`This command must be run from a LOCAL VS Code window. ` +
							`Open a new local window (File → New Window), then run this command from there.`,
					);
				}),
			),
		);
	}

	// ── mgraftcp Setup ─────────────────────────────────────────────────

	/**
	 * Ensure mgraftcp binary has execute permission
	 */
	private async ensureMgraftcpExecutable(extensionPath: string): Promise<void> {
		const arch = os.arch();
		let binaryName: string;

		switch (arch) {
			case 'x64':
			case 'amd64':
				binaryName = 'mgraftcp-fakedns-linux-amd64';
				break;
			case 'arm64':
			case 'aarch64':
				binaryName = 'mgraftcp-fakedns-linux-arm64';
				break;
			default:
				this.log(`Unsupported architecture: ${arch}`);
				return;
		}

		const mgraftcpPath = path.join(extensionPath, 'resources', 'bin', binaryName);

		try {
			await execAsync(`chmod +x "${mgraftcpPath}"`);
			this.log(`Set execute permission for ${mgraftcpPath}`);
		} catch (error) {
			this.log(`Failed to set execute permission for mgraftcp: ${error}`);
		}
	}

	// ── HTTP Proxy Configuration ───────────────────────────────────────

	/**
	 * Auto-configure VS Code's http.proxy on the remote side.
	 */
	private async configureHttpProxy(
		proxyHost: string,
		proxyPort: number,
		proxyType: string,
	): Promise<void> {
		const httpConfig = vscode.workspace.getConfiguration('http');
		const currentProxy = httpConfig.get<string>('proxy', '');

		const proxyUrl =
			proxyType === 'socks5'
				? `socks5://${proxyHost}:${proxyPort}`
				: `http://${proxyHost}:${proxyPort}`;

		if (!this.configService.setGlobalHttpProxy) {
			if (currentProxy === proxyUrl) {
				this.log(
					`Global HTTP proxy is disabled in settings. Clearing existing proxy: ${proxyUrl}`,
				);
				try {
					await httpConfig.update('proxy', '', vscode.ConfigurationTarget.Global);
				} catch (error) {
					this.log(`Failed to clear http.proxy: ${error}`);
				}
			}
			return;
		}

		if (currentProxy === proxyUrl) {
			this.log(`http.proxy already set to ${proxyUrl}`);
			return;
		}

		const inspected = httpConfig.inspect<string>('proxy');
		if (inspected?.globalValue && inspected.globalValue !== '') {
			const isLocalOrHost =
				inspected.globalValue.includes('127.0.0.1') ||
				inspected.globalValue.includes('localhost') ||
				inspected.globalValue.includes(proxyHost);
			if (!isLocalOrHost) {
				this.log(
					`http.proxy has external user-configured value "${inspected.globalValue}", not overriding`,
				);
				return;
			}
		}

		try {
			await httpConfig.update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
			await httpConfig.update('proxyStrictSSL', false, vscode.ConfigurationTarget.Global);
			this.log(`Set http.proxy = ${proxyUrl}`);
		} catch (error) {
			this.log(`Failed to set http.proxy: ${error}`);
		}
	}

	// ── Setup Script ───────────────────────────────────────────────────

	/**
	 * Run setup script silently in background (idempotent).
	 * @returns true if setup was successful or already configured
	 */
	private async runSetupScriptSilently(
		proxyHost: string,
		proxyPort: number,
		proxyType: string,
		rewriteCloudCode: boolean,
		extensionPath: string,
	): Promise<boolean> {
		try {
			const script = await buildInstallScript(
				proxyHost,
				proxyPort,
				rewriteCloudCode,
				extensionPath,
			);
			const tempScriptPath = path.join(
				os.tmpdir(),
				`srg_setup_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.sh`,
			);
			await fs.writeFile(tempScriptPath, script, { mode: 0o755 });

			const extensionVersion = this.context.extension.packageJSON.version || 'unknown';

			const env = {
				...process.env,
				PROXY_HOST: proxyHost,
				PROXY_PORT: String(proxyPort),
				PROXY_TYPE: proxyType,
				REWRITE_CLOUDCODE: rewriteCloudCode ? 'true' : 'false',
				EXTENSION_PATH: extensionPath,
				EXTENSION_VERSION: extensionVersion,
			};

			const { stdout, stderr } = await execAsync(`bash "${tempScriptPath}" 2>&1`, { env });
			const output = stdout || stderr || '';

			// Clean up
			await fs.unlink(tempScriptPath).catch(() => {});

			this.log(`Setup output: ${output}`);

			const isNewConfig =
				output.includes('Setup complete') ||
				(output.includes('configured') && !output.includes('Already configured'));

			if (isNewConfig) {
				this.log('Setup: New configuration applied');

				const lsProcess = await getMonitoredProcess();
				if (lsProcess) {
					this.log(
						`Setup: LS running (PID ${lsProcess.pid}, persistent=${lsProcess.isPersistent}), killing to apply wrapper`,
					);
					await this.killLSAndAutoReload();
				} else {
					this.log('Setup: LS not running, will start with proxy on next use');
					promptReloadWindow(
						'Proxy configured. Reload window to apply changes to the language server.',
					);
				}
				return true;
			} else if (output.includes('Already configured')) {
				this.log('Setup: Already configured');

				const lsProcess = await getMonitoredProcess();
				const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
				const lsIsPersistent = lsProcess?.isPersistent ?? false;

				if (lsProcess && !lsActuallyUsingProxy) {
					this.log(
						`Setup: Proxy configured but LS not using it (PID ${lsProcess.pid}, persistent=${lsIsPersistent}), auto-fixing...`,
					);
					await this.killLSAndAutoReload();
				} else if (lsActuallyUsingProxy) {
					this.log('Setup: Proxy is active, no reload needed');
				} else {
					this.log('Setup: LS not running, will use proxy when started');
				}
				return true;
			}
			return false;
		} catch (error: unknown) {
			const err = error as { message?: string; stdout?: string; stderr?: string };
			this.log(`Setup error: ${err.message || error}`);
			if (err.stdout) {
				this.log(`stdout: ${err.stdout}`);
			}
			if (err.stderr) {
				this.log(`stderr: ${err.stderr}`);
			}
			return false;
		}
	}

	/**
	 * Kill LS process and prompt user to reload window.
	 * If kill succeeds, shows prompt to reload.
	 * If kill fails, shows manual instructions.
	 */
	private async killLSAndAutoReload(): Promise<void> {
		const killed = await killTargetProcess((m) => this.log(m));
		if (killed) {
			this.log('LS killed, prompting user to reload window...');
			vscode.window
				.showInformationMessage(
					'🔄 Language Server stopped to apply proxy settings. Reload window to take effect.',
					'Reload Now',
					'Later',
				)
				.then((selection) => {
					if (selection === 'Reload Now') {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
		} else {
			vscode.window
				.showWarningMessage(
					'Proxy configured but Language Server needs restart. ' +
						'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
					'Reload Now',
				)
				.then((selection) => {
					if (selection === 'Reload Now') {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
		}
	}

	// ── Startup Checks ─────────────────────────────────────────────────

	/**
	 * Run the full startup connectivity check (port + curl), then finalize status bar.
	 * Runs as a fire-and-forget async — commands are already registered, extension is active.
	 */
	private async runFullStartupCheck(remoteHost: string, remotePort: number): Promise<void> {
		try {
			await this.showStartupStatus(remoteHost, remotePort);
		} catch (err) {
			this.log(`Startup check error: ${err}`);
		} finally {
			// Now we know the real state — finalize the status bar
			await this.dashboardManager.refreshStatus();
			this.dashboardManager.setVerifying(false);
		}
	}

	// ── First-Run Detection ────────────────────────────────────────────

	/**
	 * Show a friendly getting-started guide for first-time users.
	 * Replaces the scary "tunnel not established" warning on first install.
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

	// ── Remote Helpers ─────────────────────────────────────────────────

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

	// ── Startup State Resolution ───────────────────────────────────────

	/**
	 * Diagnose startup state and return a structured result.
	 * Separates diagnostics (pure data) from UI (side-effects).
	 */
	private async diagnoseStartup(
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

		let httpOk = false;
		let socks5Ok = false;

		if (proxyReachable) {
			const currentProxyType = this.configService.proxyType;

			this.log(`[Test 3 & 4] Testing HTTP and SOCKS5 proxy connectivity in parallel...`);
			const httpCmd = `curl -x http://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			const socks5Cmd = `curl -x socks5://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;

			const runCurl = async (cmd: string): Promise<boolean> => {
				try {
					const { stdout } = await execAsync(cmd, { timeout: 15000 });
					const code = stdout.trim();
					return code === '200' || code === '301' || code === '302';
				} catch {
					return false;
				}
			};

			const [httpRes, socks5Res] = await Promise.all([runCurl(httpCmd), runCurl(socks5Cmd)]);
			httpOk = httpRes;
			socks5Ok = socks5Res;

			const httpMarker =
				currentProxyType === 'http'
					? httpOk
						? ' ← Current'
						: ' ← Current (⚠️ NOT WORKING)'
					: '';
			this.log(`  Result (HTTP): ${httpOk ? '✓ OK' : '✗ Failed'}${httpMarker}`);

			const socks5Marker =
				currentProxyType === 'socks5'
					? socks5Ok
						? ' ← Current'
						: ' ← Current (⚠️ NOT WORKING)'
					: '';
			this.log(`  Result (SOCKS5): ${socks5Ok ? '✓ OK' : '✗ Failed'}${socks5Marker}`);
			this.log('');
		}

		this.log('==========================================');
		this.log('');

		return {
			proxyReachable,
			proxyActive,
			proxyFunctional: httpOk || socks5Ok,
			lsProcess,
			httpOk,
			socks5Ok,
		};
	}

	/**
	 * Resolve startup diagnosis into a user-facing action.
	 * Returns null if a special flow (first-run / tunnel warning) was shown instead.
	 */
	private async resolveStartupAction(
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
	private async handleStartupAction(selection: string | undefined): Promise<void> {
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
	 * Show startup status notification with diagnostics in output channel.
	 */
	private async showStartupStatus(proxyHost: string, proxyPort: number): Promise<void> {
		try {
			const diag = await this.diagnoseStartup(proxyHost, proxyPort);
			const result = await this.resolveStartupAction(proxyHost, proxyPort, diag);

			if (!result) {
				return;
			} // Special flow (first-run / tunnel warning) already shown

			this.log(`Startup status: ${result.message}`);

			if (result.actions.length > 0) {
				const selection = await vscode.window.showInformationMessage(
					result.message,
					...result.actions,
				);
				await this.handleStartupAction(selection);
			} else {
				vscode.window.showInformationMessage(result.message);
			}
		} catch (error) {
			this.log(`Startup status check failed: ${error}`);
		}
	}
}
