import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConfigService } from '../core/configService';

suite('ConfigService Tests', () => {
	let configService: ConfigService;

	setup(async () => {
		// Reset config defaults before each test
		const config = vscode.workspace.getConfiguration('ssh-relay-guard');
		await config.update('localProxyPort', undefined, vscode.ConfigurationTarget.Global);
		await config.update('setGlobalHttpProxy', undefined, vscode.ConfigurationTarget.Global);
		configService = new ConfigService();
	});

	teardown(async () => {
		configService.dispose();
	});

	test('should initialize with default values from package.json', () => {
		assert.strictEqual(configService.localProxyPort, 7890);
		assert.strictEqual(configService.remoteProxyPort, 7890);
		assert.strictEqual(configService.remoteProxyHost, '127.0.0.1');
		assert.strictEqual(configService.proxyType, 'http');
		assert.strictEqual(configService.enableLocalForwarding, true);
		assert.strictEqual(configService.setGlobalHttpProxy, false);
	});

	test('should update when vscode configuration changes', async () => {
		const config = vscode.workspace.getConfiguration('ssh-relay-guard');

		// Wait for change event
		const changePromise = new Promise<void>((resolve) => {
			const disposable = configService.onChange(() => {
				disposable.dispose();
				resolve();
			});
		});

		await config.update('localProxyPort', 1234, vscode.ConfigurationTarget.Global);
		await changePromise;

		assert.strictEqual(configService.localProxyPort, 1234);
	});

	test('should properly remove change listeners', async () => {
		let called = false;
		const disposable = configService.onChange(() => {
			called = true;
		});
		disposable.dispose();

		const config = vscode.workspace.getConfiguration('ssh-relay-guard');
		await config.update('localProxyPort', 5678, vscode.ConfigurationTarget.Global);

		// Wait briefly to ensure event loop processes the change
		await new Promise((r) => setTimeout(r, 100));

		assert.strictEqual(called, false);
	});
});
