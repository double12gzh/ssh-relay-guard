import * as vscode from 'vscode';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { StateManager } from './stateManager';
import { TunnelManager } from './tunnelManager';
import { LocalModeController } from './localModeController';
import { RemoteModeController } from './remoteModeController';
import { CommandRegistry } from './commands/commandRegistry';
import { isRunningLocally } from '../utils/portProbe';

/**
 * ProxyOrchestrator — Thin coordinator for all SRG functionality.
 *
 * Creates child modules and delegates to the appropriate mode controller
 * (LocalModeController or RemoteModeController) based on the runtime
 * environment. Registers commands through CommandRegistry.
 */
export class ProxyOrchestrator implements vscode.Disposable {
	private outputChannel: vscode.OutputChannel;
	private configService: ConfigService;
	private stateManager: StateManager;
	private dashboardManager: DashboardManager;
	private tunnelManager: TunnelManager;
	private commandRegistry: CommandRegistry;
	private isLocal: boolean;

	constructor(
		private context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
	) {
		this.outputChannel = outputChannel;
		this.isLocal = isRunningLocally();
		this.configService = new ConfigService();
		this.stateManager = new StateManager();
		this.dashboardManager = new DashboardManager(
			this.isLocal,
			context,
			this.configService,
			this.stateManager,
		);
		this.tunnelManager = new TunnelManager(context.extensionUri.fsPath, (m) => this.log(m));
		this.commandRegistry = new CommandRegistry(context, this.isLocal);
	}

	/**
	 * Initialize the orchestrator: register commands, start auto-refresh,
	 * and activate local or remote mode.
	 */
	initialize(): void {
		this.log(`Activating... isLocal=${this.isLocal}`);

		this.context.subscriptions.push(this.dashboardManager);

		this.registerCommonCommands();
		this.commandRegistry.registerCommands();

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
				this.stateManager,
				(m) => this.log(m),
			);

			this.commandRegistry.onEnableForwarding = async () =>
				await localCtrl.enableForwarding();
			this.commandRegistry.onDisableForwarding = async () =>
				await localCtrl.disableForwarding();
			this.commandRegistry.onTunnelStatus = async () => await localCtrl.tunnelStatus();
			this.commandRegistry.onReconnectTunnel = async () => await localCtrl.reconnectTunnel();

			localCtrl.activate().catch((err) => this.log(`activateLocal error: ${err}`));
		} else {
			const remoteCtrl = new RemoteModeController(
				this.context,
				this.configService,
				this.dashboardManager,
				this.stateManager,
				(m) => this.log(m),
			);

			this.commandRegistry.onSetupRemote = async () => await remoteCtrl.setup();
			this.commandRegistry.onRollbackRemote = async () => await remoteCtrl.rollback();
			this.commandRegistry.onCheckProxy = async () => await remoteCtrl.checkProxy();
			this.commandRegistry.onSetReconnectingState = (state) =>
				remoteCtrl.setReconnectingState(state);

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
