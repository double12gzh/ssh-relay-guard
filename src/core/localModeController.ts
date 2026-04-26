import * as vscode from 'vscode';
import { execAsync } from '../utils/processUtils';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { StateManager } from './stateManager';
import { TunnelManager } from './tunnelManager';
import { IModeController } from './modeController';
import { isPortReachable } from '../utils/portProbe';
import { updateForHost, readAllStatus, HostConfigData } from './sshConfigManager';

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
export class LocalModeController implements IModeController {
	constructor(
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private dashboardManager: DashboardManager,
		private tunnelManager: TunnelManager,
		private stateManager: StateManager,
		private log: (message: string) => void,
	) {}

	/**
	 * Extract per-host remote port data from SSH config hostData.
	 * Returns a Record suitable for storing in ProxyState.
	 */
	private extractHostPortData(hostData: Map<string, HostConfigData>): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [host, data] of hostData) {
			if (data.port !== undefined) {
				result[host] = data.port;
			}
		}
		return result;
	}

	/**
	 * Activate local mode: set up config callbacks, check proxy,
	 * start health monitor, listen for config changes, register commands.
	 */
	async activate(): Promise<void> {
		const enable = this.configService.enableLocalForwarding;
		const localPort = this.configService.localProxyPort;
		const remotePort = this.configService.remoteProxyPort;

		this.log(`Config: enable=${enable}, localPort=${localPort}, remotePort=${remotePort}`);

		this.stateManager.onRequestConfigApply(async () => {
			const lp = this.configService.localProxyPort;
			const rp = this.configService.remoteProxyPort;
			const enabled = this.configService.enableLocalForwarding;

			const status = await readAllStatus();
			for (const host of status.hosts) {
				const hostRemotePort = status.hostData.get(host)?.port ?? rp;
				await updateForHost(host, hostRemotePort, lp, enabled, (m) => this.log(m));
			}
			const hasHosts = status.hosts.length > 0;
			this.stateManager.updateState({
				sshConfigEnabled: enabled && hasHosts,
				hasConfiguredHosts: hasHosts,
				configuredHosts: status.hosts,
				hostPortData: this.extractHostPortData(status.hostData),
			});
		});

		const initialStatus = await readAllStatus();
		const hasHosts = initialStatus.hosts.length > 0;
		this.stateManager.updateState({
			sshConfigEnabled: initialStatus.enabled && hasHosts,
			hasConfiguredHosts: hasHosts,
			configuredHosts: initialStatus.hosts,
			hostPortData: this.extractHostPortData(initialStatus.hostData),
		});

		// First-run prompt: guide user to configure their first remote host
		if (initialStatus.hosts.length === 0) {
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
		this.tunnelManager.startHealthMonitor((activeCount) => {
			this.stateManager.updateState({ activeTunnelsCount: activeCount });
		});

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
				const hs = status.hosts.length > 0;
				this.stateManager.updateState({
					sshConfigEnabled: enabled && hs,
					hasConfiguredHosts: hs,
					configuredHosts: status.hosts,
					hostPortData: this.extractHostPortData(status.hostData),
				});
				await this.dashboardManager.refreshStatus();
			}),
		);
	}

	// ── Commands ────────────────────────────────────────────────────────

	public async enableForwarding(): Promise<void> {
		const hostname = await vscode.window.showInputBox({
			prompt: 'Enter the SSH hostname to configure (as in ~/.ssh/config)',
			placeHolder: 'e.g., my-server or user@192.168.1.100',
		});
		if (!hostname) {
			return;
		}

		// Validate hostname to prevent command injection
		if (!/^[\w.\-@]+$/.test(hostname)) {
			vscode.window.showErrorMessage(
				'Invalid hostname format. Only alphanumeric characters, dots, hyphens, underscores, and @ are allowed.',
			);
			return;
		}

		const lp = this.configService.localProxyPort;
		const rp = this.configService.remoteProxyPort;
		await updateForHost(hostname, rp, lp, true, (m) => this.log(m));

		const status = await readAllStatus();
		const hs = status.hosts.length > 0;
		this.stateManager.updateState({
			sshConfigEnabled: status.enabled && hs,
			hasConfiguredHosts: hs,
			configuredHosts: status.hosts,
			hostPortData: this.extractHostPortData(status.hostData),
		});
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
			this.log(`ControlMaster check skipped for ${hostname} (not configured or failed)`);
		}

		if (hasExistingSocket) {
			this.log(
				`Detected existing SSH connection for ${hostname}. Closing to apply RemoteForward.`,
			);
			try {
				await execAsync(`ssh -O exit ${hostname}`);
			} catch (e) {
				this.log(`Failed to exit existing SSH connection: ${e}`);
			}
			vscode.window.showInformationMessage(
				`SSH config for "${hostname}" saved. Restarting existing SSH connection to apply proxy configuration...`,
			);
		} else {
			vscode.window.showInformationMessage(
				`SSH config for "${hostname}" saved. Establishing SSH tunnel...`,
			);
		}

		await this.reconnectSSHTunnel(hostname, lp, rp);
	}

	public async disableForwarding(): Promise<void> {
		const status = await readAllStatus();
		if (status.hosts.length === 0) {
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

		const activeTunnels = this.tunnelManager.getManagedHosts().length;

		await updateForHost(hostname, 0, 0, false, (m) => this.log(m));
		const newStatus = await readAllStatus();
		const hs = newStatus.hosts.length > 0;
		this.stateManager.updateState({
			sshConfigEnabled: newStatus.enabled && hs,
			hasConfiguredHosts: hs,
			configuredHosts: newStatus.hosts,
			hostPortData: this.extractHostPortData(newStatus.hostData),
			activeTunnelsCount: activeTunnels,
		});
		await this.dashboardManager.refreshStatus();
		vscode.window.showInformationMessage(`SSH forwarding removed for host: ${hostname}`);
	}

	public async tunnelStatus(): Promise<void> {
		const status = await readAllStatus();
		const hs = status.hosts.length > 0;
		this.stateManager.updateState({
			sshConfigEnabled: status.enabled && hs,
			hasConfiguredHosts: hs,
			configuredHosts: status.hosts,
			hostPortData: this.extractHostPortData(status.hostData),
		});
		if (status.hosts.length > 0) {
			vscode.window.showInformationMessage(
				`Forwarding configured for: ${status.hosts.join(', ')} (port ${status.port})`,
			);
		} else {
			vscode.window.showInformationMessage('SSH port forwarding is not configured');
		}
	}

	public async reconnectTunnel(): Promise<void> {
		const allStatus = await readAllStatus();
		if (!allStatus.hosts || allStatus.hosts.length === 0) {
			vscode.window.showWarningMessage(
				'No hosts configured. Use "Add Host Forwarding" first.',
			);
			return;
		}

		// If only one host, skip the picker
		let hostname: string | undefined;
		if (allStatus.hosts.length === 1) {
			hostname = allStatus.hosts[0];
		} else {
			hostname = await vscode.window.showQuickPick(allStatus.hosts, {
				placeHolder: 'Select host to reconnect tunnel for',
			});
		}
		if (!hostname) {
			return;
		}

		const hostData = allStatus.hostData.get(hostname);
		const rp = hostData?.port ?? this.configService.remoteProxyPort;
		const lp = hostData?.localPort ?? this.configService.localProxyPort;

		this.log(
			`Reconnect command: forcing tunnel re-establishment for ${hostname} (${lp} → ${rp})`,
		);

		await this.reconnectSSHTunnel(hostname, lp, rp);
	}

	// ── Tunnel Reconnection ────────────────────────────────────────────

	/**
	 * Reconnect SSH tunnel: delegates to TunnelManager which spawns the Go daemon.
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
				progress.report({
					message: 'Starting native Go daemon (auto-reconnect enabled)...',
				});

				const { connected, negotiatedPort, logContent } =
					await this.tunnelManager.startTunnel(hostname, localPort, remotePort);

				const activeTunnels = this.tunnelManager.getManagedHosts().length;
				this.stateManager.updateState({ activeTunnelsCount: activeTunnels });

				if (!connected) {
					// Surface daemon log in output channel so "Show Logs" is immediately useful
					if (logContent) {
						this.log(`── SSH Tunnel Daemon Log (${hostname}) ──`);
						this.log(logContent);
						this.log(`── End of Daemon Log ──`);
					}

					const manualCmd = `srg-tunnel-client -host ${hostname} -local-port ${localPort} -remote-port ${remotePort}`;
					const action = await vscode.window.showErrorMessage(
						`Failed to establish SSH tunnel to "${hostname}". ` +
							`Possible causes: SSH key not configured, or host unreachable. Check logs for details.`,
						'Show Logs',
						'Copy Manual Command',
					);
					if (action === 'Copy Manual Command') {
						await vscode.env.clipboard.writeText(manualCmd);
						vscode.window.showInformationMessage(`Copied: ${manualCmd}`);
					} else if (action === 'Show Logs') {
						vscode.commands.executeCommand('ssh-relay-guard.showOutput');
					}
					return;
				}

				if (negotiatedPort !== remotePort) {
					this.log(
						`reconnectSSHTunnel: tunnel established, but port changed from ${remotePort} to ${negotiatedPort}`,
					);
					vscode.window.showWarningMessage(
						`✅ SSH tunnel established, but port ${remotePort} was in use. Dynamically bound to ${negotiatedPort} instead.`,
					);

					// Update SSH config to reflect the new port so remote side picks it up
					await updateForHost(hostname, negotiatedPort!, localPort, true, (m) =>
						this.log(m),
					);

					const updatedStatus = await readAllStatus();
					const hs = updatedStatus.hosts.length > 0;
					this.stateManager.updateState({
						sshConfigEnabled: updatedStatus.enabled && hs,
						hasConfiguredHosts: hs,
						configuredHosts: updatedStatus.hosts,
						hostPortData: this.extractHostPortData(updatedStatus.hostData),
					});
				} else {
					this.log(
						`reconnectSSHTunnel: tunnel established on requested port ${remotePort}`,
					);
					vscode.window.showInformationMessage(
						`SSH tunnel to "${hostname}" re-established successfully on port ${remotePort}.`,
					);
				}

				// ALWAYS update global remoteProxyPort setting so the remote extension
				// picks up the negotiated port for http.proxy and LS wrapper.
				// This is critical in multi-window scenarios: even if negotiatedPort === remotePort
				// (the port in ~/.ssh/config), the global VS Code setting might have been
				// changed by another host's window! We must claim it back.
				try {
					const config = vscode.workspace.getConfiguration('ssh-relay-guard');
					if (config.get('remoteProxyPort') !== negotiatedPort) {
						await config.update(
							'remoteProxyPort',
							negotiatedPort,
							vscode.ConfigurationTarget.Global,
						);
						this.log(`Synced global remoteProxyPort to ${negotiatedPort}`);
					}
				} catch (e) {
					this.log(`Failed to sync remoteProxyPort to workspace settings: ${e}`);
				}
				this.dashboardManager.setLocalReconnectionState(false);
				await this.dashboardManager.refreshStatus();
			},
		);
	}
}
