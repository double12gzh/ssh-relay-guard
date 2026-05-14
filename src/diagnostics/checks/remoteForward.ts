import { isPortReachable } from '../../utils/portProbe';
import { DiagnosticCheck } from '../healthChecker';

/**
 * Check remote port forwarding reachability.
 */
export async function checkRemotePortForward(
	remoteProxyHost: string,
	remoteProxyPort: number,
	localProxyPort: number,
): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'remote-forward',
		name: 'Remote Port Forwarding',
		status: 'running',
	};

	try {
		const reachable = await isPortReachable(remoteProxyHost, remoteProxyPort, 3000);
		if (reachable) {
			check.status = 'success';
			check.message = `Remote proxy port ${remoteProxyHost}:${remoteProxyPort} is reachable`;
		} else {
			check.status = 'error';
			check.message = `Cannot connect to ${remoteProxyHost}:${remoteProxyPort}`;
			check.suggestion = `Run on LOCAL terminal: ssh -fN -R ${remoteProxyPort}:127.0.0.1:${localProxyPort} &lt;your-host&gt;`;
			check.fixAction = `copyCommand:ssh -fN -R ${remoteProxyPort}:127.0.0.1:${localProxyPort} <your-host>`;
		}
	} catch (error) {
		check.status = 'error';
		check.message = `Error checking remote port: ${error}`;
		check.suggestion = `Run on LOCAL terminal: ssh -fN -R ${remoteProxyPort}:127.0.0.1:${localProxyPort} &lt;your-host&gt;`;
	}

	return check;
}
