import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { RemoteModeController } from '../core/remoteModeController';
import { ConfigService } from '../core/configService';
import { DashboardManager } from '../panel/dashboardManager';
import { StateManager } from '../core/stateManager';

suite('RemoteModeController', () => {
	let controller: RemoteModeController;
	let mockContext: vscode.ExtensionContext;
	let mockConfigService: ConfigService;
	let stateManager: StateManager;

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
		stateManager = new StateManager();
		const mockDashboardManager = {} as DashboardManager;
		const mockLog = (msg: string) => {};

		controller = new RemoteModeController(
			mockContext,
			mockConfigService,
			mockDashboardManager,
			stateManager,
			mockLog,
		);
	});

	teardown(() => {
		sinon.restore();
	});

	test('should initialize cleanly', () => {
		assert.ok(controller);
	});
});
