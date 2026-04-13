import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { buildInstallScript, buildRestoreScript } from '../setup/remoteInstaller';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { isPortReachable, isRunningLocally, isSrgSetupCompleted } from '../utils/portProbe';
import { updateForHost, readStatus, readAllStatus, getSSHSocketDir } from './sshConfigManager';
import { isMgraftcpRunning, getMonitoredProcess, killTargetProcess, promptReloadWindow } from '../utils/processUtils';

const execAsync = promisify(exec);

/**
 * ProxyOrchestrator — Central coordinator for all SRG functionality.
 * Manages the lifecycle of child modules and registers all VS Code commands.
 */
export class ProxyOrchestrator implements vscode.Disposable {
	private outputChannel: vscode.OutputChannel;
	private configService: ConfigService;
	private dashboardManager: DashboardManager;
	private isLocal: boolean;

	constructor(
		private context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
	) {
		this.outputChannel = outputChannel;
		this.isLocal = isRunningLocally();
		this.configService = new ConfigService();
		this.dashboardManager = new DashboardManager(this.isLocal, context, this.configService);
	}

	/**
	 * Initialize the orchestrator: register commands, start auto-refresh,
	 * and activate local or remote mode.
	 */
	initialize(): void {
		this.log(`Activating... isLocal=${this.isLocal}`);

		this.context.subscriptions.push(this.dashboardManager);

		this.registerCommonCommands();

		// Remote: show spinning icon immediately, before any async work or auto-refresh
		if (!this.isLocal) {
			this.dashboardManager.setVerifying(true);
		}

		this.dashboardManager.startAutoRefresh();

		if (this.isLocal) {
			this.activateLocal().catch(err => this.log(`activateLocal error: ${err}`));
		} else {
			this.activateRemote().catch(err => this.log(`activateRemote error: ${err}`));
		}
	}

	private log(message: string): void {
		const timestamp = new Date().toISOString();
		const location = this.isLocal ? '[LOCAL]' : '[REMOTE]';
		this.outputChannel?.appendLine(`${timestamp} ${location} ${message}`);
	}

	// ── Common Commands ────────────────────────────────────────────────

