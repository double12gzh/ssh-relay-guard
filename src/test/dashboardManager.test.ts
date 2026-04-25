import * as assert from 'assert';
import * as vscode from 'vscode';
import { DashboardManager } from '../panel/dashboardManager';
import { StateManager } from '../core/stateManager';

/**
 * Mock ConfigService
 */
const mockConfigService = {
	isLocal: true,
	localProxyPort: 7890,
	remoteProxyHost: '127.0.0.1',
	remoteProxyPort: 7890,
	proxyType: 'http',
	rewriteCloudCodeEndpoint: true,
	globalForwardingEnabled: true,
	onChange: () => vscode.Disposable.from(),
	reload: () => {},
} as any;

/**
 * Mock ConnectionMonitor
 */
const mockConnectionMonitor = {
	start: () => {},
	stop: () => {},
	refresh: async () => {},
	onUpdate: () => vscode.Disposable.from(),
	getStats: () => ({
		connections: [{ name: 'TCP (127.0.0.1)', rate: '1 MB/s' }],
		sessionDuration: '1m',
		totalRequests: 50,
		htmlCache: '',
	}),
} as any;

/**
 * Mock ExtensionContext
 */
const mockContext = {
	globalState: {
		get: (key: string, def?: any) => {
			return def;
		},
		update: async (key: string, val: any) => {},
	},
	subscriptions: [],
} as any;

suite('DashboardManager', () => {
	let dashboard: DashboardManager;
	let stateManager: StateManager;

	setup(() => {
		stateManager = new StateManager();
		dashboard = new DashboardManager(true, mockContext, mockConfigService, stateManager);
		// Note: The previous test mock passed connection monitor, but it's instantiated inside DashboardManager now.
	});

	test('should initialize with correct default status', () => {
		const status = dashboard.getStatus();
		assert.strictEqual(status.sshConfigEnabled, false);
		assert.strictEqual(status.hasConfiguredHosts, undefined);
	});

	test('should accurately update LanguageServerStatus', () => {
		dashboard.updateLanguageServerStatus(true);
		const status = dashboard.getStatus();
		assert.strictEqual(status.languageServerConfigured, true);
	});

	test('should properly generate HTML', () => {
		const html = dashboard['getPanelHtml']();
		assert.ok(html.includes('class="root"'));
		assert.ok(html.includes('var(--bg)')); // checking css
	});

	suite('Status Bar Logic (Local Mode)', () => {
		test('should show disconnected when SSH configured but active tunnels count is 0', () => {
			stateManager.updateState({
				sshConfigEnabled: true,
				activeTunnelsCount: 0,
				localProxyReachable: true,
			});
			dashboard['updateStatusBar']();
			const tooltip = dashboard['statusBarItem'].tooltip;
			assert.strictEqual(
				tooltip,
				'SSH Relay Guard (SRG)\n⚠️ SSH configured, but tunnel is not running',
			);
		});

		test('should show connected when SSH configured, tunnels count > 0, and proxy reachable', () => {
			stateManager.updateState({
				sshConfigEnabled: true,
				activeTunnelsCount: 1,
				localProxyReachable: true,
			});
			dashboard['updateStatusBar']();
			const tooltip = dashboard['statusBarItem'].tooltip;
			assert.strictEqual(tooltip, 'SSH Relay Guard (SRG)\n✅ Connected');
		});
	});
});
