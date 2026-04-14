import * as assert from 'assert';
import * as sinon from 'sinon';
import * as childProcess from 'child_process';
import {
	isMgraftcpRunning,
	getMonitoredProcess,
	killTargetProcess,
	promptReloadWindow,
	customExecAsyncForTesting,
	invalidateProcessCache,
} from '../utils/processUtils';

suite('processUtils Tests', () => {
	setup(() => {
		// Reset the hook by default
		(customExecAsyncForTesting as any) = undefined;
	});

	teardown(() => {
		(customExecAsyncForTesting as any) = undefined;
		invalidateProcessCache();
	});

	test('isMgraftcpRunning should return true when pgrep returns output', async () => {
		let calledWithCmd = '';
		(customExecAsyncForTesting as any) = async (cmd: string) => {
			calledWithCmd = cmd;
			return { stdout: '12345\n', stderr: '' };
		};
		const isRunning = await isMgraftcpRunning();
		assert.strictEqual(isRunning, true);
		assert.strictEqual(calledWithCmd, 'pgrep -f mgraftcp');
	});

	test('isMgraftcpRunning should return false when pgrep fails', async () => {
		(customExecAsyncForTesting as any) = async () => {
			throw new Error('no process');
		};
		const isRunning = await isMgraftcpRunning();
		assert.strictEqual(isRunning, false);
	});

	test('getMonitoredProcess should correctly parse ps aux output', async () => {
		const psOutput =
			'user 12345 0.0 0.1 2000 1000 ? S 12:00 0:00 language_server_linux /path/to/server.js\n';
		(customExecAsyncForTesting as any) = async () => {
			return { stdout: psOutput, stderr: '' };
		};

		const proc = await getMonitoredProcess();

		assert.ok(proc);
		assert.strictEqual(proc?.pid, 12345);
		assert.strictEqual(proc?.isUsingProxy, false);
	});

	test('getMonitoredProcess should detect isUsingProxy when mgraftcp is in command', async () => {
		const psOutput =
			'user 12345 0.0 0.1 2000 1000 ? S 12:00 0:00 mgraftcp language_server_linux /path/to/server.js\n';
		(customExecAsyncForTesting as any) = async () => {
			return { stdout: psOutput, stderr: '' };
		};

		const proc = await getMonitoredProcess();

		assert.ok(proc);
		assert.strictEqual(proc?.pid, 12345);
		assert.strictEqual(proc?.isUsingProxy, true);
	});

	test('getMonitoredProcess should return null when ps fails', async () => {
		(customExecAsyncForTesting as any) = async () => {
			throw new Error('ps failed');
		};
		const proc = await getMonitoredProcess();
		assert.strictEqual(proc, null);
	});
});
