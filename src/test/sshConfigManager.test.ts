import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	updateForHost,
	readStatus,
	readAllStatus,
	SRG_CONFIG_FILENAME,
	INCLUDE_LINE,
	customHomedirForTesting,
} from '../core/sshConfigManager';

/**
 * Tests for SSH Config Manager.
 *
 * These are the most critical tests: they verify that SSH config files
 * are written correctly, since malformed configs can break SSH connectivity.
 */
suite('SSH Config Manager', () => {
	let tmpDir: string;
	let origHome: string;

	// Redirect HOME to a temp directory so tests don't touch real ~/.ssh
	suiteSetup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srg-test-'));
		origHome = os.homedir();
		// Override homedir via our test hook
		(customHomedirForTesting as any) = tmpDir;
	});

	suiteTeardown(async () => {
		(customHomedirForTesting as any) = undefined;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	setup(async () => {
		// Clean up .ssh dir before each test
		const sshDir = path.join(tmpDir, '.ssh');
		await fs.rm(sshDir, { recursive: true, force: true });
	});

	const log = (_msg: string) => {};

	// ── updateForHost ─────────────────────────────────────────────

	test('should create config.srg and Include line for new host', async () => {
		await updateForHost('test-server', 7890, 7890, true, log);

		const sshDir = path.join(tmpDir, '.ssh');
		const srgConfig = await fs.readFile(path.join(sshDir, SRG_CONFIG_FILENAME), 'utf-8');
		const mainConfig = await fs.readFile(path.join(sshDir, 'config'), 'utf-8');

		// config.srg should contain the host block
		assert.ok(srgConfig.includes('# --- SRG:test-server ---'), 'Should have start marker');
		assert.ok(srgConfig.includes('# --- SRG:test-server END ---'), 'Should have end marker');
		assert.ok(srgConfig.includes('Host test-server'), 'Should have Host directive');
		assert.ok(srgConfig.includes('# SRG_REMOTE_PORT=7890'), 'Should have SRG_REMOTE_PORT');
		assert.ok(srgConfig.includes('ControlMaster auto'), 'Should have ControlMaster');
		assert.ok(srgConfig.includes('ControlPersist 4h'), 'Should have ControlPersist');

		// main config should include config.srg at the first line
		assert.ok(
			mainConfig.startsWith(INCLUDE_LINE),
			'Main config should start with Include config.srg',
		);
	});

	test('should support multiple hosts', async () => {
		await updateForHost('server-a', 7890, 7890, true, log);
		await updateForHost('server-b', 8080, 7890, true, log);

		const sshDir = path.join(tmpDir, '.ssh');
		const srgConfig = await fs.readFile(path.join(sshDir, SRG_CONFIG_FILENAME), 'utf-8');

		assert.ok(srgConfig.includes('# --- SRG:server-a ---'), 'Should have server-a');
		assert.ok(srgConfig.includes('# --- SRG:server-b ---'), 'Should have server-b');
		assert.ok(srgConfig.includes('# SRG_REMOTE_PORT=7890'), 'Should have port 7890');
		assert.ok(srgConfig.includes('# SRG_REMOTE_PORT=8080'), 'Should have port 8080');
	});

	test('should update existing host block (idempotent)', async () => {
		await updateForHost('test-server', 7890, 7890, true, log);
		await updateForHost('test-server', 8080, 7890, true, log);

		const sshDir = path.join(tmpDir, '.ssh');
		const srgConfig = await fs.readFile(path.join(sshDir, SRG_CONFIG_FILENAME), 'utf-8');

		// Should have exactly one host block
		const markerCount = (srgConfig.match(/# --- SRG:test-server ---/g) || []).length;
		assert.strictEqual(markerCount, 1, 'Should have exactly one start marker');

		// Should use the updated port
		assert.ok(srgConfig.includes('# SRG_REMOTE_PORT=8080'), 'Should have updated port');
		assert.ok(!srgConfig.includes('# SRG_REMOTE_PORT=7890'), 'Should not have old port');
	});

	test('should remove host block when disabled', async () => {
		await updateForHost('test-server', 7890, 7890, true, log);
		await updateForHost('test-server', 0, 0, false, log);

		const sshDir = path.join(tmpDir, '.ssh');

		// config.srg should be deleted (no hosts left)
		let exists = true;
		try {
			await fs.access(path.join(sshDir, SRG_CONFIG_FILENAME));
		} catch {
			exists = false;
		}
		assert.ok(!exists, 'config.srg should be deleted when no hosts remain');

		// Include line should be removed from main config
		const mainConfig = await fs.readFile(path.join(sshDir, 'config'), 'utf-8');
		assert.ok(!mainConfig.includes(INCLUDE_LINE), 'Include line should be removed');
	});

	test('should only remove specified host, keep others', async () => {
		await updateForHost('server-a', 7890, 7890, true, log);
		await updateForHost('server-b', 8080, 7890, true, log);
		await updateForHost('server-a', 0, 0, false, log);

		const sshDir = path.join(tmpDir, '.ssh');
		const srgConfig = await fs.readFile(path.join(sshDir, SRG_CONFIG_FILENAME), 'utf-8');

		assert.ok(!srgConfig.includes('# --- SRG:server-a ---'), 'server-a should be removed');
		assert.ok(srgConfig.includes('# --- SRG:server-b ---'), 'server-b should remain');
	});

	test('should not duplicate Include line on repeated calls', async () => {
		await updateForHost('test-server', 7890, 7890, true, log);
		await updateForHost('test-server', 7890, 7890, true, log);

		const sshDir = path.join(tmpDir, '.ssh');
		const mainConfig = await fs.readFile(path.join(sshDir, 'config'), 'utf-8');

		const includeCount = (
			mainConfig.match(
				new RegExp(INCLUDE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
			) || []
		).length;
		assert.strictEqual(includeCount, 1, 'Should have exactly one Include line');
	});

	test('should set permissions 600 on config files', async () => {
		await updateForHost('test-server', 7890, 7890, true, log);

		const sshDir = path.join(tmpDir, '.ssh');
		const srgStat = await fs.stat(path.join(sshDir, SRG_CONFIG_FILENAME));
		const configStat = await fs.stat(path.join(sshDir, 'config'));

		// Check owner-only read/write (0o600 = 33152 on octal mode)
		assert.strictEqual(srgStat.mode & 0o777, 0o600, 'config.srg should be 600');
		assert.strictEqual(configStat.mode & 0o777, 0o600, 'config should be 600');
	});

	// ── readStatus ────────────────────────────────────────────────

	test('readStatus should return enabled=false when no config exists', async () => {
		const status = await readStatus();
		assert.strictEqual(status.enabled, false);
		assert.deepStrictEqual(status.hosts, []);
	});

	test('readStatus should return host list and port', async () => {
		await updateForHost('my-server', 7890, 7890, true, log);

		const status = await readStatus();
		assert.strictEqual(status.enabled, true);
		assert.strictEqual(status.port, 7890);
		assert.ok(status.hosts?.includes('my-server'));
	});

	test('readStatus with hostname filter should match specific host', async () => {
		await updateForHost('server-a', 7890, 7890, true, log);
		await updateForHost('server-b', 8080, 7890, true, log);

		const statusA = await readStatus('server-a');
		assert.strictEqual(statusA.enabled, true);
		assert.strictEqual(statusA.port, 7890);

		const statusB = await readStatus('server-b');
		assert.strictEqual(statusB.enabled, true);
		assert.strictEqual(statusB.port, 8080);

		const statusC = await readStatus('server-c');
		assert.strictEqual(statusC.enabled, false);
	});

	// ── readAllStatus ─────────────────────────────────────────────

	test('readAllStatus should return per-host port data', async () => {
		await updateForHost('server-a', 7890, 7890, true, log);
		await updateForHost('server-b', 8080, 7890, true, log);

		const all = await readAllStatus();
		assert.strictEqual(all.enabled, true);
		assert.strictEqual(all.hosts.length, 2);
		assert.strictEqual(all.hostData.get('server-a')?.port, 7890);
		assert.strictEqual(all.hostData.get('server-b')?.port, 8080);
	});
});
