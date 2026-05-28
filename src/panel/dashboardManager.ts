/**
 * Dashboard coordinator for the SRG status panel.
 *
 * Manages the WebView panel lifecycle, auto-refresh timers, and coordinates
 * between StatusBarController, MessageRouter, ConnectionMonitor, and the
 * panel renderer.
 *
 * Business logic is delegated to:
 *   - StatusBarController: status bar icon/tooltip/monitor
 *   - MessageRouter: WebView message handling, config save, diagnostics
 *   - panelRenderer: pure HTML generation
 */

import * as vscode from 'vscode';
import { ConnectionMonitor, TrafficStats } from '../traffic/connectionMonitor';
import { ConfigService } from '../core/configService';
import { StateManager, ProxyState } from '../core/stateManager';
import { isPortReachable, isProxyFunctional, isSrgSetupCompleted } from '../utils/portProbe';
import { dict, Lang } from './translations';
import {
	buildPanelHtml,
	buildTrafficHtml,
	PanelContext,
	resolveStatusAppearance,
} from './panelRenderer';
import { StatusBarController } from './statusBarController';
import { MessageRouter } from './messageRouter';

export interface ProxyStatus extends ProxyState {
	runningLocation: 'local' | 'remote';
	localProxyPort: number;
	remoteProxyPort: number;
	remoteProxyHost: string;
}

const REFRESH_INTERVAL_SEC = 30;

export class DashboardManager {
	private refreshInterval: NodeJS.Timeout | undefined;
	private statusPanel: vscode.WebviewPanel | undefined;
	private countdownInterval: NodeJS.Timeout | undefined;
	private secondsUntilRefresh: number = REFRESH_INTERVAL_SEC;

	private connectionMonitor: ConnectionMonitor;
	private currentLang: Lang = 'zh';
	/** Track previous proxy reachability to detect disconnection transitions. */
	private previousProxyReachable: boolean | null = null;

	private statusBarController: StatusBarController;
	private messageRouter: MessageRouter;

	constructor(
		private isLocal: boolean,
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private stateManager: StateManager,
	) {
		// Initialize connection monitor
		this.connectionMonitor = new ConnectionMonitor(configService);

		// Load saved language preference (default to Chinese)
		this.currentLang = this.context.globalState.get<Lang>('uiLanguage', 'zh');

		// Initialize status bar
		this.statusBarController = new StatusBarController(
			isLocal,
			configService,
			stateManager,
			this.connectionMonitor,
			() => this.currentStatus,
			() => this.currentLang,
		);

		// Initialize message router
		this.messageRouter = new MessageRouter(
			isLocal,
			context,
			configService,
			stateManager,
			() => this.currentLang,
			() => this.currentStatus,
			() => this.refreshStatus(),
			() => this.forceRenderPanel(),
			() => this.statusPanel,
		);

		this.stateManager.onDidChangeState(() => {
			this.updatePanelIfOpen();
		});
	}

	private get currentStatus(): ProxyStatus {
		return {
			...this.stateManager.getState(),
			runningLocation: this.isLocal ? 'local' : 'remote',
			localProxyPort: this.configService.localProxyPort,
			remoteProxyPort: this.configService.remoteProxyPort,
			remoteProxyHost: this.configService.remoteProxyHost,
		};
	}

	setVerifying(verifying: boolean): void {
		this.stateManager.updateState({ isVerifying: verifying });
	}

	/**
	 * Deprecated: Use stateManager.onRequestConfigApply directly
	 */
	setConfigChangeCallback(callback: () => Promise<void>): void {
		this.stateManager.onRequestConfigApply(callback);
	}

