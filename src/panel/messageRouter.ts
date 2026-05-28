/**
 * WebView message routing for the SRG dashboard panel.
 *
 * Extracted from DashboardManager to separate message handling / business
 * logic from panel lifecycle management.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDiagnostics, DiagnosticReport, generateReportText } from '../diagnostics/healthChecker';
import { ConfigService } from '../core/configService';
import { StateManager } from '../core/stateManager';
import { killTargetProcess } from '../utils/processUtils';
import { dict, Lang } from './translations';
import { ProxyStatus } from './dashboardManager';

export class MessageRouter {
	public currentDiagnosticReport: DiagnosticReport | null = null;
	public isRunningDiagnostics: boolean = false;

	constructor(
		private isLocal: boolean,
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private stateManager: StateManager,
		private getLang: () => Lang,
		private getStatus: () => ProxyStatus,
		private refreshStatus: () => Promise<void>,
		private forceRenderPanel: () => void,
		private getPanel: () => vscode.WebviewPanel | undefined,
	) {}

	/**
	 * Build the full message handler map for the WebView.
	 */
	buildHandlers(
		connectionMonitorRefresh: () => Promise<void>,
	): Record<string, (message: Record<string, unknown>) => Promise<void> | void> {
		return {
			refresh: async () => {
				await this.refreshStatus();
				if (!this.isLocal) {
					await connectionMonitorRefresh();
				}
			},
			saveConfig: async (msg) => {
				await this.saveConfig(msg.config as Parameters<MessageRouter['saveConfig']>[0]);
			},
			runDiagnostics: async () => {
				await this.runInlineDiagnostics();
			},
			copyReport: async () => {
				await this.copyDiagnosticReport();
			},
			setLanguage: async (msg) => {
				const lang = msg.lang as Lang;
				await this.context.globalState.update('uiLanguage', lang);
				// Caller is responsible for updating current lang and re-rendering
				this.forceRenderPanel();
			},
			closeRemote: async () => {
				await this.handleCloseRemote();
			},
			rollback: () => {
				vscode.commands.executeCommand('ssh-relay-guard.rollback');
			},
			fixDiag: async (msg) => {
				await this.handleFixDiag(msg.action as string);
			},
			copyCommand: async (msg) => {
				const text = msg.text as string;
				await vscode.env.clipboard.writeText(text);
				const t = dict[this.getLang()];
				vscode.window.showInformationMessage(t.copiedToClipboard);
			},
		};
	}

	/**
	 * Run diagnostics inline and update panel.
	 */
	async runInlineDiagnostics(): Promise<void> {
		if (this.isRunningDiagnostics) {
			return;
		}

		this.isRunningDiagnostics = true;
		this.forceRenderPanel();

		try {
			const detectedPort = this.stateManager.getState().detectedRemotePort;
			this.currentDiagnosticReport = await runDiagnostics(
				this.configService,
				(checks) => {
					const panel = this.getPanel();
					if (panel) {
						panel.webview.postMessage({
							command: 'diagnosticProgress',
							checks: checks,
						});
					}
				},
				this.context.extensionUri.fsPath,
				detectedPort,
			);
		} finally {
			this.isRunningDiagnostics = false;
			this.forceRenderPanel();
		}
	}

	/**
	 * Copy diagnostic report to clipboard.
	 */
	private async copyDiagnosticReport(): Promise<void> {
		if (this.currentDiagnosticReport) {
			const text = generateReportText(this.currentDiagnosticReport);
			await vscode.env.clipboard.writeText(text);
			const t = dict[this.getLang()];
			vscode.window.showInformationMessage(t.reportCopied);
		}
	}

	/**
	 * Save configuration from the panel.
	 */
	async saveConfig(newConfig: {
		localProxyPort?: number;
		remoteProxyPort?: number;
		remoteProxyHost?: string;
		enableLocalForwarding?: boolean;
		proxyType?: string;
		rewriteCloudCodeEndpoint?: boolean;
	}): Promise<void> {
		const t = dict[this.getLang()];
		const config = vscode.workspace.getConfiguration('ssh-relay-guard');

		try {
			// ── Multi-user isolation ──────────────────────────────────────
			// On remote side, also update process.env for immediate
			// per-session effect without affecting other users.
			if (!this.isLocal) {
				const host = newConfig.remoteProxyHost ?? this.configService.remoteProxyHost;
				const port = newConfig.remoteProxyPort ?? this.configService.remoteProxyPort;
				const type = newConfig.proxyType ?? this.configService.proxyType;
				const rewrite =
					newConfig.rewriteCloudCodeEndpoint ??
					this.configService.rewriteCloudCodeEndpoint;
				process.env.SRG_PROXY_ADDR = `${host}:${port}`;
				process.env.SRG_PROXY_TYPE = type;
				process.env.SRG_PROXY_PORT = String(port);
				process.env.SRG_REWRITE_CLOUDCODE = rewrite ? 'true' : 'false';

				// Also sync to ~/.srg/ state file so LS wrapper picks up
				// the new port even if it restarts independently.
				try {
					const srgDir = path.join(os.homedir() || '/root', '.srg');
					if (!fs.existsSync(srgDir)) {
						fs.mkdirSync(srgDir, { recursive: true });
					}
					const keys = [
						process.env.VSCODE_IPC_HOOK_CLI,
						process.env.SSH_CLIENT,
						process.env.SSH_CONNECTION,
						'default',
					].filter(Boolean) as string[];

					for (const key of keys) {
						const safeName = key.replace(/[^a-zA-Z0-9]/g, '_');
						fs.writeFileSync(
							path.join(srgDir, `port_${safeName}`),
							String(port),
							'utf-8',
						);
					}
				} catch {
					// Best-effort — don't block config save
				}
			}

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
			this.stateManager.requestConfigApply();

			await this.refreshStatus();

			// Note: If proxyType or rewriteCloudCodeEndpoint changed, proxyOrchestrator's
			// onDidChangeConfiguration listener handles prompting or auto-reloading the window.
			vscode.window.showInformationMessage(t.configSaved);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to save config: ${error}`);
		}
	}

	/**
	 * Handle "Close Remote" action from the panel.
	 */
	private async handleCloseRemote(): Promise<void> {
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
		const remotePort = this.configService.remoteProxyPort;
		const localPort = this.configService.localProxyPort;
		const tunnelCmd = `ssh -fN -R ${remotePort}:127.0.0.1:${localPort} ${hostname}`;

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
	}

	/**
	 * Handle diagnostic fix actions.
	 */
	private async handleFixDiag(action: string): Promise<void> {
		const t = dict[this.getLang()];

		if (action === 'setup') {
			vscode.commands.executeCommand('ssh-relay-guard.setup');
		} else if (action === 'enableForwarding') {
			vscode.commands.executeCommand('ssh-relay-guard.enableForwarding');
		} else if (action === 'killReload') {
			await killTargetProcess((m) => console.log('[MessageRouter] ' + m));
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
			vscode.window.showInformationMessage(t.configSaved);
			await this.refreshStatus();
			this.forceRenderPanel();
		} else if (action.startsWith('copyCommand:')) {
			const cmd = action.substring('copyCommand:'.length);
			await vscode.env.clipboard.writeText(cmd);
			vscode.window.showInformationMessage(t.copiedToClipboard);
		}
	}
}
