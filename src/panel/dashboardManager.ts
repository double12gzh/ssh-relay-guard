import * as vscode from 'vscode';
import { runDiagnostics, DiagnosticReport, generateReportText } from '../diagnostics/healthChecker';
import { ConnectionMonitor, TrafficStats } from '../traffic/connectionMonitor';
import { ConfigService } from '../core/configService';
import { isPortReachable, isProxyFunctional, isSrgSetupCompleted } from '../utils/portProbe';
import { killTargetProcess } from '../utils/processUtils';
import { dict, Lang } from './translations';
import {
	buildPanelHtml,
	buildTrafficHtml,
	PanelContext,
	resolveStatusAppearance,
} from './panelRenderer';

export interface ProxyStatus {
	runningLocation: 'local' | 'remote';
	sshConfigEnabled: boolean;
	localProxyPort: number;
	remoteProxyPort: number;
	remoteProxyHost: string;
	localProxyReachable: boolean;
	remoteProxyReachable: boolean;
	/** True only when the remote port responds like a real proxy (protocol handshake). */
	remoteProxyFunctional: boolean;
	lastUpdated: Date;
	languageServerConfigured?: boolean;
	remoteSetupCompleted?: boolean;
	/** Whether any host has been configured locally (config.srg has entries) */
	hasConfiguredHosts?: boolean;
	/** List of configured host names from config.srg */
	configuredHosts?: string[];
}

type StatusUpdateCallback = (status: ProxyStatus) => void;
type ConfigChangeCallback = () => Promise<void>;

const REFRESH_INTERVAL_SEC = 30;

export class DashboardManager {
	private statusBarItem: vscode.StatusBarItem;
	private currentStatus: ProxyStatus;
	private updateCallbacks: StatusUpdateCallback[] = [];
	private refreshInterval: NodeJS.Timeout | undefined;
	private statusPanel: vscode.WebviewPanel | undefined;
	private countdownInterval: NodeJS.Timeout | undefined;
	private secondsUntilRefresh: number = REFRESH_INTERVAL_SEC;
	private onConfigChange: ConfigChangeCallback | undefined;

	// New properties for unified dashboard
	private connectionMonitor: ConnectionMonitor;
	private currentDiagnosticReport: DiagnosticReport | null = null;
	private isRunningDiagnostics: boolean = false;
	private isVerifying: boolean = false;
	private currentLang: Lang = 'zh';
	/** Track previous proxy reachability to detect disconnection transitions. */
	private previousProxyReachable: boolean | null = null;

	constructor(
		private isLocal: boolean,
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			-100,
		);
		this.statusBarItem.command = 'ssh-relay-guard.showStatusPanel';
		this.statusBarItem.name = 'SRG';

		this.currentStatus = {
			runningLocation: isLocal ? 'local' : 'remote',
			sshConfigEnabled: false,
			localProxyPort: configService.localProxyPort,
			remoteProxyPort: configService.remoteProxyPort,
			remoteProxyHost: configService.remoteProxyHost,
			localProxyReachable: false,
			remoteProxyReachable: false,
			remoteProxyFunctional: false,
			lastUpdated: new Date(),
		};

		// Initialize connection monitor
		this.connectionMonitor = new ConnectionMonitor(configService);

		// Load saved language preference (default to Chinese)
		this.currentLang = this.context.globalState.get<Lang>('uiLanguage', 'zh');

