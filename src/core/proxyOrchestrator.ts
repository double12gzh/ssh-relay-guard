import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { buildInstallScript, buildRestoreScript } from '../setup/remoteInstaller';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { isPortReachable, isRunningLocally } from '../utils/portProbe';
import { updateForHost, readStatus, readAllStatus } from './sshConfigManager';
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
			this.dashboardManager.updateSSHConfigStatus(enabled, rp);
		});

		const initialStatus = await readStatus();
		this.dashboardManager.updateSSHConfigStatus(initialStatus.enabled, initialStatus.port);

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

					const status = await readAllStatus();
					for (const host of status.hosts) {
						const hostRemotePort = status.hostData.get(host)?.port ?? rp;
						await updateForHost(host, hostRemotePort, lp, enabled, (m) => this.log(m));
					}
					this.dashboardManager.updateSSHConfigStatus(enabled, rp);
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
				this.dashboardManager.updateSSHConfigStatus(true, rp);
				await this.dashboardManager.refreshStatus();
				vscode.window.showInformationMessage(`SSH forwarding configured for ${hostname}`);
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

				await updateForHost(hostname, 0, 0, false, (m) => this.log(m));
				const newStatus = await readStatus();
				this.dashboardManager.updateSSHConfigStatus(newStatus.enabled, newStatus.port);
				await this.dashboardManager.refreshStatus();
				vscode.window.showInformationMessage(`SSH forwarding removed for ${hostname}`);
			}),

			vscode.commands.registerCommand('ssh-relay-guard.tunnelStatus', async () => {
				const status = await readStatus();
				this.dashboardManager.updateSSHConfigStatus(status.enabled, status.port);
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
		if (inspected?.globalValue && inspected.globalValue !== '' && !inspected.globalValue.includes(String(proxyPort))) {
			this.log(`http.proxy has user-configured value "${inspected.globalValue}", not overriding`);
			return;
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
			return;
		}

		const extensionPath = this.context.extensionUri.fsPath;

		await this.ensureMgraftcpExecutable(extensionPath);

		this.dashboardManager.setConfigChangeCallback(async () => {
			const host = this.configService.remoteProxyHost;
			const port = this.configService.remoteProxyPort;
			const type = this.configService.proxyType;
			this.log(`Config changed from panel, re-running setup: ${host}:${port} (${type})`);
			const success = await this.runSetupScriptSilently(host, port, type, extensionPath);
			this.dashboardManager.updateLanguageServerStatus(success);
		});

		this.log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);

		await this.dashboardManager.refreshStatus();

		this.log(`Extension path: ${extensionPath}`);
		this.log('Auto-running setup script...');
		const setupSuccess = await this.runSetupScriptSilently(remoteHost, remotePort, proxyType, extensionPath);
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
					this.log(`Config changed, re-running setup: ${host}:${port} (${type})`);
					const success = await this.runSetupScriptSilently(host, port, type, extensionPath);
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
				const terminal = vscode.window.createTerminal('SRG Setup');
				terminal.show();
				const script = await buildInstallScript(host, port, extensionPath);
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

		const showStatusOnStartup = this.configService.showStatusOnStartup;
		if (showStatusOnStartup) {
			setTimeout(async () => {
				await this.showStartupStatus(remoteHost, remotePort);
			}, 2000);
		}
	}

	// ── First-Run Detection ────────────────────────────────────────────

	/**
	 * Check if this is the first time SRG is running on this remote server.
	 * Detects prior setup by checking for ~/bin/srg-on (deployed by setup-proxy.sh).
	 */
	private async isFirstRun(): Promise<boolean> {
		try {
			const srgOnPath = path.join(os.homedir(), 'bin', 'srg-on');
			await fs.access(srgOnPath);
			return false; // srg-on exists → not first run
		} catch {
			return true; // srg-on missing → first run
		}
	}

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
			'Step 2: In the local SRG panel, run "Enable Port Forwarding" for this host\n' +
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
		const detailMessage =
			`Proxy not reachable at ${proxyHost}:${proxyPort}\n\n` +
			`Common causes (most likely first):\n\n` +
			`1. Local proxy not running\n` +
			`   Start your proxy software (Clash, V2Ray, etc.) and ensure it listens on the configured Local Port.\n\n` +
			`2. Remote port occupied\n` +
			`   Another process may be using port ${proxyPort}. Check with: ss -tlnp | grep ${proxyPort}\n\n` +
			`3. SSH tunnel not established\n` +
			`   The RemoteForward may not be active. Reconnect to re-establish the tunnel.\n\n` +
			`4. Port mismatch\n` +
			`   Ensure "Remote Port" (local panel) matches "Proxy Port" (remote panel).`;

		this.log('Showing proxy not reachable warning dialog');

		const selection = await vscode.window.showWarningMessage(
			detailMessage,
			{ modal: true },
			'Open SRG Panel',
			'Run Health Check',
			'Close Remote Connection',
			'Dismiss'
		);

		if (selection === 'Open SRG Panel') {
			vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
		} else if (selection === 'Run Health Check') {
			vscode.commands.executeCommand('ssh-relay-guard.diagnose');
		} else if (selection === 'Close Remote Connection') {
			vscode.window.showInformationMessage(
				'After closing: 1) Open a new local window  2) Connect to remote from there',
				'Got it'
			).then(() => {
				vscode.commands.executeCommand('workbench.action.remote.close');
			});
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

			if (proxyReachable) {
				const currentProxyType = this.configService.proxyType;

				this.log(`[Test 3] Testing HTTP proxy connectivity...`);
				const httpCmd = `curl -x http://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
				this.log(`  Command: ${httpCmd}`);
				try {
					const { stdout } = await execAsync(httpCmd, { timeout: 15000 });
					const httpCode = stdout.trim();
					const httpOk = httpCode === '200' || httpCode === '301' || httpCode === '302';
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
					const socks5Ok = httpCode === '200' || httpCode === '301' || httpCode === '302';
					const marker = currentProxyType === 'socks5' ? ' ← Current' : '';
					this.log(`  Result: HTTP ${httpCode} ${socks5Ok ? '✓ OK' : '✗ Failed'}${marker}`);
				} catch {
					const marker = currentProxyType === 'socks5' ? ' ← Current (⚠️ NOT WORKING)' : '';
					this.log(`  Result: ✗ Failed${marker}`);
				}
				this.log('');
			}

			this.log('==========================================');
			this.log('');

			let message: string;
			let actions: string[] = [];

			const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
			const lsIsPersistent = lsProcess?.isPersistent ?? false;
			const lsNeedsRestart = lsProcess && lsIsPersistent && !lsActuallyUsingProxy;

			if (proxyReachable && lsActuallyUsingProxy) {
				message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
			} else if (proxyReachable && lsNeedsRestart) {
				this.log('Startup: Detected persistent_mode LS not using proxy, auto-fixing...');
				const killed = await killTargetProcess((m) => this.log(m));
				if (killed) {
					message = `🔄 Language Server restarted to enable proxy. Reloading...`;
					actions = ['Reload Now'];
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
				const firstRun = await this.isFirstRun();
				if (firstRun) {
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
	private async runSetupScriptSilently(proxyHost: string, proxyPort: number, proxyType: string, extensionPath: string): Promise<boolean> {
		const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

		try {
			await execAsync(`chmod +x "${scriptPath}"`);

			const packageJsonPath = path.join(extensionPath, 'package.json');
			let extensionVersion = 'unknown';
			try {
				const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
				const packageJson = JSON.parse(packageJsonContent);
				extensionVersion = packageJson.version || 'unknown';
			} catch (e) {
				this.log(`Failed to read package.json: ${e}`);
			}

			const env = {
				...process.env,
				PROXY_HOST: proxyHost,
				PROXY_PORT: String(proxyPort),
				PROXY_TYPE: proxyType,
				EXTENSION_PATH: extensionPath,
				EXTENSION_VERSION: extensionVersion
			};

			const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, { env });
			const output = stdout || stderr || '';

			this.log(`Setup output: ${output}`);

			const isNewConfig = output.includes('Setup complete') ||
				(output.includes('configured') && !output.includes('Already configured'));

			if (isNewConfig) {
				this.log('Setup: New configuration applied');

				const lsProcess = await getMonitoredProcess();
				if (lsProcess && lsProcess.isPersistent) {
					this.log('Setup: LS is in persistent_mode, killing to apply new configuration');
					await this.killLSAndPromptReload('Proxy updated. Language Server restarted. Please reload the window to reconnect.');
				} else {
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
					this.log('Setup: Proxy configured but LS not using it');

					if (lsIsPersistent) {
						this.log('Setup: Language Server is in persistent_mode, killing process to force restart through wrapper');
						await this.killLSAndPromptReload('Language Server restarted to enable proxy. Please reload the window to reconnect.');
					} else {
						this.log('Setup: Prompting reload');
						promptReloadWindow(
							'Proxy is configured but not active. Reload window to enable proxy for the language server.'
						);
					}
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
	 * Kill LS process and prompt reload. Shows a fallback warning if kill fails.
	 * Extracted to avoid repeating the same kill → prompt/warn pattern.
	 */
	private async killLSAndPromptReload(successMessage: string): Promise<void> {
		const killed = await killTargetProcess((m) => this.log(m));
		if (killed) {
			promptReloadWindow(successMessage);
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

	// ── Lifecycle ──────────────────────────────────────────────────────

	dispose(): void {
		this.dashboardManager.stopAutoRefresh();
		this.configService.dispose();
		// SSH config is PERSISTENT — not deleted on deactivate.
		// Users can use Rollback command or 'srg teardown' to clean up.
	}
}
