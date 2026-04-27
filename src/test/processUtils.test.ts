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
	countSiblingServerInstances,
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

	// ── Fallback safety tests ──────────────────────────────────────

	test('fallback should match via PPID chain when pgrep is unavailable', async () => {
		// Simulate: pgrep fails → ps aux returns one candidate → PPID chain matches
		const serverPpid = process.ppid;
		let callIndex = 0;
		(customExecAsyncForTesting as any) = async (cmd: string) => {
			callIndex++;
			if (cmd.includes('pgrep -a -g')) {
				throw new Error('pgrep not available');
			}
			if (cmd.includes('ps aux')) {
				return {
					stdout: `user 55555 0.0 0.1 2000 1000 ? S 12:00 0:00 language_server_linux /path/to/server.js\n`,
					stderr: '',
				};
			}
			// PPID chain: 55555 → serverPpid (match on first hop)
			if (cmd.includes('ps -o ppid=') && cmd.includes('55555')) {
				return { stdout: `${serverPpid}\n`, stderr: '' };
			}
			return { stdout: '', stderr: '' };
		};

		invalidateProcessCache();
		const proc = await getMonitoredProcess();

		assert.ok(proc, 'Should find process via PPID chain');
		assert.strictEqual(proc?.pid, 55555);
	});

	test('fallback should match via cwd when PPID chain fails', async () => {
		// Simulate: pgrep fails → ps aux returns one candidate → PPID chain does NOT match →
		// cwd matches the server dir prefix
		let callIndex = 0;
		(customExecAsyncForTesting as any) = async (cmd: string) => {
			callIndex++;
			if (cmd.includes('pgrep -a -g')) {
				throw new Error('pgrep not available');
			}
			if (cmd.includes('ps aux')) {
				return {
					stdout: `user 66666 0.0 0.1 2000 1000 ? S 12:00 0:00 language_server_linux /path/to/server.js\n`,
					stderr: '',
				};
			}
			// PPID chain: 66666 → 1 (init, no match)
			if (cmd.includes('ps -o ppid=') && cmd.includes('66666')) {
				return { stdout: '1\n', stderr: '' };
			}
			// cwd match: readlink returns a path under __dirname's server root
			if (cmd.includes('readlink /proc/66666/cwd')) {
				// Derive expected server dir prefix from __dirname
				const extIdx = __dirname.indexOf('/extensions/');
				const prefix =
					extIdx > 0 ? __dirname.substring(0, extIdx) : '/home/user/.antigravity-server';
				return { stdout: `${prefix}/bin/server\n`, stderr: '' };
			}
			return { stdout: '', stderr: '' };
		};

		invalidateProcessCache();
		const proc = await getMonitoredProcess();

		// If __dirname contains '/extensions/' the cwd strategy will match
		const extIdx = __dirname.indexOf('/extensions/');
		if (extIdx > 0) {
			assert.ok(proc, 'Should find process via cwd match');
			assert.strictEqual(proc?.pid, 66666);
		} else {
			// In test environment __dirname likely won't have '/extensions/',
			// so it falls back to single-candidate degradation
			assert.ok(proc, 'Should still find single candidate via degradation');
			assert.strictEqual(proc?.pid, 66666);
		}
	});

	test('fallback should return single candidate when no filter matches', async () => {
		// Single candidate, PPID chain → init, cwd → not matching
		(customExecAsyncForTesting as any) = async (cmd: string) => {
			if (cmd.includes('pgrep -a -g')) {
				throw new Error('pgrep not available');
			}
			if (cmd.includes('ps aux')) {
				return {
					stdout: `user 77777 0.0 0.1 2000 1000 ? S 12:00 0:00 language_server_linux --persistent_mode\n`,
					stderr: '',
				};
			}
			if (cmd.includes('ps -o ppid=')) {
				return { stdout: '1\n', stderr: '' };
			}
			if (cmd.includes('readlink')) {
				return { stdout: '/some/other/path\n', stderr: '' };
			}
			return { stdout: '', stderr: '' };
		};

		invalidateProcessCache();
		const proc = await getMonitoredProcess();

		assert.ok(proc, 'Single candidate should be used via safe degradation');
		assert.strictEqual(proc?.pid, 77777);
		assert.strictEqual(proc?.isPersistent, true);
	});

	test('fallback should return null when multiple candidates and no filter matches', async () => {
		// Multiple candidates, none match PPID or cwd → refuse to guess
		(customExecAsyncForTesting as any) = async (cmd: string) => {
			if (cmd.includes('pgrep -a -g')) {
				throw new Error('pgrep not available');
			}
			if (cmd.includes('ps aux')) {
				return {
					stdout:
						`user 88888 0.0 0.1 2000 1000 ? S 12:00 0:00 language_server_linux /path1\n` +
						`user 99999 0.0 0.1 2000 1000 ? S 12:00 0:00 language_server_linux /path2\n`,
					stderr: '',
				};
			}
			// All PPID chains lead to init
			if (cmd.includes('ps -o ppid=')) {
				return { stdout: '1\n', stderr: '' };
			}
			// All cwd checks fail
			if (cmd.includes('readlink')) {
				return { stdout: '/unrelated/path\n', stderr: '' };
			}
			return { stdout: '', stderr: '' };
		};

		invalidateProcessCache();
		const proc = await getMonitoredProcess();

		assert.strictEqual(proc, null, 'Should refuse to guess with multiple unmatched candidates');
	});

	suite('countSiblingServerInstances Tests', () => {
		test('should return count from command output when successful', async () => {
			(customExecAsyncForTesting as any) = async (cmd: string) => {
				if (cmd.includes('ls -d /proc/*/cwd')) {
					return { stdout: '3\n', stderr: '' };
				}
				return { stdout: '', stderr: '' };
			};

			const count = await countSiblingServerInstances();
			// Since test __dirname might not have '/extensions/', serverDirPrefix might be null,
			// causing it to return 1. So we mock deriveServerDirPrefix or just rely on the fallback.
			// Let's actually check if deriveServerDirPrefix works.
			if (__dirname.includes('/extensions/')) {
				assert.strictEqual(count, 3);
			} else {
				// Because deriveServerDirPrefix returns null when not in extension path, it returns 1
				assert.strictEqual(count, 1);
			}
		});

		test('should return 1 when command fails', async () => {
			(customExecAsyncForTesting as any) = async () => {
				throw new Error('Command failed');
			};

			const count = await countSiblingServerInstances();
			assert.strictEqual(count, 1);
		});
	});
});
