import * as vscode from 'vscode';

export interface ProxyState {
	isVerifying: boolean;
	isLocalReconnecting: boolean;
	sshConfigEnabled: boolean;
	localProxyReachable: boolean;
	remoteProxyReachable: boolean;
	remoteProxyFunctional: boolean;
	remoteSetupCompleted?: boolean;
	languageServerConfigured?: boolean;
	hasConfiguredHosts?: boolean;
	configuredHosts?: string[];
	activeTunnelsCount: number;
	lastUpdated: Date;
}

export class StateManager {
	private state: ProxyState = {
		isVerifying: false,
		isLocalReconnecting: false,
		sshConfigEnabled: false,
		localProxyReachable: false,
		remoteProxyReachable: false,
		remoteProxyFunctional: false,
		activeTunnelsCount: 0,
		lastUpdated: new Date(),
	};

	private _onDidChangeState = new vscode.EventEmitter<ProxyState>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	private _onRequestConfigApply = new vscode.EventEmitter<void>();
	public readonly onRequestConfigApply = this._onRequestConfigApply.event;

	public getState(): ProxyState {
		return { ...this.state };
	}

	public updateState(newState: Partial<ProxyState>): void {
		let changed = false;
		for (const key of Object.keys(newState) as Array<keyof ProxyState>) {
			if (Array.isArray(this.state[key]) && Array.isArray(newState[key])) {
				const arr1 = this.state[key] as unknown[];
				const arr2 = newState[key] as unknown[];
				if (arr1.length !== arr2.length || arr1.some((val, i) => val !== arr2[i])) {
					(this.state as Record<keyof ProxyState, unknown>)[key] = newState[key];
					changed = true;
				}
			} else if (this.state[key] !== newState[key]) {
				(this.state as Record<keyof ProxyState, unknown>)[key] = newState[key];
				changed = true;
			}
		}

		if (changed) {
			this.state.lastUpdated = new Date();
			this._onDidChangeState.fire(this.getState());
		}
	}

	public requestConfigApply(): void {
		this._onRequestConfigApply.fire();
	}
}
