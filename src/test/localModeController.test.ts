import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { LocalModeController } from '../core/localModeController';
import { ConfigService } from '../core/configService';
import { DashboardManager } from '../panel/dashboardManager';
import { TunnelManager } from '../core/tunnelManager';

suite('LocalModeController', () => {
	let controller: LocalModeController;
	let mockContext: vscode.ExtensionContext;
	let mockConfigService: ConfigService;

	setup(() => {
		mockContext = {
			subscriptions: [],
			extensionPath: '/fake/ext',
			globalState: {
				get: sinon.stub(),
				update: sinon.stub(),
			},
		} as any;

		mockConfigService = new ConfigService();
		const mockDashboardManager = {} as DashboardManager;
		const mockTunnelManager = {} as TunnelManager;
		const mockLog = (msg: string) => {};

		controller = new LocalModeController(
			mockContext,
			mockConfigService,
			mockDashboardManager,
			mockTunnelManager,
			mockLog,
		);
	});

	teardown(() => {
		sinon.restore();
	});

	test('should initialize cleanly', () => {
		// Just verify it instantiates without error and provides an initialization interface
		assert.ok(controller);
	});
});