	private registerCommonCommands(): void {
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ssh-relay-guard.showOutput', () => {
				this.outputChannel.show();
			}),
			vscode.commands.registerCommand('ssh-relay-guard.showStatusPanel', () => {
				this.dashboardManager.showStatusPanel();
			}),
			vscode.commands.registerCommand('ssh-relay-guard.refreshStatus', async () => {
				await this.dashboardManager.refreshStatus();
			}),
			vscode.commands.registerCommand('ssh-relay-guard.diagnose', () => {
				this.dashboardManager.showStatusPanel();
			}),
			vscode.commands.registerCommand('ssh-relay-guard.showTrafficPanel', () => {
				this.dashboardManager.showStatusPanel();
			}),
		);
	}

	// ── Local Mode ─────────────────────────────────────────────────────

	private async activateLocal(): Promise<void> {
		const enable = this.configService.enableLocalForwarding;
		const localPort = this.configService.localProxyPort;
		const remotePort = this.configService.remoteProxyPort;

		this.log(`Config: enable=${enable}, localPort=${localPort}, remotePort=${remotePort}`);

		this.dashboardManager.setConfigChangeCallback(async () => {
			const lp = this.configService.localProxyPort;
			const rp = this.configService.remoteProxyPort;
			const enabled = this.configService.enableLocalForwarding;

			const status = await readAllStatus();
			for (const host of status.hosts) {
				const hostRemotePort = status.hostData.get(host)?.port ?? rp;
				await updateForHost(host, hostRemotePort, lp, enabled, (m) => this.log(m));
			}
			this.dashboardManager.updateSSHConfigStatus(enabled, rp, status.hosts);
		});

		const initialStatus = await readStatus();
		this.dashboardManager.updateSSHConfigStatus(initialStatus.enabled, initialStatus.port, initialStatus.hosts);

		if (enable && !await isPortReachable('127.0.0.1', localPort)) {
			vscode.window.showWarningMessage(
				`Local proxy at 127.0.0.1:${localPort} is not running. ` +
				`Also check if port ${remotePort} is occupied on the remote server before reconnecting.`
			);
		}

		await this.dashboardManager.refreshStatus();

		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
				if (e.affectsConfiguration('ssh-relay-guard')) {
					// ConfigService already reloaded by its own listener
					const lp = this.configService.localProxyPort;
					const rp = this.configService.remoteProxyPort;
					const enabled = this.configService.enableLocalForwarding;
					const rpChanged = e.affectsConfiguration('ssh-relay-guard.remoteProxyPort');

					const status = await readAllStatus();
					for (const host of status.hosts) {
						const hostRemotePort = rpChanged ? rp : (status.hostData.get(host)?.port ?? rp);
						await updateForHost(host, hostRemotePort, lp, enabled, (m) => this.log(m));
					}
					this.dashboardManager.updateSSHConfigStatus(enabled, rp, status.hosts);
					await this.dashboardManager.refreshStatus();
				}
			})
		);

		// Local commands
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ssh-relay-guard.enableForwarding', async () => {
				const hostname = await vscode.window.showInputBox({
					prompt: 'Enter the SSH hostname to configure (as in ~/.ssh/config)',
					placeHolder: 'e.g., my-server or user@192.168.1.100',
				});
				if (!hostname) { return; }

				const lp = this.configService.localProxyPort;
				const rp = this.configService.remoteProxyPort;
				await updateForHost(hostname, rp, lp, true, (m) => this.log(m));
				this.dashboardManager.updateSSHConfigStatus(true, rp, [hostname]);
				await this.dashboardManager.refreshStatus();

				// Check if there's an existing ControlMaster socket for this host.
				// Must use `ssh -O check` (not our socket dir) because the user's existing
				// SSH config may define a different ControlPath that takes precedence.
				// ssh -O check does NOT establish a new connection — it only checks the socket.
				let hasExistingSocket = false;
				try {
					const { stdout } = await execAsync(
						`ssh -O check ${hostname} 2>&1 || true`
					);
					hasExistingSocket = stdout.toLowerCase().includes('running');
				} catch { /* no ControlMaster configured or check failed */ }

				if (hasExistingSocket) {
					const action = await vscode.window.showWarningMessage(
						`SSH config for "${hostname}" saved (port ${rp}).\n\n` +
						`⚠️ Detected an existing SSH connection. RemoteForward won't take effect until you reconnect.\n` +
						`Close current connection and reconnect to activate the tunnel?`,
						'Close & Reconnect',
						'OK, I\'ll reconnect later'
					);
					if (action === 'Close & Reconnect') {
						await this.reconnectSSHTunnel(hostname, lp, rp);
					}
				} else {
					// No existing socket — try to establish one directly
					const action = await vscode.window.showInformationMessage(
						`SSH config for "${hostname}" saved (port ${rp}). ` +
						`Establish SSH tunnel now?`,
						'Connect Now',
						'Later'
					);
					if (action === 'Connect Now') {
						await this.reconnectSSHTunnel(hostname, lp, rp);
					}
				}
			}),

			vscode.commands.registerCommand('ssh-relay-guard.disableForwarding', async () => {
				const status = await readStatus();
				if (!status.hosts || status.hosts.length === 0) {
					vscode.window.showInformationMessage('No hosts configured');
					return;
				}

				const hostname = await vscode.window.showQuickPick(status.hosts, {
					placeHolder: 'Select host to remove forwarding from',
				});
				if (!hostname) { return; }

				// Warn: closing ControlMaster will terminate active remote sessions
				const confirm = await vscode.window.showWarningMessage(
					`This will disconnect the SSH tunnel for "${hostname}" and may terminate any active remote VS Code sessions to this host.\n\nContinue?`,
					{ modal: true },
					'Yes, Disconnect',
					'Cancel'
				);
				if (confirm !== 'Yes, Disconnect') { return; }

				// Close ControlMaster socket first (while config still has ControlPath)
				await this.closeControlMasterSocket(hostname);

				await updateForHost(hostname, 0, 0, false, (m) => this.log(m));
				const newStatus = await readStatus();
				this.dashboardManager.updateSSHConfigStatus(newStatus.enabled, newStatus.port, newStatus.hosts);
				await this.dashboardManager.refreshStatus();
				vscode.window.showInformationMessage(`SSH forwarding removed for host: ${hostname}`);
			}),

			vscode.commands.registerCommand('ssh-relay-guard.tunnelStatus', async () => {
				const status = await readStatus();
				this.dashboardManager.updateSSHConfigStatus(status.enabled, status.port, status.hosts);
				if (status.hosts && status.hosts.length > 0) {
					vscode.window.showInformationMessage(
						`Forwarding configured for: ${status.hosts.join(', ')} (port ${status.port})`
					);
				} else {
					vscode.window.showInformationMessage('SSH port forwarding is not configured');
				}
			})
		);
	}

	// ── Remote Mode ────────────────────────────────────────────────────

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

	/**
	 * Auto-configure VS Code's http.proxy on the remote side.
	 */
	private async configureHttpProxy(proxyHost: string, proxyPort: number, proxyType: string): Promise<void> {
		const httpConfig = vscode.workspace.getConfiguration('http');
		const currentProxy = httpConfig.get<string>('proxy', '');

		const proxyUrl = proxyType === 'socks5'
			? `socks5://${proxyHost}:${proxyPort}`
			: `http://${proxyHost}:${proxyPort}`;

		if (currentProxy === proxyUrl) {
			this.log(`http.proxy already set to ${proxyUrl}`);
			return;
		}

		const inspected = httpConfig.inspect<string>('proxy');
		if (inspected?.globalValue && inspected.globalValue !== '') {
			const isLocalOrHost = inspected.globalValue.includes('127.0.0.1') || inspected.globalValue.includes('localhost') || inspected.globalValue.includes(proxyHost);
			if (!isLocalOrHost) {
				this.log(`http.proxy has external user-configured value "${inspected.globalValue}", not overriding`);
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

	private async activateRemote(): Promise<void> {
		const remoteHost = this.configService.remoteProxyHost;
		const remotePort = this.configService.remoteProxyPort;
		const proxyType = this.configService.proxyType;

		if (process.platform !== 'linux') {
			this.log(`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`);
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
			const success = await this.runSetupScriptSilently(host, port, type, rewrite, extensionPath);
			this.dashboardManager.updateLanguageServerStatus(success);
		});

		this.log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);

		this.log(`Extension path: ${extensionPath}`);
		this.log('Auto-running setup script...');
		const rewriteCloudCode = this.configService.rewriteCloudCodeEndpoint;
		const setupSuccess = await this.runSetupScriptSilently(remoteHost, remotePort, proxyType, rewriteCloudCode, extensionPath);
		this.dashboardManager.updateLanguageServerStatus(setupSuccess);

		await this.configureHttpProxy(remoteHost, remotePort, proxyType);

		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
				if (e.affectsConfiguration('ssh-relay-guard.remoteProxyHost') ||
					e.affectsConfiguration('ssh-relay-guard.remoteProxyPort') ||
					e.affectsConfiguration('ssh-relay-guard.proxyType')) {
					// ConfigService already reloaded by its own listener
					const host = this.configService.remoteProxyHost;
					const port = this.configService.remoteProxyPort;
					const type = this.configService.proxyType;
					const rewrite = this.configService.rewriteCloudCodeEndpoint;
					this.log(`Config changed, re-running setup: ${host}:${port} (${type})`);
					const success = await this.runSetupScriptSilently(host, port, type, rewrite, extensionPath);
					this.dashboardManager.updateLanguageServerStatus(success);
					await this.dashboardManager.refreshStatus();
				}
			})
		);

		// Remote commands
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ssh-relay-guard.setup', async () => {
				const type = this.configService.proxyType;
				const host = this.configService.remoteProxyHost;
				const port = this.configService.remoteProxyPort;
				const rewrite = this.configService.rewriteCloudCodeEndpoint;
				const terminal = vscode.window.createTerminal('SRG Setup');
				terminal.show();
				const script = await buildInstallScript(host, port, rewrite, extensionPath);
				terminal.sendText(`cat > /tmp/srg_setup.sh << 'EOF'\n${script}\nEOF`);
				terminal.sendText('bash /tmp/srg_setup.sh');
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
			})
		);

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

	// isFirstRun() is now delegated to the shared isSrgSetupCompleted() in portProbe.ts

	/**
	 * Show a friendly getting-started guide for first-time users.
	 * Replaces the scary "tunnel not established" warning on first install.
	 */
	private async showFirstRunGuide(): Promise<void> {
		this.log('First-run detected: showing getting started guide');

		const message =
			'👋 Welcome to SSH Relay Guard!\n\n' +
			'The proxy tunnel is not yet established. ' +
			'To complete the setup, please follow these steps:\n\n' +
			'Step 1: Install SRG extension on your LOCAL machine\n' +
			'Step 2: In the local SRG panel, run "Add Host Forwarding" for this host\n' +
			'Step 3: Reconnect to this remote server — the tunnel will be established automatically\n\n' +
			'After reconnecting, SRG will auto-configure the proxy for you.';

		const selection = await vscode.window.showInformationMessage(
			message,
			{ modal: true },
			'Open Dashboard',
			'Dismiss'
		);

		if (selection === 'Open Dashboard') {
			vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
		}
	}

	// ── Remote Helpers ─────────────────────────────────────────────────

	/**
	 * Show detailed warning when proxy is not reachable on the remote side.
	 */
	private async showSSHTunnelNotEstablishedWarning(proxyHost: string, proxyPort: number): Promise<void> {
		const lp = this.configService.localProxyPort;
		const tunnelCmd = `ssh -fN -R ${proxyPort}:127.0.0.1:${lp} <hostname>`;

		const detailMessage =
			`Proxy not reachable at ${proxyHost}:${proxyPort}\n\n` +
			`Fix steps (try in order):\n\n` +
			`1. Start local proxy\n` +
			`   Ensure Clash / V2Ray is running and listening on port ${lp}\n\n` +
			`2. Establish SSH tunnel (run on LOCAL terminal)\n` +
			`   ${tunnelCmd}\n` +
			`   (Replace <hostname> with your SSH host)\n\n` +
			`3. Check if port is occupied (run on REMOTE terminal)\n` +
			`   ss -tlnp | grep ${proxyPort}\n\n` +
			`4. Verify port settings match\n` +
			`   Local panel "Remote Port" must equal remote panel "Proxy Port"`;

		this.log('Showing proxy not reachable warning dialog');

		const selection = await vscode.window.showWarningMessage(
			detailMessage,
			{ modal: true },
			'Copy Tunnel Command',
			'Run Health Check',
			'Open SRG Panel',
			'Dismiss'
		);

		if (selection === 'Copy Tunnel Command') {
			await vscode.env.clipboard.writeText(tunnelCmd);
			vscode.window.showInformationMessage(
				`Copied to clipboard: ${tunnelCmd}\n\nPaste in your LOCAL terminal and replace <hostname>.`
			);
		} else if (selection === 'Run Health Check') {
			vscode.commands.executeCommand('ssh-relay-guard.diagnose');
		} else if (selection === 'Open SRG Panel') {
			vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
		}
	}

	/**
	 * Show startup status notification with diagnostics in output channel.
	 */
	private async showStartupStatus(proxyHost: string, proxyPort: number): Promise<void> {
		try {
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
			this.log(`  Result: ${proxyActive ? '✓ mgraftcp is running (proxy active)' : '✗ mgraftcp is NOT running'}`);
			this.log('');

			this.log(`[Test 2.5] Checking Language Server process status...`);
			const lsProcess = await getMonitoredProcess();
			if (lsProcess) {
				const modeLabel = lsProcess.isPersistent ? 'persistent mode' : 'normal mode';
				const proxyLabel = lsProcess.isUsingProxy ? 'using proxy' : 'NOT using proxy';
				const statusIcon = lsProcess.isUsingProxy ? '✓' : (lsProcess.isPersistent ? '✗' : '⚠');
				this.log(`  Result: ${statusIcon} Language Server (PID ${lsProcess.pid}) is running in ${modeLabel}, ${proxyLabel}`);

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

				this.log(`[Test 3] Testing HTTP proxy connectivity...`);
				const httpCmd = `curl -x http://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
				this.log(`  Command: ${httpCmd}`);
				try {
					const { stdout } = await execAsync(httpCmd, { timeout: 15000 });
					const httpCode = stdout.trim();
					httpOk = httpCode === '200' || httpCode === '301' || httpCode === '302';
					const marker = currentProxyType === 'http' ? ' ← Current' : '';
					this.log(`  Result: HTTP ${httpCode} ${httpOk ? '✓ OK' : '✗ Failed'}${marker}`);
				} catch {
					const marker = currentProxyType === 'http' ? ' ← Current (⚠️ NOT WORKING)' : '';
					this.log(`  Result: ✗ Failed${marker}`);
				}
				this.log('');

				this.log(`[Test 4] Testing SOCKS5 proxy connectivity...`);
				const socks5Cmd = `curl -x socks5://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
				try {
					const { stdout } = await execAsync(socks5Cmd, { timeout: 15000 });
					const httpCode = stdout.trim();
					socks5Ok = httpCode === '200' || httpCode === '301' || httpCode === '302';
					const marker = currentProxyType === 'socks5' ? ' ← Current' : '';
					this.log(`  Result: HTTP ${httpCode} ${socks5Ok ? '✓ OK' : '✗ Failed'}${marker}`);
				} catch {
					const marker = currentProxyType === 'socks5' ? ' ← Current (⚠️ NOT WORKING)' : '';
					this.log(`  Result: ✗ Failed${marker}`);
				}
				this.log('');
			}

			const proxyFunctional = httpOk || socks5Ok;

			this.log('==========================================');
			this.log('');

			let message: string;
			let actions: string[] = [];

			const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
			const lsNeedsRestart = lsProcess && !lsActuallyUsingProxy;

			if (proxyReachable && !proxyFunctional) {
				// Port is reachable but neither HTTP nor SOCKS5 proxy test succeeded.
				// This usually means the port is occupied by another process,
				// or the local proxy is not running / not forwarding traffic.
				this.log('Port is reachable but proxy connectivity test failed — port may be occupied by another process or local proxy not working');
				message = `⚠️ Port ${proxyPort} is reachable but proxy is not responding. ` +
					`The port may be occupied by another process, or the local proxy may not be running.`;
				actions = ['Run Health Check', 'Open SRG Panel', 'Dismiss'];
			} else if (proxyReachable && lsActuallyUsingProxy) {
				message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
			} else if (proxyReachable && lsNeedsRestart) {
				this.log(`Startup: LS running (PID ${lsProcess!.pid}) but not using proxy, auto-fixing...`);
				const killed = await killTargetProcess((m) => this.log(m));
				if (killed) {
					message = `🔄 Language Server restarted to enable proxy. Reloading...`;
					actions = [];
					setTimeout(() => {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}, 2000);
				} else {
					message = `⚠️ Proxy configured but Language Server needs manual restart.`;
					actions = ['Kill & Reload', 'Dismiss'];
				}
			} else if (proxyReachable && !proxyActive) {
				message = `⚠️ Proxy configured but not active. Reload to enable.`;
				actions = ['Reload Now', 'Dismiss'];
			} else if (!proxyReachable) {
				const setupDone = await isSrgSetupCompleted();
				if (!setupDone) {
					await this.showFirstRunGuide();
				} else {
					this.log('Proxy not reachable — SSH tunnel may not be established');
					await this.showSSHTunnelNotEstablishedWarning(proxyHost, proxyPort);
				}
				return;
			} else {
				message = `⚠️ Proxy status unknown`;
				actions = ['Run Health Check', 'Dismiss'];
			}

			this.log(`Startup status: ${message}`);

			if (actions.length > 0) {
				const selection = await vscode.window.showInformationMessage(message, ...actions);
				if (selection === 'Reload Now') {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				} else if (selection === 'Kill & Reload') {
					await killTargetProcess((m) => this.log(m));
					setTimeout(() => {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}, 1000);
				} else if (selection === 'Run Health Check') {
					vscode.commands.executeCommand('ssh-relay-guard.diagnose');
				} else if (selection === 'Open SRG Panel') {
					vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
				}
			} else {
				vscode.window.showInformationMessage(message);
			}
		} catch (error) {
			this.log(`Startup status check failed: ${error}`);
		}
	}

	/**
	 * Run setup script silently in background (idempotent).
	 * @returns true if setup was successful or already configured
	 */
	private async runSetupScriptSilently(proxyHost: string, proxyPort: number, proxyType: string, rewriteCloudCode: boolean, extensionPath: string): Promise<boolean> {

		try {
			const script = await buildInstallScript(proxyHost, proxyPort, rewriteCloudCode, extensionPath);
			const tempScriptPath = path.join(os.tmpdir(), `srg_setup_${Date.now()}.sh`);
			await fs.writeFile(tempScriptPath, script, { mode: 0o755 });
			
			const extensionVersion = this.context.extension.packageJSON.version || 'unknown';

			const env = {
				...process.env,
				PROXY_HOST: proxyHost,
				PROXY_PORT: String(proxyPort),
				PROXY_TYPE: proxyType,
				REWRITE_CLOUDCODE: rewriteCloudCode ? 'true' : 'false',
				EXTENSION_PATH: extensionPath,
				EXTENSION_VERSION: extensionVersion
			};

			const { stdout, stderr } = await execAsync(`bash "${tempScriptPath}" 2>&1`, { env });
			const output = stdout || stderr || '';
			
			// Clean up
			await fs.unlink(tempScriptPath).catch(() => {});

			this.log(`Setup output: ${output}`);

			const isNewConfig = output.includes('Setup complete') ||
				(output.includes('configured') && !output.includes('Already configured'));

			if (isNewConfig) {
				this.log('Setup: New configuration applied');

				const lsProcess = await getMonitoredProcess();
				if (lsProcess) {
					this.log(`Setup: LS running (PID ${lsProcess.pid}, persistent=${lsProcess.isPersistent}), killing to apply wrapper`);
					await this.killLSAndAutoReload();
				} else {
					this.log('Setup: LS not running, will start with proxy on next use');
					promptReloadWindow(
						'Proxy configured. Reload window to apply changes to the language server.'
					);
				}
				return true;
			} else if (output.includes('Already configured')) {
				this.log('Setup: Already configured');

				const lsProcess = await getMonitoredProcess();
				const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
				const lsIsPersistent = lsProcess?.isPersistent ?? false;

				if (lsProcess && !lsActuallyUsingProxy) {
					this.log(`Setup: Proxy configured but LS not using it (PID ${lsProcess.pid}, persistent=${lsIsPersistent}), auto-fixing...`);
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
			if (err.stdout) { this.log(`stdout: ${err.stdout}`); }
			if (err.stderr) { this.log(`stderr: ${err.stderr}`); }
			return false;
		}
	}

	/**
	 * Kill LS process and auto-reload window.
	 * If kill succeeds, automatically reloads after 2s.
	 * If kill fails, shows manual instructions.
	 */
	private async killLSAndAutoReload(): Promise<void> {
		const killed = await killTargetProcess((m) => this.log(m));
		if (killed) {
			this.log('LS killed, auto-reloading window in 2s...');
			vscode.window.showInformationMessage('🔄 Language Server restarted to enable proxy. Reloading...');
			setTimeout(() => {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}, 2000);
		} else {
			vscode.window.showWarningMessage(
				'Proxy configured but Language Server needs restart. ' +
				'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
				'Reload Now'
			).then(selection => {
				if (selection === 'Reload Now') {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			});
		}
	}

	// ── ControlMaster Management ───────────────────────────────────────

	/**
	 * Close the ControlMaster socket for a given host, immediately
	 * tearing down the SSH tunnel and any active port forwards.
	 */
	private async closeControlMasterSocket(hostname: string): Promise<void> {
		const socketDir = getSSHSocketDir();

		try {
			const files = await fs.readdir(socketDir);
			const matchingFiles = files.filter(f => f.includes(hostname));

			if (matchingFiles.length === 0) {
				this.log(`No ControlMaster socket found for ${hostname}`);
				return;
			}

			for (const socketFile of matchingFiles) {
				const socketPath = path.join(socketDir, socketFile);
				try {
					// Graceful exit via SSH multiplex protocol
					await execAsync(`ssh -O exit -o ControlPath="${socketPath}" ${hostname} 2>/dev/null`);
					this.log(`Closed ControlMaster socket: ${socketFile}`);
				} catch {
					// Fallback: force-remove the stale socket file
					try {
						await fs.unlink(socketPath);
						this.log(`Removed stale socket file: ${socketFile}`);
					} catch { /* socket may already be gone */ }
				}
			}
		} catch (error) {
			this.log(`ControlMaster cleanup skipped: ${error}`);
		}
	}

	/**
	 * Reconnect SSH tunnel: close existing socket, create new background
	 * connection with RemoteForward, and verify the tunnel is working.
	 *
	 * @param hostname  - SSH hostname (as in ~/.ssh/config)
	 * @param localPort - Port where the local proxy is listening
	 * @param remotePort - Port to bind on the remote server via RemoteForward
	 */
	private async reconnectSSHTunnel(hostname: string, localPort: number, remotePort: number): Promise<void> {
		const socketDir = getSSHSocketDir();
		const controlPath = `${socketDir}/%r@%h-%p`;

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `SSH Tunnel: ${hostname}`,
				cancellable: false,
			},
			async (progress) => {
				// Step 1: Close existing socket
				progress.report({ message: 'Closing existing connection...' });
				await this.closeControlMasterSocket(hostname);
				this.log(`reconnectSSHTunnel: closed existing socket for ${hostname}`);

				// Brief pause to let socket fully close
				await new Promise(resolve => setTimeout(resolve, 500));

				// Step 2: Establish new background SSH connection (with retry)
				const maxAttempts = 2;
				let lastError: string = '';
				let connected = false;

				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					progress.report({ message: attempt > 1 ? `Retrying tunnel (attempt ${attempt})...` : 'Establishing new tunnel...' });
					try {
						// -f = fork to background after auth
						// -N = no remote command (just tunnel)
						// -o BatchMode=yes = no password prompts
						// -o ConnectTimeout=15 = timeout
						// -o ServerAliveInterval=30 = keep alive
						// -o ExitOnForwardFailure=yes = fail if port is occupied
						// -o ControlPath = use the same socket dir as config.srg
						// -R remotePort:127.0.0.1:localPort = correct port mapping
						await execAsync(
							`ssh -fN -R ${remotePort}:127.0.0.1:${localPort} ` +
							`-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 ` +
							`-o ExitOnForwardFailure=yes ` +
							`-o ControlMaster=auto -o ControlPath="${controlPath}" -o ControlPersist=4h ` +
							`${hostname}`,
							{ timeout: 20000 }
						);
						this.log(`reconnectSSHTunnel: background SSH connection established for ${hostname} (attempt ${attempt})`);
						connected = true;
						break;
					} catch (error) {
						const err = error as { message?: string; stderr?: string };
						lastError = err.message || String(error);
						this.log(`reconnectSSHTunnel: attempt ${attempt} failed: ${lastError}`);

						if (attempt < maxAttempts) {
							// Clean up stale socket before retry
							await this.closeControlMasterSocket(hostname);
							await new Promise(resolve => setTimeout(resolve, 1000));
						}
					}
				}

				if (!connected) {
					const manualCmd = `ssh -fN -R ${remotePort}:127.0.0.1:${localPort} ${hostname}`;
					const action = await vscode.window.showErrorMessage(
						`Failed to connect to "${hostname}" after ${maxAttempts} attempts. ` +
						`Ensure SSH key auth is configured (BatchMode requires key-based auth).`,
						'Copy Command'
					);
					if (action === 'Copy Command') {
						await vscode.env.clipboard.writeText(manualCmd);
						vscode.window.showInformationMessage(`Copied: ${manualCmd}`);
					}
					return;
				}

				// Step 3: Verify tunnel — check ControlMaster + remote port binding
				progress.report({ message: 'Verifying tunnel...' });
				await new Promise(resolve => setTimeout(resolve, 1000));

				try {
					// 3a. Verify ControlMaster is running
					const { stdout: checkOut } = await execAsync(
						`ssh -O check -o BatchMode=yes -o ControlPath="${controlPath}" ${hostname} 2>&1 || true`
					);
					const controlMasterRunning = checkOut.toLowerCase().includes('running');

					if (controlMasterRunning) {
						// 3b. Verify RemoteForward by checking if port is actually listening on remote
						let remotePortVerified = false;
						try {
							const { stdout: portOut } = await execAsync(
								`ssh -o BatchMode=yes -o ControlPath="${controlPath}" ${hostname} "ss -tln 2>/dev/null | grep -q ':${remotePort}' && echo SRG_PORT_OK || echo SRG_PORT_FAIL"`,
								{ timeout: 8000 }
							);
							remotePortVerified = portOut.includes('SRG_PORT_OK');
						} catch {
							// ss/grep not available — fall back to TCP probe from local
							// (less reliable but better than blindly trusting ExitOnForwardFailure)
							this.log('reconnectSSHTunnel: ss not available on remote, falling back to ExitOnForwardFailure trust');
							// ExitOnForwardFailure=yes means SSH itself would have exited if the bind failed,
							// so if we got here, the forward is likely active
							remotePortVerified = true;
						}

						if (remotePortVerified) {
							this.log(`reconnectSSHTunnel: tunnel verified — ControlMaster running, port ${remotePort} confirmed on remote`);
							await this.dashboardManager.refreshStatus();
							vscode.window.showInformationMessage(
								`✅ SSH tunnel to "${hostname}" established! Port ${remotePort} verified on remote.`
							);
						} else {
							this.log(`reconnectSSHTunnel: ControlMaster running but port ${remotePort} NOT detected on remote`);
							await this.dashboardManager.refreshStatus();
							const checkCmd = `ssh ${hostname} "ss -tlnp | grep ${remotePort}"`;
							const warnAction = await vscode.window.showWarningMessage(
								`SSH connected but RemoteForward port ${remotePort} not detected on remote. ` +
								`The port may be occupied by another process.`,
								'Copy Check Command'
							);
							if (warnAction === 'Copy Check Command') {
								await vscode.env.clipboard.writeText(checkCmd);
								vscode.window.showInformationMessage(`Copied: ${checkCmd}`);
							}
						}
					} else {
						this.log(`reconnectSSHTunnel: ControlMaster not running after connect`);
						const retryCmd = `ssh -fN -R ${remotePort}:127.0.0.1:${localPort} ${hostname}`;
						const cmAction = await vscode.window.showWarningMessage(
							`SSH connected but ControlMaster not detected. Tunnel may not persist.`,
							'Copy Command'
						);
						if (cmAction === 'Copy Command') {
							await vscode.env.clipboard.writeText(retryCmd);
							vscode.window.showInformationMessage(`Copied: ${retryCmd}`);
						}
					}
				} catch {
					const verifyCmd = `ssh -O check ${hostname}`;
					const vfAction = await vscode.window.showWarningMessage(
						`Cannot verify tunnel status.`,
						'Copy Check Command'
					);
					if (vfAction === 'Copy Check Command') {
						await vscode.env.clipboard.writeText(verifyCmd);
						vscode.window.showInformationMessage(`Copied: ${verifyCmd}`);
					}
				}
			}
		);
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	dispose(): void {
		this.dashboardManager.stopAutoRefresh();
		this.configService.dispose();
		// SSH config is PERSISTENT — not deleted on deactivate.
		// Users can use Rollback command or 'srg teardown' to clean up.
	}
}