		this.updateStatusBar();
		this.statusBarItem.show();
	}

	/**
	 * Set the verifying state — when true, status bar shows spinning icon.
	 * Used during startup full-connectivity checks to prevent premature green.
	 */
	setVerifying(verifying: boolean): void {
		this.isVerifying = verifying;
		this.updateStatusBar();
	}

	/**
	 * Set config change callback for SSH config updates
	 */
	setConfigChangeCallback(callback: ConfigChangeCallback): void {
		this.onConfigChange = callback;
	}

	onStatusUpdate(callback: StatusUpdateCallback): vscode.Disposable {
		this.updateCallbacks.push(callback);
		return new vscode.Disposable(() => {
			const index = this.updateCallbacks.indexOf(callback);
			if (index >= 0) {
				this.updateCallbacks.splice(index, 1);
			}
		});
	}

	startAutoRefresh(): void {
		this.stopAutoRefresh();
		this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;

		this.refreshInterval = setInterval(() => {
			this.refreshStatus();
			this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
		}, REFRESH_INTERVAL_SEC * 1000);

		this.countdownInterval = setInterval(() => {
			this.secondsUntilRefresh = Math.max(0, this.secondsUntilRefresh - 1);
			this.updatePanelCountdown();
		}, 1000);

		this.refreshStatus();
	}

	stopAutoRefresh(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
		if (this.countdownInterval) {
			clearInterval(this.countdownInterval);
			this.countdownInterval = undefined;
		}
	}

	async refreshStatus(): Promise<void> {
		this.currentStatus.localProxyPort = this.configService.localProxyPort;
		this.currentStatus.remoteProxyPort = this.configService.remoteProxyPort;
		this.currentStatus.remoteProxyHost = this.configService.remoteProxyHost;

		if (this.isLocal) {
			this.currentStatus.localProxyReachable = await isPortReachable(
				'127.0.0.1',
				this.currentStatus.localProxyPort,
			);
		} else {
			const proxyType = this.configService.proxyType as 'http' | 'socks5';
			const [functional, setupDone] = await Promise.all([
				isProxyFunctional(
					this.currentStatus.remoteProxyHost,
					this.currentStatus.remoteProxyPort,
					proxyType,
				),
				isSrgSetupCompleted(),
			]);

			// If proxy is functional at protocol level, it guarantees port reachability
			const reachable = functional;

			this.currentStatus.remoteProxyReachable = reachable;
			this.currentStatus.remoteProxyFunctional = functional;
			this.currentStatus.remoteSetupCompleted = setupDone;

			// Detect proxy disconnect transition: was reachable → now unreachable
			if (this.previousProxyReachable === true && !reachable && setupDone) {
				const t = dict[this.currentLang];
				vscode.window
					.showWarningMessage(t.tunnelDisconnected, t.runDiag, t.closeRemote)
					.then((selection) => {
						if (selection === t.runDiag) {
							vscode.commands.executeCommand('ssh-relay-guard.diagnose');
						} else if (selection === t.closeRemote) {
							vscode.commands.executeCommand('workbench.action.remote.close');
						}
					});
			}
			this.previousProxyReachable = reachable;
		}

		this.currentStatus.lastUpdated = new Date();
		this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
		this.updateStatusBar();
		this.updatePanelIfOpen();
		this.notifyCallbacks();
	}

	updateSSHConfigStatus(enabled: boolean, port?: number, hosts?: string[]): void {
		const hasHosts = hosts !== undefined && hosts.length > 0;
		this.currentStatus.sshConfigEnabled = enabled && hasHosts;
		if (port !== undefined) {
			this.currentStatus.remoteProxyPort = port;
		}
		this.currentStatus.hasConfiguredHosts = hasHosts;
		this.currentStatus.configuredHosts = hosts;
		this.currentStatus.lastUpdated = new Date();
		this.updateStatusBar();
		this.updatePanelIfOpen();
		this.notifyCallbacks();
	}

	updateLanguageServerStatus(configured: boolean): void {
		this.currentStatus.languageServerConfigured = configured;
		this.currentStatus.lastUpdated = new Date();
		this.updateStatusBar();
		this.updatePanelIfOpen();
		this.notifyCallbacks();
	}

	getStatus(): ProxyStatus {
		return { ...this.currentStatus };
	}

	showStatusPanel(): void {
		if (this.statusPanel) {
			this.statusPanel.reveal();
			return;
		}

		this.statusPanel = vscode.window.createWebviewPanel(
			'srgStatus',
			'SSH Relay Guard',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		// Start connection monitor when panel opens (remote only)
		if (!this.isLocal) {
			this.connectionMonitor.start();
			this.connectionMonitor.onUpdate(() => {
				this.updatePanelIfOpen();
			});
		}

		this.statusPanel.webview.html = this.getPanelHtml();

		const messageHandlers: Record<
			string,
			(message: Record<string, unknown>) => Promise<void> | void
		> = {
			refresh: async () => {
				await this.refreshStatus();
				if (!this.isLocal) {
					await this.connectionMonitor.refresh();
				}
			},
			saveConfig: async (msg) => {
				await this.saveConfig(msg.config as Parameters<DashboardManager['saveConfig']>[0]);
			},
			runDiagnostics: async () => {
				await this.runInlineDiagnostics();
			},
			copyReport: async () => {
				await this.copyDiagnosticReport();
			},
			setLanguage: async (msg) => {
				this.currentLang = msg.lang as Lang;
				await this.context.globalState.update('uiLanguage', this.currentLang);
				this.forceRenderPanel();
			},
			closeRemote: async () => {
				let hostname = 'your-host';
				const remoteName = vscode.env.remoteName;
				if (remoteName && remoteName !== 'ssh-remote') {
					hostname = remoteName;
				} else {
					const sshConn = process.env['SSH_CONNECTION'];
					if (sshConn) {
						try {
							// eslint-disable-next-line @typescript-eslint/no-require-imports
							const { execSync } = require('child_process');
							hostname = String(
								execSync('hostname -s 2>/dev/null || hostname', { timeout: 2000 }),
							).trim();
						} catch {
							/* keep default */
						}
					}
				}
				const cleanupCmd = `ssh -O exit ${hostname}`;
				const port = this.configService.remoteProxyPort;
				const tunnelCmd = `ssh -fN -R ${port}:127.0.0.1:${port} ${hostname}`;

				const action = await vscode.window.showWarningMessage(
					`This will close the remote VS Code window.\n\n` +
						`⚠️ The SSH tunnel (ControlMaster) may persist on the local machine.\n` +
						`To fully close the tunnel, run on LOCAL terminal:\n` +
						`  ${cleanupCmd}\n\n` +
						`To manually establish the tunnel later:\n` +
						`  ${tunnelCmd}`,
					{ modal: true },
					'Close & Copy Commands',
					'Just Close',
					'Cancel',
				);

				if (action === 'Cancel' || !action) {
					return;
				}

				if (action === 'Close & Copy Commands') {
					const clipboardText = `# 1. Close existing tunnel\n${cleanupCmd}\n\n# 2. Establish new background static tunnel\n${tunnelCmd}`;
					await vscode.env.clipboard.writeText(clipboardText);
					vscode.window.showInformationMessage(
						`Copied manual commands to clipboard. Paste in local terminal to manage the tunnel manually.`,
					);
					await new Promise((r) => setTimeout(r, 1500));
				}

				vscode.commands.executeCommand('workbench.action.remote.close');
			},
			rollback: () => {
				vscode.commands.executeCommand('ssh-relay-guard.rollback');
			},
			fixDiag: async (msg) => {
				const action = msg.action as string;
				if (action === 'setup') {
					vscode.commands.executeCommand('ssh-relay-guard.setup');
				} else if (action === 'enableForwarding') {
					vscode.commands.executeCommand('ssh-relay-guard.enableForwarding');
				} else if (action === 'killReload') {
					await killTargetProcess((m) => console.log('[DashboardManager] ' + m));
					setTimeout(() => {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}, 1000);
				} else if (action === 'reloadWindow') {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				} else if (action.startsWith('switchProtocol:')) {
					const newType = action.split(':')[1];
					const config = vscode.workspace.getConfiguration('ssh-relay-guard');
					await config.update('proxyType', newType, vscode.ConfigurationTarget.Global);
					this.configService.reload();
					const t = dict[this.currentLang];
					vscode.window.showInformationMessage(t.configSaved);
					await this.refreshStatus();
					this.forceRenderPanel();
				} else if (action.startsWith('copyCommand:')) {
					const cmd = action.substring('copyCommand:'.length);
					await vscode.env.clipboard.writeText(cmd);
					const t = dict[this.currentLang];
					vscode.window.showInformationMessage(t.copiedToClipboard);
				}
			},
			copyCommand: async (msg) => {
				const text = msg.text as string;
				await vscode.env.clipboard.writeText(text);
				const t = dict[this.currentLang];
				vscode.window.showInformationMessage(t.copiedToClipboard);
			},
		};

		this.statusPanel.webview.onDidReceiveMessage(
			async (message) => {
				const handler = messageHandlers[message.command];
				if (handler) {
					await handler(message);
				}
			},
			undefined,
			this.context.subscriptions,
		);

		this.statusPanel.onDidDispose(() => {
			this.statusPanel = undefined;
			if (!this.isLocal) {
				this.connectionMonitor.stop();
			}
		});

		// Smart throttling: pause monitor when panel is hidden, resume when visible
		this.statusPanel.onDidChangeViewState((e) => {
			if (!this.isLocal) {
				if (e.webviewPanel.visible) {
					this.connectionMonitor.resume();
				} else {
					this.connectionMonitor.pause();
				}
			}
		});
	}

	/**
	 * Run diagnostics inline and update panel
	 */
	private async runInlineDiagnostics(): Promise<void> {
		if (this.isRunningDiagnostics) {
			return;
		}

		this.isRunningDiagnostics = true;
		// Full rerender to show "running..." button state (user-triggered)
		this.forceRenderPanel();

		try {
			this.currentDiagnosticReport = await runDiagnostics(
				this.configService,
				(checks) => {
					// Update panel with progress
					if (this.statusPanel) {
						this.statusPanel.webview.postMessage({
							command: 'diagnosticProgress',
							checks: checks,
						});
					}
				},
				this.context.extensionUri.fsPath,
			);
		} finally {
			this.isRunningDiagnostics = false;
			// Full rerender to show diagnostic results
			this.forceRenderPanel();
		}
	}

	/**
	 * Copy diagnostic report to clipboard
	 */
	private async copyDiagnosticReport(): Promise<void> {
		if (this.currentDiagnosticReport) {
			const text = generateReportText(this.currentDiagnosticReport);
			await vscode.env.clipboard.writeText(text);
			const t = dict[this.currentLang];
			vscode.window.showInformationMessage(t.reportCopied);
		}
	}

	/**
	 * Save configuration
	 */
	private async saveConfig(newConfig: {
		localProxyPort?: number;
		remoteProxyPort?: number;
		remoteProxyHost?: string;
		enableLocalForwarding?: boolean;
		proxyType?: string;
		rewriteCloudCodeEndpoint?: boolean;
	}): Promise<void> {
		const t = dict[this.currentLang];
		// ConfigService is the read cache; writes go through VS Code API
		const config = vscode.workspace.getConfiguration('ssh-relay-guard');

		try {
			if (newConfig.localProxyPort !== undefined) {
				await config.update(
					'localProxyPort',
					newConfig.localProxyPort,
					vscode.ConfigurationTarget.Global,
				);
			}
			if (newConfig.remoteProxyPort !== undefined) {
				await config.update(
					'remoteProxyPort',
					newConfig.remoteProxyPort,
					vscode.ConfigurationTarget.Global,
				);
			}
			if (newConfig.remoteProxyHost !== undefined) {
				await config.update(
					'remoteProxyHost',
					newConfig.remoteProxyHost,
					vscode.ConfigurationTarget.Global,
				);
			}
			if (newConfig.enableLocalForwarding !== undefined) {
				await config.update(
					'enableLocalForwarding',
					newConfig.enableLocalForwarding,
					vscode.ConfigurationTarget.Global,
				);
			}
			if (newConfig.proxyType !== undefined) {
				await config.update(
					'proxyType',
					newConfig.proxyType,
					vscode.ConfigurationTarget.Global,
				);
			}
			if (newConfig.rewriteCloudCodeEndpoint !== undefined) {
				await config.update(
					'rewriteCloudCodeEndpoint',
					newConfig.rewriteCloudCodeEndpoint,
					vscode.ConfigurationTarget.Global,
				);
			}

			// Trigger config change callback
			if (this.onConfigChange) {
				await this.onConfigChange();
			}

			await this.refreshStatus();

			// Note: If proxyType or rewriteCloudCodeEndpoint changed, proxyOrchestrator's
			// onDidChangeConfiguration listener handles prompting or auto-reloading the window.
			vscode.window.showInformationMessage(t.configSaved);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to save config: ${error}`);
		}
	}

	private updatePanelIfOpen(): void {
		if (!this.statusPanel) {
			return;
		}

		const status = this.currentStatus;
		const isLocal = status.runningLocation === 'local';
		const t = dict[this.currentLang];
		const trafficStats = this.connectionMonitor.getStats();
		const { color: statusColor, text: statusText } = resolveStatusAppearance(status, t);

		this.statusPanel.webview.postMessage({
			command: 'updateStatus',
			statusColor,
			statusText,
			sshConfigEnabled: status.sshConfigEnabled,
			localProxyReachable: status.localProxyReachable,
			remoteProxyReachable: status.remoteProxyReachable,
			remoteProxyFunctional: status.remoteProxyFunctional,
			remoteProxyHost: status.remoteProxyHost,
			languageServerConfigured: status.languageServerConfigured,
			lastUpdated: status.lastUpdated.toLocaleTimeString(),
			trafficHtml: this.generateTrafficHtml(t, trafficStats, isLocal),
			t: {
				on: t.on,
				off: t.off,
				reachable: t.reachable,
				unreachable: t.unreachable,
				configured: t.configured,
				notConfigured: t.notConfigured,
				updated: t.updated,
			},
		});
	}

	private forceRenderPanel(): void {
		if (this.statusPanel) {
			this.statusPanel.webview.html = this.getPanelHtml();
		}
	}

	private updatePanelCountdown(): void {
		if (this.statusPanel) {
			this.statusPanel.webview.postMessage({
				command: 'updateCountdown',
				seconds: this.secondsUntilRefresh,
			});
		}
	}

	private updateStatusBar(): void {
		// During startup verification: show spinning icon, don't resolve final status
		if (this.isVerifying) {
			this.statusBarItem.text = '$(sync~spin) SRG';
			this.statusBarItem.color = '#fbbf24';
			this.statusBarItem.tooltip =
				this.currentLang === 'zh'
					? 'SSH Relay Guard (SRG)\n🔄 正在检查连接...'
					: 'SSH Relay Guard (SRG)\n🔄 Checking connectivity...';
			this.statusBarItem.backgroundColor = undefined;
			return;
		}

		const status = this.currentStatus;
		const t = dict[this.currentLang];
		const { color } = resolveStatusAppearance(status, t);
		this.statusBarItem.color = color;

		let tooltip: string;
		if (this.isLocal) {
			if (status.sshConfigEnabled && status.localProxyReachable) {
				tooltip = 'SSH Relay Guard (SRG)\n✅ Connected';
			} else if (status.sshConfigEnabled) {
				tooltip = 'SSH Relay Guard (SRG)\n⚠️ SSH configured, proxy unreachable';
			} else if (status.hasConfiguredHosts === false) {
				tooltip =
					this.currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n⚠️ 未配置主机\n\n运行「Add Host Forwarding」添加远程主机'
						: 'SSH Relay Guard (SRG)\n⚠️ No hosts configured\n\nRun "Add Host Forwarding" to add a remote host';
			} else {
				tooltip = 'SSH Relay Guard (SRG)\n❌ Disconnected';
			}
		} else {
			if (status.remoteSetupCompleted === false) {
				tooltip =
					this.currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n⚠️ 隧道未建立\n\n① 在本地安装 SRG 插件\n② 本地运行「Add Host Forwarding」\n③ 重新连接此服务器'
						: 'SSH Relay Guard (SRG)\n⚠️ Tunnel not established\n\n① Install SRG on your LOCAL machine\n② Run \"Add Host Forwarding\" locally\n③ Reconnect to this server';
			} else if (status.remoteProxyFunctional) {
				tooltip = 'SSH Relay Guard (SRG)\n✅ Proxy OK';
			} else if (status.remoteProxyReachable) {
				tooltip =
					this.currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n⚠️ 端口可达但代理无响应\n\n可能原因：\n• 端口被其他进程占用\n• 本地代理未运行'
						: 'SSH Relay Guard (SRG)\n⚠️ Port reachable but proxy not responding\n\nPossible causes:\n• Port occupied by another process\n• Local proxy not running';
			} else {
				tooltip = 'SSH Relay Guard (SRG)\n❌ Proxy unreachable';
			}
		}

		this.statusBarItem.text = '$(shield) SRG';
		this.statusBarItem.tooltip = tooltip;
		this.statusBarItem.backgroundColor = undefined;
	}

	private notifyCallbacks(): void {
		const status = this.getStatus();
		for (const callback of this.updateCallbacks) {
			callback(status);
		}
	}

	private buildPanelContext(): PanelContext {
		const t = dict[this.currentLang];
		return {
			status: this.currentStatus,
			t,
			currentLang: this.currentLang,
			enableForwarding: this.configService.enableLocalForwarding,
			proxyType: this.configService.proxyType,
			rewriteCloudCodeEndpoint: this.configService.rewriteCloudCodeEndpoint,
			diagnosticReport: this.currentDiagnosticReport,
			isRunningDiagnostics: this.isRunningDiagnostics,
			trafficStats: this.connectionMonitor.getStats(),
			sessionDuration: this.connectionMonitor.getSessionDuration(),
			secondsUntilRefresh: this.secondsUntilRefresh,
		};
	}

	private getPanelHtml(): string {
		return buildPanelHtml(this.buildPanelContext());
	}

	private generateTrafficHtml(t: typeof dict.zh, stats: TrafficStats, isLocal: boolean): string {
		return buildTrafficHtml(
			{
				t,
				trafficStats: stats,
				sessionDuration: this.connectionMonitor.getSessionDuration(),
				status: this.currentStatus,
			},
			isLocal,
		);
	}

	dispose(): void {
		this.stopAutoRefresh();
		this.statusBarItem.dispose();
		this.statusPanel?.dispose();
		this.connectionMonitor.dispose();
		this.updateCallbacks = [];
	}
}
