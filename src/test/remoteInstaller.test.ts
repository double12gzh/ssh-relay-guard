import * as assert from 'assert';
import {
	buildRestoreScript,
	buildInstallScript,
	customReadFileForTesting,
} from '../setup/remoteInstaller';
import * as fs from 'fs/promises';
import * as sinon from 'sinon';
import * as path from 'path';

/**
 * Tests for Remote Installer.
 * buildRestoreScript is a pure function that generates a bash rollback script.
 */
suite('Remote Installer', () => {
	teardown(() => {
		sinon.restore();
		(customReadFileForTesting as any) = undefined;
	});

	suite('buildRestoreScript', () => {
		test('should return a valid bash script', () => {
			const script = buildRestoreScript();

			assert.ok(script.startsWith('#!/bin/bash'), 'Should start with shebang');
			assert.ok(script.includes('set -e'), 'Should use strict mode');
		});

		test('buildRestoreScript should search antigravity-server path', () => {
			const script = buildRestoreScript();

			assert.ok(script.includes('.antigravity-server'), 'Should search antigravity-server');
			assert.ok(
				script.includes('.antigravity-ide-server'),
				'Should search antigravity-ide-server',
			);
		});

		test('buildRestoreScript should restore .bak files', () => {
			const script = buildRestoreScript();

			assert.ok(script.includes('.bak'), 'Should reference backup files');
			assert.ok(script.includes('mv'), 'Should move backups back to originals');
			assert.ok(script.includes('Rollback complete'), 'Should print completion message');
		});

		test('buildRestoreScript should handle "nothing to rollback" case', () => {
			const script = buildRestoreScript();

			assert.ok(
				script.includes('Nothing to rollback'),
				'Should handle empty case gracefully',
			);
		});
	});

	suite('buildInstallScript', () => {
		test('should correctly construct setup script and inject utilities', async () => {
			(customReadFileForTesting as any) = async (filePathPath: any, encoding: any) => {
				const filePath = filePathPath as string;
				if (filePath.endsWith('setup-proxy.sh')) {
					return 'HOST=__PROXY_HOST__\nPORT=__PROXY_PORT__\n__INJECT_SRG_ON__\n__INJECT_LS_WRAPPER__';
				} else if (filePath.endsWith('srg-on')) {
					return 'SRG_ON_CONTENT __SRG_PORT__ __SRG_TYPE__';
				} else if (filePath.endsWith('ls-wrapper.sh')) {
					return '#!/bin/bash\nWRAPPER_CONTENT PROXY_ADDR="${SRG_PROXY_ADDR:-}"';
				}
				// Default content for other srg scripts
				return 'GENERIC_SCRIPT';
			};

			const extensionPath = '/fake/ext';
			const script = await buildInstallScript('192.168.1.1', 8080, true, extensionPath);

			// Check parameter replacements
			assert.ok(script.includes('HOST=192.168.1.1'));
			assert.ok(script.includes('PORT=8080'));

			// Check tool injections
			assert.ok(script.includes('SRG_ON_CONTENT'), 'Should inject srg-on');
			assert.ok(script.includes('__SRG_PORT_PH__'), 'Should transform srg-on placeholder');
			assert.ok(script.includes('WRAPPER_CONTENT'), 'Should inject ls-wrapper');
			// Wrapper no longer contains __SRG_ADDR__ (multi-user isolation: env-var only)
			assert.ok(
				!script.includes('__PROXY_ADDR_PLACEHOLDER__'),
				'Should NOT have hardcoded proxy addr placeholder',
			);
		});

		test('should include port auto-detection function in srg-on', async () => {
			// Use real file system to read actual srg-on content
			(customReadFileForTesting as any) = async (filePathPath: any, _encoding: any) => {
				const filePath = filePathPath as string;
				if (filePath.endsWith('setup-proxy.sh')) {
					return '__INJECT_SRG_ON__\n__INJECT_LS_WRAPPER__';
				} else if (filePath.endsWith('ls-wrapper.sh')) {
					return '#!/bin/bash\nWRAPPER';
				}
				// Read actual CLI tool files
				return fs.readFile(filePath, 'utf-8');
			};

			const extensionPath = path.resolve(__dirname, '../..');
			const script = await buildInstallScript('127.0.0.1', 7890, false, extensionPath);

			assert.ok(
				script.includes('_srg_detect_port'),
				'Generated script should contain _srg_detect_port function',
			);
			assert.ok(
				script.includes('curl --connect-timeout'),
				'Port detection should use curl proxy handshake',
			);
		});

		test('should throw error on invalid proxy host', async () => {
			await assert.rejects(
				buildInstallScript('invalid host!', 8080, true, '/fake/ext'),
				/Invalid proxy host/,
			);
		});
	});
});
