import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { TunnelManager } from './tunnelManager';
import { isPortReachable } from '../utils/portProbe';
import { updateForHost, readStatus, readAllStatus } from './sshConfigManager';

const _execAsync = promisify(exec);
const execAsync = async (
	cmd: string,
	options?: any,
): Promise<{ stdout: string; stderr: string }> => {
	const res = await _execAsync(cmd, { maxBuffer: 1024 * 1024 * 10, ...options });
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

/**
 * LocalModeController — Handles all local-side SRG functionality.
 *
 * Responsibilities:
 * - Register local-only VS Code commands (enableForwarding, disableForwarding, tunnelStatus)
 * - Manage SSH config for hosts (via sshConfigManager)
 * - Reconnect SSH tunnels (via TunnelManager, with progress UI)
 * - Suggest autossh installation
 * - Listen for configuration changes and propagate to SSH config
 */
export class LocalModeController {
	constructor(
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private dashboardManager: DashboardManager,
		private tunnelManager: TunnelManager,
		private log: (message: string) => void,
	) {}

	/**
	 * Activate local mode: set up config callbacks, check proxy,
	 * start health monitor, listen for config changes, register commands.
	 */
	async activate(): Promise<void> {
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
		this.dashboardManager.updateSSHConfigStatus(
			initialStatus.enabled,
			initialStatus.port,
			initialStatus.hosts,
		);

		// First-run prompt: guide user to configure their first remote host
		if (!initialStatus.hosts || initialStatus.hosts.length === 0) {
			this.log('No hosts configured — showing first-run prompt');
			vscode.window
				.showInformationMessage(
					'👋 SSH Relay Guard installed! Configure your first remote host to enable proxy forwarding.',
					'Add Host Now',
				)
				.then((action) => {
					if (action === 'Add Host Now') {
						vscode.commands.executeCommand('ssh-relay-guard.enableForwarding');
					}
				});
		}

		if (enable && !(await isPortReachable('127.0.0.1', localPort))) {
			vscode.window.showWarningMessage(
				`Local proxy at 127.0.0.1:${localPort} is not running. ` +
					`Also check if port ${remotePort} is occupied on the remote server before reconnecting.`,
			);
		}

		await this.dashboardManager.refreshStatus();

		// Start tunnel health monitor — periodically checks ControlMaster sockets
		// and automatically reconnects any dead tunnels (via autossh or plain ssh).
		this.tunnelManager.startHealthMonitor();

		// Use ConfigService.onChange() — ConfigService handles reload internally,
		// so cached values are already up-to-date when this fires.
		this.context.subscriptions.push(
			this.configService.onChange(async () => {
				const lp = this.configService.localProxyPort;
				const rp = this.configService.remoteProxyPort;
				const enabled = this.configService.enableLocalForwarding;

				const status = await readAllStatus();
				for (const host of status.hosts) {
					const hostRemotePort = status.hostData.get(host)?.port ?? rp;
					await updateForHost(host, hostRemotePort, lp, enabled, (m) => this.log(m));
				}
				this.dashboardManager.updateSSHConfigStatus(enabled, rp, status.hosts);
				await this.dashboardManager.refreshStatus();
			}),
		);

		this.registerLocalCommands();
	}

	// ── Commands ────────────────────────────────────────────────────────

	private registerLocalCommands(): void {
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ssh-relay-guard.enableForwarding', async () => {
				const hostname = await vscode.window.showInputBox({
					prompt: 'Enter the SSH hostname to configure (as in ~/.ssh/config)',
					placeHolder: 'e.g., my-server or user@192.168.1.100',
				});
				if (!hostname) {
					return;
				}

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
					const { stdout } = await execAsync(`ssh -O check ${hostname} 2>&1 || true`);
					hasExistingSocket = stdout.toLowerCase().includes('running');
				} catch {
					this.log(
						`ControlMaster check skipped for ${hostname} (not configured or failed)`,
					);
				}

				if (hasExistingSocket) {
					const action = await vscode.window.showWarningMessage(
						`SSH config for "${hostname}" saved (port ${rp}).\n\n` +
							`⚠️ Detected an existing SSH connection. RemoteForward won't take effect until you reconnect.\n` +
							`Close current connection and reconnect to activate the tunnel?`,
						'Close & Reconnect',
						"OK, I'll reconnect later",
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
						'Later',
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
				if (!hostname) {
					return;
				}

				// Warn: closing ControlMaster will terminate active remote sessions
				const confirm = await vscode.window.showWarningMessage(
					`This will disconnect the SSH tunnel for "${hostname}" and may terminate any active remote VS Code sessions to this host.\n\nContinue?`,
					{ modal: true },
					'Yes, Disconnect',
					'Cancel',
				);
				if (confirm !== 'Yes, Disconnect') {
					return;
				}

				// Stop the managed tunnel (kills autossh/ssh + closes socket)
				await this.tunnelManager.stopTunnel(hostname);

				await updateForHost(hostname, 0, 0, false, (m) => this.log(m));
				const newStatus = await readStatus();
				this.dashboardManager.updateSSHConfigStatus(
					newStatus.enabled,
					newStatus.port,
					newStatus.hosts,
				);
				await this.dashboardManager.refreshStatus();
				vscode.window.showInformationMessage(
					`SSH forwarding removed for host: ${hostname}`,
				);
			}),

			vscode.commands.registerCommand('ssh-relay-guard.tunnelStatus', async () => {
				const status = await readStatus();
				this.dashboardManager.updateSSHConfigStatus(
					status.enabled,
					status.port,
					status.hosts,
				);
				if (status.hosts && status.hosts.length > 0) {
					vscode.window.showInformationMessage(
						`Forwarding configured for: ${status.hosts.join(', ')} (port ${status.port})`,
					);
				} else {
					vscode.window.showInformationMessage('SSH port forwarding is not configured');
				}
			}),
		);
	}

	// ── Tunnel Reconnection ────────────────────────────────────────────

	/**
	 * Reconnect SSH tunnel: delegates to TunnelManager which uses autossh
	 * (with automatic reconnection) or falls back to plain ssh.
	 *
	 * @param hostname  - SSH hostname (as in ~/.ssh/config)
	 * @param localPort - Port where the local proxy is listening
	 * @param remotePort - Port to bind on the remote server via RemoteForward
	 */
	private async reconnectSSHTunnel(
		hostname: string,
		localPort: number,
		remotePort: number,
	): Promise<void> {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `SSH Tunnel: ${hostname}`,
				cancellable: false,
			},
			async (progress) => {
				// Step 1: Start tunnel via TunnelManager (handles autossh/ssh + retry)
				const useAutossh = await this.tunnelManager.isAutosshAvailable();
				progress.report({
					message: useAutossh
						? 'Starting autossh tunnel (auto-reconnect enabled)...'
						: 'Establishing SSH tunnel...',
				});

				const connected = await this.tunnelManager.startTunnel(
					hostname,
					localPort,
					remotePort,
				);

				if (!connected) {
					const manualCmd = `ssh -fN -R ${remotePort}:127.0.0.1:${localPort} ${hostname}`;
					const action = await vscode.window.showErrorMessage(
						`Failed to connect to "${hostname}". ` +
							`Ensure SSH key auth is configured (BatchMode requires key-based auth).`,
						'Copy Command',
					);
					if (action === 'Copy Command') {
						await vscode.env.clipboard.writeText(manualCmd);
						vscode.window.showInformationMessage(`Copied: ${manualCmd}`);
					}
					return;
				}

				// Step 2: Verify tunnel — check ControlMaster + remote port binding
				progress.report({ message: 'Verifying tunnel...' });
				await new Promise((resolve) => setTimeout(resolve, 1000));

				const { controlMasterRunning, remotePortVerified } =
					await this.tunnelManager.verifyTunnel(hostname, remotePort);

				if (controlMasterRunning && remotePortVerified) {
					this.log(
						`reconnectSSHTunnel: tunnel verified — ControlMaster running, port ${remotePort} confirmed on remote`,
					);
					await this.dashboardManager.refreshStatus();
					const autosshNote = useAutossh ? ' (autossh: auto-reconnect enabled)' : '';
					vscode.window.showInformationMessage(
						`✅ SSH tunnel to "${hostname}" established! Port ${remotePort} verified on remote.${autosshNote}`,
					);

					// One-time suggestion to install autossh for auto-reconnect
					if (!useAutossh) {
						await this.suggestAutosshInstall();
					}
				} else if (controlMasterRunning && !remotePortVerified) {
					this.log(
						`reconnectSSHTunnel: ControlMaster running but port ${remotePort} NOT detected on remote`,
					);
					await this.dashboardManager.refreshStatus();
					const checkCmd = `ssh ${hostname} "ss -tlnp | grep ${remotePort}"`;
					const warnAction = await vscode.window.showWarningMessage(
						`SSH connected but RemoteForward port ${remotePort} not detected on remote. ` +
							`The port may be occupied by another process.`,
						'Copy Check Command',
					);
					if (warnAction === 'Copy Check Command') {
						await vscode.env.clipboard.writeText(checkCmd);
						vscode.window.showInformationMessage(`Copied: ${checkCmd}`);
					}
				} else {
					this.log(`reconnectSSHTunnel: ControlMaster not running after connect`);
					await this.dashboardManager.refreshStatus();
					if (useAutossh) {
						vscode.window.showInformationMessage(
							`autossh started for "${hostname}" — tunnel will be established once the connection is ready.`,
						);
					} else {
						const retryCmd = `ssh -fN -R ${remotePort}:127.0.0.1:${localPort} ${hostname}`;
						const cmAction = await vscode.window.showWarningMessage(
							`SSH connected but ControlMaster not detected. Tunnel may not persist.`,
							'Copy Command',
						);
						if (cmAction === 'Copy Command') {
							await vscode.env.clipboard.writeText(retryCmd);
							vscode.window.showInformationMessage(`Copied: ${retryCmd}`);
						}
					}
				}
			},
		);
	}

	// ── autossh Suggestion ─────────────────────────────────────────────

	/**
	 * Show a one-time suggestion to install autossh for automatic tunnel reconnection.
	 * Uses globalState to ensure the prompt is only shown once (or until the user
	 * dismisses it permanently via "Don't show again").
	 */
	private async suggestAutosshInstall(): Promise<void> {
		const SUPPRESS_KEY = 'autosshSuggestionDismissed';
		const dismissed = this.context.globalState.get<boolean>(SUPPRESS_KEY, false);
		if (dismissed) {
			return;
		}

		const isMac = process.platform === 'darwin';
		const installCmd = isMac ? 'brew install autossh' : 'sudo apt install autossh';

		const selection = await vscode.window.showInformationMessage(
			`💡 建议安装 autossh 以启用隧道自动重连。当 SSH 隧道断开时，autossh 可自动恢复连接。\n\n` +
				`安装命令：${installCmd}`,
			'Copy Install Command',
			"Don't show again",
		);

		if (selection === 'Copy Install Command') {
			await vscode.env.clipboard.writeText(installCmd);
			vscode.window.showInformationMessage(`Copied: ${installCmd}`);
		} else if (selection === "Don't show again") {
			await this.context.globalState.update(SUPPRESS_KEY, true);
		}
	}
}
