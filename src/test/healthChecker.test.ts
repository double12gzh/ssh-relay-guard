import * as assert from 'assert';
import {
	generateReportText,
	DiagnosticReport,
	DiagnosticCheck,
} from '../diagnostics/healthChecker';

/**
 * Tests for Health Check report generation.
 * generateReportText is a pure function — ideal for unit testing.
 */
suite('Health Checker — Report Generation', () => {
	function makeCheck(overrides: Partial<DiagnosticCheck>): DiagnosticCheck {
		return {
			id: 'test',
			name: 'Test Check',
			status: 'success',
			...overrides,
		};
	}

	function makeReport(
		checks: DiagnosticCheck[],
		overallStatus: 'healthy' | 'degraded' | 'broken' = 'healthy',
	): DiagnosticReport {
		return {
			timestamp: new Date('2026-01-01T00:00:00Z'),
			checks,
			overallStatus,
		};
	}

	test('should include header and footer markers', () => {
		const report = makeReport([]);
		const text = generateReportText(report);

		assert.ok(text.includes('=== SSH Relay Guard — Health Report ==='), 'Should have header');
		assert.ok(text.includes('=== End of Report ==='), 'Should have footer');
	});

	test('should include timestamp and overall status', () => {
		const report = makeReport([], 'broken');
		const text = generateReportText(report);

		assert.ok(text.includes('Timestamp: 2026-01-01T00:00:00.000Z'), 'Should have timestamp');
		assert.ok(text.includes('Overall Status: BROKEN'), 'Should have uppercased status');
	});

	test('should use correct icons for each status', () => {
		const checks = [
			makeCheck({ name: 'Pass Check', status: 'success', message: 'all good' }),
			makeCheck({ name: 'Warn Check', status: 'warning', message: 'heads up' }),
			makeCheck({ name: 'Error Check', status: 'error', message: 'broken' }),
			makeCheck({ name: 'Pending Check', status: 'pending', message: 'waiting' }),
		];
		const text = generateReportText(makeReport(checks));

		assert.ok(text.includes('[✓] Pass Check: all good'), 'Success should use ✓');
		assert.ok(text.includes('[⚠] Warn Check: heads up'), 'Warning should use ⚠');
		assert.ok(text.includes('[✗] Error Check: broken'), 'Error should use ✗');
		assert.ok(text.includes('[○] Pending Check: waiting'), 'Pending should use ○');
	});

	test('should include suggestions when present', () => {
		const checks = [
			makeCheck({
				name: 'Failing Check',
				status: 'error',
				message: 'something broke',
				suggestion: 'try restarting',
			}),
		];
		const text = generateReportText(makeReport(checks, 'broken'));

		assert.ok(text.includes('Suggestion: try restarting'), 'Should include suggestion');
	});

	test('should include protocol results for connectivity check', () => {
		const checks = [
			makeCheck({
				id: 'external-connectivity',
				name: 'External Connectivity',
				status: 'warning',
				message: 'HTTP not working',
				currentProtocol: 'http',
				protocolResults: [
					{ protocol: 'http', success: false, error: 'timeout', isCurrent: true },
					{ protocol: 'socks5', success: true, httpCode: '200', isCurrent: false },
				],
			}),
		];
		const text = generateReportText(makeReport(checks, 'degraded'));

		assert.ok(
			text.includes('├── HTTP: ✗ Not working ← Current'),
			'Should show HTTP as current',
		);
		assert.ok(text.includes('└── SOCKS5: ✓ Available'), 'Should show SOCKS5 as available');
	});

	test('should fall back to status when message is empty', () => {
		const checks = [makeCheck({ name: 'No Message', status: 'success' })];
		const text = generateReportText(makeReport(checks));

		assert.ok(text.includes('[✓] No Message: success'), 'Should use status as fallback');
	});
});
