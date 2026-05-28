import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LocalModeController } from '../core/localModeController';
import { ConfigService } from '../core/configService';
import { DashboardManager } from '../panel/dashboardManager';
import { TunnelManager } from '../core/tunnelManager';
import { StateManager } from '../core/stateManager';
import { customHomedirForTesting, updateForHost, readAllStatus } from '../core/sshConfigManager';

suite('LocalModeController', () => {
	let controller: LocalModeController;
	let mockContext: vscode.ExtensionContext;
	let mockConfigService: ConfigService;
	let stateManager: StateManager;
	let tmpDir: string;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srg-local-ctrl-test-'));
		(customHomedirForTesting as any) = tmpDir;

		mockContext = {
			subscriptions: [],
			extensionPath: '/fake/ext',
			globalState: {
				get: sinon.stub(),
				update: sinon.stub(),
			},
		} as any;

		// Clean global config before test
		const config = vscode.workspace.getConfiguration('ssh-relay-guard');
		await config.update('localProxyPort', 7897, vscode.ConfigurationTarget.Global);
		await config.update('enableLocalForwarding', true, vscode.ConfigurationTarget.Global);

		mockConfigService = new ConfigService();
		stateManager = new StateManager();
		const mockDashboardManager = {
			refreshStatus: sinon.stub().resolves(),
			startAutoRefresh: sinon.stub(),
			startStatusBarMonitor: sinon.stub(),
		} as any;
		const mockTunnelManager = {
			startHealthMonitor: sinon.stub(),
		} as any;
		const mockLog = (msg: string) => {};

		controller = new LocalModeController(
			mockContext,
			mockConfigService,
			mockDashboardManager,
			mockTunnelManager,
			stateManager,
			mockLog,
		);
	});

	teardown(async () => {
		(customHomedirForTesting as any) = undefined;
		await fs.rm(tmpDir, { recursive: true, force: true });
		sinon.restore();
		mockConfigService.dispose();

		const config = vscode.workspace.getConfiguration('ssh-relay-guard');
		await config.update('localProxyPort', undefined, vscode.ConfigurationTarget.Global);
		await config.update('enableLocalForwarding', undefined, vscode.ConfigurationTarget.Global);
	});

	test('should initialize cleanly', () => {
		assert.ok(controller);
	});

	test('should automatically synchronize stale host port configurations in config.srg on startup', async () => {
		// 1. Create a host block in config.srg with stale local port 5678
		await updateForHost('test-host', 49600, 5678, true, () => {});

		const initialStatus = await readAllStatus();
		assert.strictEqual(initialStatus.hostData.get('test-host')?.localPort, 5678);

		// 2. Activate controller (should auto-sync stale port 5678 to 7897)
		await controller.activate();

		// 3. Verify it was updated to 7897
		const statusAfterActivation = await readAllStatus();
		assert.strictEqual(statusAfterActivation.hostData.get('test-host')?.localPort, 7897);
	});
});
