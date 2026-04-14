import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { RemoteModeController } from '../core/remoteModeController';
import { ConfigService } from '../core/configService';
import { DashboardManager } from '../panel/dashboardManager';

suite('RemoteModeController', () => {
    let controller: RemoteModeController;
    let mockContext: vscode.ExtensionContext;
    let mockConfigService: ConfigService;

    setup(() => {
        mockContext = {
            subscriptions: [],
            extensionPath: '/fake/ext',
            globalState: {
                get: sinon.stub(),
                update: sinon.stub()
            }
        } as any;

        mockConfigService = new ConfigService();
        const mockDashboardManager = {} as DashboardManager;
        const mockLog = (msg: string) => {};
        
        controller = new RemoteModeController(mockContext, mockConfigService, mockDashboardManager, mockLog);
    });

    teardown(() => {
        sinon.restore();
    });

    test('should initialize cleanly', () => {
        assert.ok(controller);
    });
});