	onStatusUpdate(callback: (status: ProxyStatus) => void): vscode.Disposable {
		return this.stateManager.onDidChangeState(() => {
			callback(this.currentStatus);
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

	startStatusBarMonitor(): void {
		this.statusBarController.startMonitor();
	}

	async refreshStatus(): Promise<void> {
		let newState: Partial<ProxyState> = {};

		if (this.isLocal) {
			const localProxyReachable = await isPortReachable(
				'127.0.0.1',
				this.configService.localProxyPort,
			);
			newState = { localProxyReachable };
		} else {
			const proxyType = this.configService.proxyType as 'http' | 'socks5';
			const detectedPort =
				this.stateManager.getState().detectedRemotePort ||
				this.configService.remoteProxyPort;
			const [functional, setupDone] = await Promise.all([
				isProxyFunctional(this.configService.remoteProxyHost, detectedPort, proxyType),
				isSrgSetupCompleted(),
			]);

			// If proxy is functional at protocol level, it guarantees port reachability
			const reachable = functional;

			newState = {
				remoteProxyReachable: reachable,
				remoteProxyFunctional: functional,
				remoteSetupCompleted: setupDone,
			};

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

		this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
		this.stateManager.updateState(newState);
	}

	updateSSHConfigStatus(enabled: boolean, hosts?: string[]): void {
		const hasHosts = hosts !== undefined && hosts.length > 0;
		this.stateManager.updateState({
			sshConfigEnabled: enabled && hasHosts,
			hasConfiguredHosts: hasHosts,
			configuredHosts: hosts,
		});
	}

	updateLanguageServerStatus(configured: boolean): void {
		this.stateManager.updateState({ languageServerConfigured: configured });
	}

	getStatus(): ProxyStatus {
		return this.currentStatus;
	}

	// -----------------------------------------------------------------------
	// WebView Panel Lifecycle
	// -----------------------------------------------------------------------

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
			const monitorDisposable = this.connectionMonitor.onUpdate(() => {
				this.updatePanelIfOpen();
				this.statusBarController.update();
			});

			// Collect disposables tied to panel lifetime
			const panelDisposables: vscode.Disposable[] = [monitorDisposable];

			this.statusPanel.onDidDispose(() => {
				this.statusPanel = undefined;
				this.connectionMonitor.stop();
				for (const d of panelDisposables) {
					d.dispose();
				}
			});

			// Smart throttling: pause monitor when panel is hidden, resume when visible
			this.statusPanel.onDidChangeViewState((e) => {
				if (e.webviewPanel.visible) {
					this.connectionMonitor.resume();
				} else {
					this.connectionMonitor.pause();
				}
			});
		} else {
			this.statusPanel.onDidDispose(() => {
				this.statusPanel = undefined;
			});
		}

		this.statusPanel.webview.html = this.getPanelHtml();

		// Wire up message routing
		const handlers = this.messageRouter.buildHandlers(async () => {
			await this.connectionMonitor.refresh();
		});

		this.statusPanel.webview.onDidReceiveMessage(
			async (message) => {
				// Handle language change specially — need to update local state
				if (message.command === 'setLanguage') {
					this.currentLang = message.lang as Lang;
				}
				const handler = handlers[message.command];
				if (handler) {
					await handler(message);
				}
			},
			undefined,
			this.context.subscriptions,
		);
	}

	// -----------------------------------------------------------------------
	// Panel Updates
	// -----------------------------------------------------------------------

	private updatePanelIfOpen(): void {
		if (!this.statusPanel) {
			return;
		}

		const status = this.currentStatus;
		const isLocal = status.runningLocation === 'local';
		const t = dict[this.currentLang];
		const trafficStats = this.connectionMonitor.getStats();
		let { color: statusColor, text: statusText } = resolveStatusAppearance(status, t);

		if (!isLocal && trafficStats.localReconnecting) {
			statusColor = '#fbbf24'; // Yellow
			statusText = this.currentLang === 'zh' ? '正在重连' : 'Reconnecting';
		}

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

	private buildPanelContext(): PanelContext {
		const t = dict[this.currentLang];
		return {
			status: this.currentStatus,
			t,
			currentLang: this.currentLang,
			enableForwarding: this.configService.enableLocalForwarding,
			proxyType: this.configService.proxyType,
			rewriteCloudCodeEndpoint: this.configService.rewriteCloudCodeEndpoint,
			diagnosticReport: this.messageRouter.currentDiagnosticReport,
			isRunningDiagnostics: this.messageRouter.isRunningDiagnostics,
			trafficStats: this.connectionMonitor.getStats(),
			sessionDuration: this.connectionMonitor.getSessionDuration(),
			secondsUntilRefresh: this.secondsUntilRefresh,
		};
	}

	private getPanelHtml(): string {
		return buildPanelHtml(this.buildPanelContext());
	}

	setLocalReconnectionState(reconnecting: boolean): void {
		this.connectionMonitor.setLocalReconnectionState(reconnecting);
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
		this.statusBarController.dispose();
		this.statusPanel?.dispose();
		this.connectionMonitor.dispose();
	}
}
