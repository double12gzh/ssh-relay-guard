import * as assert from 'assert';
import * as vscode from 'vscode';
import { DashboardManager } from '../panel/dashboardManager';

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
	reload: () => { }
} as any;

/**
 * Mock ConnectionMonitor
 */
const mockConnectionMonitor = {
	start: () => { },
	stop: () => { },
	refresh: async () => { },
	onUpdate: () => vscode.Disposable.from(),
	getStats: () => ({
		connections: [{ name: 'TCP (127.0.0.1)', rate: '1 MB/s' }],
		sessionDuration: '1m',
		totalRequests: 50,
		htmlCache: ''
	})
} as any;

/**
 * Mock ExtensionContext
 */
const mockContext = {
	globalState: {
		get: (key: string, def?: any) => { return def; },
		update: async (key: string, val: any) => { }
	},
	subscriptions: []
} as any;

suite('DashboardManager', () => {
	let dashboard: DashboardManager;

	setup(() => {
		dashboard = new DashboardManager(true, mockContext, mockConfigService);
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
});
