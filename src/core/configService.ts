import * as vscode from 'vscode';

/**
 * ConfigService — Centralized, cached access to ssh-relay-guard settings.
 *
 * Eliminates ~20 scattered `vscode.workspace.getConfiguration()` calls
 * across the codebase. Caches values on first read and reloads
 * automatically when configuration changes.
 */
export class ConfigService implements vscode.Disposable {
	private _localProxyPort: number;
	private _remoteProxyPort: number;
	private _remoteProxyHost: string;
	private _proxyType: string;
	private _enableLocalForwarding: boolean;
	private _showStatusOnStartup: boolean;
	private _rewriteCloudCodeEndpoint: boolean;
	private disposable: vscode.Disposable;
	private changeListeners: Array<() => void> = [];

	constructor() {
		this._localProxyPort = 7890;
		this._remoteProxyPort = 7890;
		this._remoteProxyHost = '127.0.0.1';
		this._proxyType = 'http';
		this._enableLocalForwarding = true;
		this._showStatusOnStartup = true;
		this._rewriteCloudCodeEndpoint = false;
		this.reload();

		this.disposable = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ssh-relay-guard')) {
				this.reload();
				for (const listener of this.changeListeners) {
					listener();
				}
			}
		});
	}

	public reload(): void {
		const cfg = vscode.workspace.getConfiguration('ssh-relay-guard');
		this._localProxyPort = cfg.get<number>('localProxyPort', 7890);
		this._remoteProxyPort = cfg.get<number>('remoteProxyPort', 7890);
		this._remoteProxyHost = cfg.get<string>('remoteProxyHost', '127.0.0.1');
		this._proxyType = cfg.get<string>('proxyType', 'http');
		this._enableLocalForwarding = cfg.get<boolean>('enableLocalForwarding', true);
		this._showStatusOnStartup = cfg.get<boolean>('showStatusOnStartup', true);
		this._rewriteCloudCodeEndpoint = cfg.get<boolean>('rewriteCloudCodeEndpoint', false);
	}

	get localProxyPort(): number { return this._localProxyPort; }
	get remoteProxyPort(): number { return this._remoteProxyPort; }
	get remoteProxyHost(): string { return this._remoteProxyHost; }
	get proxyType(): string { return this._proxyType; }
	get enableLocalForwarding(): boolean { return this._enableLocalForwarding; }
	get showStatusOnStartup(): boolean { return this._showStatusOnStartup; }
	get rewriteCloudCodeEndpoint(): boolean { return this._rewriteCloudCodeEndpoint; }

	/**
	 * Register a listener that fires when ssh-relay-guard config changes.
	 * Returns a disposable to unregister.
	 */
	onChange(listener: () => void): vscode.Disposable {
		this.changeListeners.push(listener);
		return new vscode.Disposable(() => {
			const idx = this.changeListeners.indexOf(listener);
			if (idx >= 0) { this.changeListeners.splice(idx, 1); }
		});
	}

	dispose(): void {
		this.disposable.dispose();
		this.changeListeners = [];
	}
}
