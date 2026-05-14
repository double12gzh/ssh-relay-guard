import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { getSSHConfigPath } from '../../core/sshConfigManager';
import { DiagnosticCheck } from '../healthChecker';

/**
 * Check SSH config for RemoteForward / Include config.srg.
 */
export async function checkSSHConfig(remoteProxyPort: number): Promise<DiagnosticCheck> {
	const check: DiagnosticCheck = {
		id: 'ssh-config',
		name: 'SSH Configuration',
		status: 'running',
	};

	try {
		const configPath = getSSHConfigPath();
		const content = await fs.readFile(configPath, 'utf-8');

		if (content.includes('Include config.srg')) {
			// Current format: per-host blocks in config.srg
			const srgConfigPath = path.join(os.homedir(), '.ssh', 'config.srg');
			try {
				const srgContent = await fs.readFile(srgConfigPath, 'utf-8');

				// Find all configured hosts
				const hostPattern = /^# --- SRG:(.*?) ---$/gm;
				const hosts: string[] = [];
				let m;
				while ((m = hostPattern.exec(srgContent)) !== null) {
					if (!m[1].endsWith(' END')) {
						hosts.push(m[1]);
					}
				}

				if (hosts.length === 0) {
					check.status = 'error';
					check.message = 'config.srg exists but has no host blocks configured';
					check.suggestion =
						'Click 🔧 to open "Add Host Forwarding" and configure a host.';
					check.fixAction = 'enableForwarding';
				} else {
					// Check if any host has the expected remotePort
					const portMatches = [
						...srgContent.matchAll(/# SRG_REMOTE_PORT=(\d+)/g),
						...srgContent.matchAll(/RemoteForward\s+(\d+)/g),
					];
					const configuredPorts = portMatches.map((pm) => parseInt(pm[1]));
					const hasExpectedPort = configuredPorts.includes(remoteProxyPort);

					if (hasExpectedPort) {
						check.status = 'success';
						check.message = `SSH Proxy Port configured as ${remoteProxyPort} (${hosts.length} host(s): ${hosts.join(', ')})`;
					} else if (configuredPorts.length > 0) {
						check.status = 'warning';
						check.message = `Proxy Port mismatch: configured [${configuredPorts.join(', ')}], expected ${remoteProxyPort}`;
						check.suggestion =
							'Update port in SRG panel or run "Add Host Forwarding" command.';
					} else {
						check.status = 'error';
						check.message = 'Proxy Port configuration not found in config.srg';
						check.suggestion =
							'Click 🔧 to open "Add Host Forwarding" and configure SSH.';
						check.fixAction = 'enableForwarding';
					}
				}
			} catch {
				check.status = 'error';
				check.message = 'config.srg file not found despite Include line in ~/.ssh/config';
				check.suggestion =
					'Click 🔧 to open "Add Host Forwarding" and recreate SSH configuration.';
				check.fixAction = 'enableForwarding';
			}
		} else {
			check.status = 'error';
			check.message = 'SSH config does not include config.srg';
			check.suggestion = 'Click 🔧 to open "Add Host Forwarding" and configure SSH.';
			check.fixAction = 'enableForwarding';
		}
	} catch {
		check.status = 'error';
		check.message = 'Cannot read SSH config file';
		check.suggestion = 'Ensure ~/.ssh/config exists and is readable.';
	}

	return check;
}
