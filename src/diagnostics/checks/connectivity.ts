import { execAsync } from '../../utils/processUtils';
import { DiagnosticCheck, ProtocolTestResult } from '../healthChecker';

/** Known Google IP prefixes for CDN/API endpoints. */
const GOOGLE_IP_PREFIXES = ['142.250.', '172.217.', '216.58.', '74.125.', '173.194.', '108.177.'];

/**
 * Check external connectivity through proxy.
 * Tests both HTTP and SOCKS5 protocols and reports availability of each.
 */
export async function checkExternalConnectivity(
	remoteProxyHost: string,
	remoteProxyPort: number,
	currentProxyType: string,
): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'external-connectivity',
		name: 'External Connectivity',
		status: 'running',
		currentProtocol: currentProxyType,
	};

	const protocols: Array<'http' | 'socks5'> = ['http', 'socks5'];

	const testProtocol = async (protocol: 'http' | 'socks5'): Promise<ProtocolTestResult> => {
		const result: ProtocolTestResult = {
			protocol,
			success: false,
			isCurrent: protocol === currentProxyType,
		};

		try {
			const { stdout } = await execAsync(
				`curl -x ${protocol}://${remoteProxyHost}:${remoteProxyPort} https://www.google.com -o /dev/null -s -w "%{http_code}" --connect-timeout 10`,
				{ timeout: 15000 },
			);
			const httpCode = stdout.trim();

			if (httpCode === '200' || httpCode === '301' || httpCode === '302') {
				result.success = true;
				result.httpCode = httpCode;
			} else {
				result.error = `HTTP ${httpCode}`;
			}
		} catch {
			result.error = 'Connection failed';
		}

		return result;
	};

	const results = await Promise.all(protocols.map(testProtocol));
	check.protocolResults = results;

	const currentResult = results.find((r) => r.isCurrent);
	const anySuccess = results.some((r) => r.success);
	const currentSuccess = currentResult?.success ?? false;

	if (currentSuccess) {
		check.status = 'success';
		const availableCount = results.filter((r) => r.success).length;
		check.message = `Current protocol (${currentProxyType.toUpperCase()}) is working. ${availableCount}/${protocols.length} protocols available.`;
	} else if (anySuccess) {
		check.status = 'warning';
		const workingProtocols = results
			.filter((r) => r.success)
			.map((r) => r.protocol)
			.join(', ');
		const firstWorking = results.find((r) => r.success);
		check.message = `Current protocol (${currentProxyType.toUpperCase()}) is not working.`;
		check.suggestion = `Click 🔧 to switch to ${workingProtocols.toUpperCase()} which is available.`;
		if (firstWorking) {
			check.fixAction = `switchProtocol:${firstWorking.protocol}`;
		}
	} else {
		check.status = 'error';
		check.message = 'No proxy protocol is working.';
		check.suggestion =
			'Check if the proxy is properly forwarding traffic. Verify your local proxy has internet access.';
	}

	return check;
}

/**
 * Check for DNS pollution by comparing system DNS vs trusted DNS (8.8.8.8).
 */
export async function checkDNSPollution(): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'dns-pollution',
		name: 'DNS Pollution Detection',
		status: 'running',
	};

	const testDomain = 'daily-cloudcode-pa.googleapis.com';
	let systemIP = '';
	let trustedIP = '';

	try {
		try {
			const { stdout } = await execAsync(
				`dig +short ${testDomain} 2>/dev/null | head -1 || nslookup ${testDomain} 2>/dev/null | grep -A1 'Name:' | grep 'Address:' | awk '{print $2}' | head -1`,
				{ timeout: 5000 },
			);
			systemIP = stdout.trim().split('\n')[0].trim();
		} catch {
			// dig/nslookup not available
		}

		if (!systemIP) {
			check.status = 'warning';
			check.message = 'Cannot resolve DNS (dig/nslookup not available)';
			check.suggestion = 'Install dnsutils to enable DNS pollution detection';
			return check;
		}

		try {
			const { stdout } = await execAsync(
				`dig +short ${testDomain} @8.8.8.8 2>/dev/null | head -1`,
				{ timeout: 5000 },
			);
			trustedIP = stdout.trim().split('\n')[0].trim();
		} catch {
			// Can't reach 8.8.8.8 (likely blocked)
		}

		if (!trustedIP) {
			const isLikelyGoogle = GOOGLE_IP_PREFIXES.some((p) => systemIP.startsWith(p));
			if (isLikelyGoogle) {
				check.status = 'success';
				check.message = `DNS OK: ${testDomain} → ${systemIP} (matches Google IP range)`;
			} else {
				check.status = 'warning';
				check.message = `DNS suspicious: ${testDomain} → ${systemIP} (not a known Google IP)`;
				check.suggestion =
					'Cannot verify against trusted DNS (8.8.8.8 blocked). Ensure mgraftcp-fakedns is working for LS traffic.';
			}
			return check;
		}

		if (systemIP === trustedIP) {
			check.status = 'success';
			check.message = `DNS clean: ${testDomain} → ${systemIP}`;
		} else {
			const systemIsGoogle = GOOGLE_IP_PREFIXES.some((p) => systemIP.startsWith(p));
			const trustedIsGoogle = GOOGLE_IP_PREFIXES.some((p) => trustedIP.startsWith(p));

			if (systemIsGoogle && trustedIsGoogle) {
				check.status = 'success';
				check.message = `DNS OK: ${testDomain} → ${systemIP} (CDN, trusted: ${trustedIP})`;
			} else {
				check.status = 'error';
				check.message = `DNS POLLUTED: ${testDomain} → ${systemIP} (trusted: ${trustedIP})`;
				check.suggestion =
					'DNS is poisoned — but each layer already has a bypass: ' +
					'(1) LS autocomplete: mgraftcp-fakedns wrapper handles it automatically. ' +
					'(2) Terminal (curl/pip/npm): run "srg-on" to set HTTP_PROXY → proxy resolves DNS. ' +
					'(3) Resistant programs: run "srg-proxy <cmd>" for transparent proxy with FakeDNS.';
			}
		}
	} catch (error) {
		check.status = 'warning';
		check.message = `DNS check failed: ${error}`;
	}

	return check;
}
