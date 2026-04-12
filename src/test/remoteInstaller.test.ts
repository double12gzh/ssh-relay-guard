import * as assert from 'assert';
import { buildRestoreScript } from '../setup/remoteInstaller';

/**
 * Tests for Remote Installer.
 * buildRestoreScript is a pure function that generates a bash rollback script.
 */
suite('Remote Installer', () => {

	test('buildRestoreScript should return a valid bash script', () => {
		const script = buildRestoreScript();

		assert.ok(script.startsWith('#!/bin/bash'), 'Should start with shebang');
		assert.ok(script.includes('set -e'), 'Should use strict mode');
	});

	test('buildRestoreScript should search antigravity-server path', () => {
		const script = buildRestoreScript();

		assert.ok(script.includes('.antigravity-server'), 'Should search antigravity-server');
	});

	test('buildRestoreScript should restore .bak files', () => {
		const script = buildRestoreScript();

		assert.ok(script.includes('.bak'), 'Should reference backup files');
		assert.ok(script.includes('mv'), 'Should move backups back to originals');
		assert.ok(script.includes('Rollback complete'), 'Should print completion message');
	});

	test('buildRestoreScript should handle "nothing to rollback" case', () => {
		const script = buildRestoreScript();

		assert.ok(script.includes('Nothing to rollback'), 'Should handle empty case gracefully');
	});
});
