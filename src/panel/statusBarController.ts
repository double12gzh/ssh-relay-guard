/**
 * Status bar icon and tooltip management for SSH Relay Guard.
 *
 * Extracted from DashboardManager to separate status bar UI concerns
 * from WebView panel lifecycle and message routing.
 */

import * as vscode from 'vscode';
import { ConfigService } from '../core/configService';
import { StateManager } from '../core/stateManager';
import { isPortReachable, isProxyFunctional } from '../utils/portProbe';
import { ConnectionMonitor } from '../traffic/connectionMonitor';
import { resolveStatusAppearance } from './panelRenderer';
import { dict, Lang } from './translations';
import { ProxyStatus } from './dashboardManager';

export class StatusBarController {
	private statusBarItem: vscode.StatusBarItem;
	/** Lightweight background interval that updates status bar on state transitions (remote only). */
	private statusBarMonitor: NodeJS.Timeout | undefined;

	constructor(
		private isLocal: boolean,
		private configService: ConfigService,
		private stateManager: StateManager,
		private connectionMonitor: ConnectionMonitor,
		private getStatus: () => ProxyStatus,
		private getLang: () => Lang,
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			-100,
		);
		this.statusBarItem.command = 'ssh-relay-guard.showStatusPanel';
		this.statusBarItem.name = 'SRG';

		this.stateManager.onDidChangeState(() => {
			this.update();
		});

		this.update();
		this.statusBarItem.show();
	}

	/**
	 * Start a lightweight background monitor that updates the status bar
	 * in near real-time when proxy reachability changes.
	 *
	 * Only runs on the remote side. Checks every 5 seconds and only triggers
	 * a status bar redraw on actual state transitions (connected ↔ disconnected)
	 * to minimize overhead.
	 */
	startMonitor(): void {
		if (this.statusBarMonitor) {
			return;
		}

		if (this.isLocal) {
			// Local side: low-frequency check (30s) to detect local proxy crashes.
			// Uses TCP port probe (cheaper) since we only need reachability, not protocol.
			this.statusBarMonitor = setInterval(async () => {
				const reachable = await isPortReachable(
					'127.0.0.1',
					this.configService.localProxyPort,
					2000,
				);

				// Only update on state transition to avoid unnecessary redraws
				if (reachable !== this.getStatus().localProxyReachable) {
					this.stateManager.updateState({
						localProxyReachable: reachable,
					});
				}
			}, 30_000);
		} else {
			// Remote side: higher-frequency check (5s) with protocol-level validation.
			this.statusBarMonitor = setInterval(async () => {
				const proxyType = this.configService.proxyType as 'http' | 'socks5';

				// Protocol-level check: confirms the proxy actually responds,
				// not just that the port is open (which could be another process).
				const functional = await isProxyFunctional(
					this.configService.remoteProxyHost,
					this.configService.remoteProxyPort,
					proxyType,
					2000,
				);

				// Only update on state transition to avoid unnecessary redraws
				if (functional !== this.getStatus().remoteProxyFunctional) {
					this.stateManager.updateState({
						remoteProxyFunctional: functional,
						remoteProxyReachable: functional,
					});
				}
			}, 5000);
		}
	}

	stopMonitor(): void {
		if (this.statusBarMonitor) {
			clearInterval(this.statusBarMonitor);
			this.statusBarMonitor = undefined;
		}
	}

	update(): void {
		const status = this.getStatus();
		const currentLang = this.getLang();

		// During startup verification: show spinning icon, don't resolve final status
		if (status.isVerifying) {
			this.statusBarItem.text = '$(sync~spin) SRG';
			this.statusBarItem.color = '#fbbf24';
			this.statusBarItem.tooltip =
				currentLang === 'zh'
					? 'SSH Relay Guard (SRG)\n🔄 正在检查连接...'
					: 'SSH Relay Guard (SRG)\n🔄 Checking connectivity...';
			this.statusBarItem.backgroundColor = undefined;
			return;
		}

		const t = dict[currentLang];
		const { color } = resolveStatusAppearance(status, t);
		this.statusBarItem.color = color;

		let tooltip: string;
		if (this.isLocal) {
			if (
				status.sshConfigEnabled &&
				status.activeTunnelsCount > 0 &&
				status.localProxyReachable
			) {
				tooltip = 'SSH Relay Guard (SRG)\n✅ Connected';
			} else if (status.sshConfigEnabled && status.activeTunnelsCount === 0) {
				tooltip = 'SSH Relay Guard (SRG)\n⚠️ SSH configured, but tunnel is not running';
			} else if (status.sshConfigEnabled) {
				tooltip = 'SSH Relay Guard (SRG)\n⚠️ SSH configured, proxy unreachable';
			} else if (status.hasConfiguredHosts === false) {
				tooltip =
					currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n⚠️ 未配置主机\n\n运行「Add Host Forwarding」添加远程主机'
						: 'SSH Relay Guard (SRG)\n⚠️ No hosts configured\n\nRun "Add Host Forwarding" to add a remote host';
			} else {
				tooltip = 'SSH Relay Guard (SRG)\n❌ Disconnected';
			}
		} else {
			const trafficStats = this.connectionMonitor.getStats();
			if (status.remoteSetupCompleted === false) {
				tooltip =
					currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n⚠️ 隧道未建立\n\n① 在本地安装 SRG 插件\n② 本地运行「Add Host Forwarding」\n③ 重新连接此服务器'
						: 'SSH Relay Guard (SRG)\n⚠️ Tunnel not established\n\n① Install SRG on your LOCAL machine\n② Run "Add Host Forwarding" locally\n③ Reconnect to this server';
			} else if (status.remoteProxyFunctional) {
				tooltip = 'SSH Relay Guard (SRG)\n✅ Proxy OK';
			} else if (trafficStats.localReconnecting) {
				tooltip =
					currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n🔄 隧道断开，本地正在尝试重连...'
						: 'SSH Relay Guard (SRG)\n🔄 Tunnel disconnected, local side reconnecting...';
			} else if (status.remoteProxyReachable) {
				tooltip =
					currentLang === 'zh'
						? 'SSH Relay Guard (SRG)\n⚠️ 端口可达但代理无响应\n\n可能原因：\n• 端口被其他进程占用\n• 本地代理未运行'
						: 'SSH Relay Guard (SRG)\n⚠️ Port reachable but proxy not responding\n\nPossible causes:\n• Port occupied by another process\n• Local proxy not running';
			} else {
				tooltip = 'SSH Relay Guard (SRG)\n❌ Proxy unreachable';
			}
		}

		if (!this.isLocal && this.connectionMonitor.getStats().localReconnecting) {
			this.statusBarItem.text = '$(sync~spin) SRG';
			this.statusBarItem.color = '#fbbf24';
		} else {
			this.statusBarItem.text = '$(shield) SRG';
		}
		this.statusBarItem.tooltip = tooltip;
		this.statusBarItem.backgroundColor = undefined;
	}

	dispose(): void {
		this.stopMonitor();
		this.statusBarItem.dispose();
	}
}
