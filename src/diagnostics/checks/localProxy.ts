import { isPortReachable } from '../../utils/portProbe';
import { DiagnosticCheck } from '../healthChecker';

/**
 * Check local proxy service reachability.
 */
export async function checkLocalProxy(localProxyPort: number): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'local-proxy',
		name: 'Local Proxy Service',
		status: 'running',
	};

	try {
		const reachable = await isPortReachable('127.0.0.1', localProxyPort, 3000);
		if (reachable) {
			check.status = 'success';
			check.message = `Local proxy is running on port ${localProxyPort}`;
		} else {
			check.status = 'error';
			check.message = `Cannot connect to local proxy on port ${localProxyPort}`;
			check.suggestion =
				'Please ensure your local proxy (e.g., Clash, V2Ray) is running and listening on the configured port.';
		}
	} catch (error) {
		check.status = 'error';
		check.message = `Error checking local proxy: ${error}`;
		check.suggestion = 'Please check if your proxy software is installed and running.';
	}

	return check;
}
