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
	/** The actual detected tunnel port on the remote side (overrides global remoteProxyPort if different) */
	detectedRemotePort?: number;
	/** Per-host actual remote port (from SSH config). Falls back to global remoteProxyPort if absent. */
	hostPortData?: Record<string, number>;
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
			} else if (
				this.state[key] !== null &&
				newState[key] !== null &&
				typeof this.state[key] === 'object' &&
				typeof newState[key] === 'object' &&
				!(this.state[key] instanceof Date) &&
				!Array.isArray(this.state[key])
			) {
				// Shallow comparison for plain Record objects (e.g. hostPortData)
				const obj1 = this.state[key] as Record<string, unknown>;
				const obj2 = newState[key] as Record<string, unknown>;
				const keys1 = Object.keys(obj1);
				const keys2 = Object.keys(obj2);
				if (keys1.length !== keys2.length || keys1.some((k) => obj1[k] !== obj2[k])) {
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
