import * as vscode from 'vscode';

export class CommandRegistry {
	private isLocal: boolean;
	private context: vscode.ExtensionContext;

	// Injected command handlers
	public onEnableForwarding?: () => Promise<void>;
	public onDisableForwarding?: () => Promise<void>;
	public onTunnelStatus?: () => Promise<void>;
	public onReconnectTunnel?: () => Promise<void>;

	public onSetupRemote?: () => Promise<void>;
	public onRollbackRemote?: () => Promise<void>;
	public onCheckProxy?: () => Promise<void>;
	public onSetReconnectingState?: (state: boolean) => void;

	constructor(context: vscode.ExtensionContext, isLocal: boolean) {
		this.context = context;
		this.isLocal = isLocal;
	}

	public registerCommands(): void {
		this.registerLocalCommand('ssh-relay-guard.enableForwarding', async () => {
			if (!this.onEnableForwarding) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onEnableForwarding();
		});
		this.registerLocalCommand('ssh-relay-guard.disableForwarding', async () => {
			if (!this.onDisableForwarding) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onDisableForwarding();
		});
		this.registerLocalCommand('ssh-relay-guard.tunnelStatus', async () => {
			if (!this.onTunnelStatus) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onTunnelStatus();
		});
		this.registerLocalCommand('ssh-relay-guard.reconnectTunnel', async () => {
			if (!this.onReconnectTunnel) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onReconnectTunnel();
		});

		this.registerRemoteCommand('ssh-relay-guard.setup', async () => {
			if (!this.onSetupRemote) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onSetupRemote();
		});
		this.registerRemoteCommand('ssh-relay-guard.rollback', async () => {
			if (!this.onRollbackRemote) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onRollbackRemote();
		});
		this.registerRemoteCommand('ssh-relay-guard.checkProxy', async () => {
			if (!this.onCheckProxy) {
				vscode.window.showWarningMessage('Command not ready yet, please retry.');
				return;
			}
			await this.onCheckProxy();
		});
		this.registerRemoteCommand(
			'ssh-relay-guard.remote.setReconnectingState',
			async (state: unknown) => {
				if (!this.onSetReconnectingState) {
					// No need to show warning for internal command
					return;
				}
				this.onSetReconnectingState(state as boolean);
			},
		);
	}

	private registerLocalCommand(commandId: string, callback: (...args: unknown[]) => unknown) {
		this.context.subscriptions.push(
			vscode.commands.registerCommand(commandId, async (...args) => {
				if (!this.isLocal) {
					vscode.window.showWarningMessage(
						`This command must be run from a LOCAL VS Code window. ` +
							`Open a new local window (File → New Window), then run this command from there.`,
					);
					return;
				}
				await callback(...args);
			}),
		);
	}

	private registerRemoteCommand(commandId: string, callback: (...args: unknown[]) => unknown) {
		this.context.subscriptions.push(
			vscode.commands.registerCommand(commandId, async (...args) => {
				if (this.isLocal) {
					vscode.window.showWarningMessage(
						`This command must be run from a REMOTE VS Code window. ` +
							`Connect to a remote server first, then run this command there.`,
					);
					return;
				}
				await callback(...args);
			}),
		);
	}
}
