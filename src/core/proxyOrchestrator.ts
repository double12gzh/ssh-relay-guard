import * as vscode from 'vscode';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { TunnelManager } from './tunnelManager';
import { LocalModeController } from './localModeController';
import { RemoteModeController } from './remoteModeController';
import { isRunningLocally } from '../utils/portProbe';

/**
 * ProxyOrchestrator — Thin coordinator for all SRG functionality.
 *
 * Creates child modules and delegates to the appropriate mode controller
 * (LocalModeController or RemoteModeController) based on the runtime
 * environment. Registers only the common commands shared between modes.
 */
export class ProxyOrchestrator implements vscode.Disposable {
	private outputChannel: vscode.OutputChannel;
	private configService: ConfigService;
	private dashboardManager: DashboardManager;
	private tunnelManager: TunnelManager;
	private isLocal: boolean;

	constructor(
		private context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
	) {
		this.outputChannel = outputChannel;
		this.isLocal = isRunningLocally();
		this.configService = new ConfigService();
		this.dashboardManager = new DashboardManager(this.isLocal, context, this.configService);
		this.tunnelManager = new TunnelManager((m) => this.log(m));
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
		this.dashboardManager.startStatusBarMonitor();

		if (this.isLocal) {
			const localCtrl = new LocalModeController(
				this.context,
				this.configService,
				this.dashboardManager,
				this.tunnelManager,
				(m) => this.log(m),
			);
			localCtrl.activate().catch((err) => this.log(`activateLocal error: ${err}`));
		} else {
			const remoteCtrl = new RemoteModeController(
				this.context,
				this.configService,
				this.dashboardManager,
				(m) => this.log(m),
			);
			remoteCtrl.activate().catch((err) => this.log(`activateRemote error: ${err}`));
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

	// ── Lifecycle ──────────────────────────────────────────────────────

	dispose(): void {
		this.dashboardManager.stopAutoRefresh();
		this.tunnelManager.dispose();
		this.configService.dispose();
		// SSH config is PERSISTENT — not deleted on deactivate.
		// Users can use Rollback command or 'srg teardown' to clean up.
	}
}
