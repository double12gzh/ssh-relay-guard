import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { TunnelManager } from '../core/tunnelManager';

suite('TunnelManager', () => {
	let tunnelManager: TunnelManager;

	setup(() => {
		const extensionPath = path.join(__dirname, '..', '..');
		tunnelManager = new TunnelManager(extensionPath, (msg) => {
			/* mock log */
		});
	});

	teardown(async () => {
		await tunnelManager.stopAll();
		tunnelManager.stopHealthMonitor();
	});

	suite('Initialization and Basic Usage', () => {
		test('should initialize with empty tunnels', () => {
			assert.strictEqual(tunnelManager.getManagedHosts().length, 0);
		});

		test('should return correct daemon path (internal method test)', () => {
			const daemonPath = tunnelManager['getDaemonPath']();
			const platform = os.platform();
			const arch = os.arch();
			const osStr = platform === 'win32' ? 'windows' : platform;
			const archStr = arch === 'x64' ? 'amd64' : arch;
			const ext = platform === 'win32' ? '.exe' : '';

			assert.ok(daemonPath.includes(`srg-tunnel-client-${osStr}-${archStr}${ext}`));
		});
	});
});
