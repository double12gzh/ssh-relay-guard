import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// ============================================================================
// SSH Configuration Management
// Uses shared config.srg format (compatible with srg-cli).
// Per-host marker blocks with ControlMaster for connection multiplexing.
// Config is PERSISTENT — not deleted on deactivate.
// ============================================================================

export const SRG_CONFIG_FILENAME = 'config.srg';
export const INCLUDE_LINE = `Include ${SRG_CONFIG_FILENAME}`;

// Test override hook
export let customHomedirForTesting: string | undefined = undefined;

export function getSSHDir(): string {
	return path.join(customHomedirForTesting ?? os.homedir(), '.ssh');
}

export function getSSHConfigPath(): string {
	return path.join(getSSHDir(), 'config');
}

export function getSrgConfigPath(): string {
	return path.join(getSSHDir(), SRG_CONFIG_FILENAME);
}

export function getSSHSocketDir(): string {
	return path.join(getSSHDir(), 'sockets');
}

/**
 * Build a regex to match a host marker block (start → end, including trailing newline).
 */
function buildHostBlockRegex(hostname: string): RegExp {
	const hostMarker = `# --- SRG:${hostname} ---`;
	const hostMarkerEnd = `# --- SRG:${hostname} END ---`;
	return new RegExp(
		`${hostMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${hostMarkerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
		'g'
	);
}


/**
 * Update SSH config using per-host marker blocks in config.srg.
 * Compatible with srg-cli's format: # --- SRG:hostname ---
 * Includes ControlMaster for connection multiplexing.
 */
export async function updateForHost(
	hostname: string,
	remotePort: number,
	localPort: number,
	enable: boolean,
	log: (msg: string) => void
): Promise<void> {
	const srgConfigPath = getSrgConfigPath();
	const mainConfigPath = getSSHConfigPath();
	const socketDir = getSSHSocketDir();
	const hostMarker = `# --- SRG:${hostname} ---`;
	const hostMarkerEnd = `# --- SRG:${hostname} END ---`;

	try {
		await fs.mkdir(getSSHDir(), { recursive: true });
		await fs.mkdir(socketDir, { recursive: true });

		if (enable) {
			let srgContent = '';
			try {
				srgContent = await fs.readFile(srgConfigPath, 'utf-8');
			} catch { log(`config.srg not found, will create`); }

			if (srgContent.includes(hostMarker)) {
				srgContent = srgContent.replace(buildHostBlockRegex(hostname), '');
			}

			if (!srgContent.trim()) {
				srgContent = '# SSH Relay Guard — Tunnel & Proxy Config\n'
					+ '# Shared config for Antigravity plugin and srg-cli.\n'
					+ '# Per-host blocks are managed automatically.\n\n';
			}

			const hostBlock = [
				hostMarker,
				`Host ${hostname}`,
				`    # Reverse tunnel: remote ${remotePort} → local ${localPort}`,
				`    RemoteForward ${remotePort} 127.0.0.1:${localPort}`,
				'    # Keep "no": VS Code Remote uses this config; explicit tunnel commands use ExitOnForwardFailure=yes',
				'    ExitOnForwardFailure no',
				'    # Connection multiplexing: tunnel persists after window close',
				'    ControlMaster auto',
				`    ControlPath ${socketDir}/%r@%h-%p`,
				'    ControlPersist 4h',
				hostMarkerEnd,
				'',
			].join('\n');

			srgContent = srgContent.trimEnd() + '\n' + hostBlock;
			await fs.writeFile(srgConfigPath, srgContent, { mode: 0o600 });
			log(`Updated ${srgConfigPath} for host ${hostname}`);

			let mainContent = '';
			try {
				mainContent = await fs.readFile(mainConfigPath, 'utf-8');
			} catch { log(`~/.ssh/config not found, will create`); }

			// Always ensure INCLUDE_LINE is exactly at the end by removing older ones first
			if (mainContent.includes(INCLUDE_LINE)) {
				mainContent = mainContent.split('\n').filter(line => line.trim() !== INCLUDE_LINE).join('\n');
			}
			
			mainContent = mainContent.trimEnd() + `\n\n${INCLUDE_LINE}\n`;
			await fs.writeFile(mainConfigPath, mainContent.trimStart(), { mode: 0o600 });
			log(`Added/Moved Include line to the end of ${mainConfigPath}`);
		} else {
			try {
				let srgContent = await fs.readFile(srgConfigPath, 'utf-8');
				if (srgContent.includes(hostMarker)) {
					srgContent = srgContent.replace(buildHostBlockRegex(hostname), '');
					await fs.writeFile(srgConfigPath, srgContent, { mode: 0o600 });
					log(`Removed host block for ${hostname}`);
				}

				if (!srgContent.includes('# --- SRG:')) {
					try { await fs.unlink(srgConfigPath); } catch { log(`config.srg already removed`); }
					try {
						let mainContent = await fs.readFile(mainConfigPath, 'utf-8');
						mainContent = mainContent.replace(`${INCLUDE_LINE}\n`, '');
						mainContent = mainContent.replace(INCLUDE_LINE, '');
						await fs.writeFile(mainConfigPath, mainContent, { mode: 0o600 });
					} catch { log(`Could not update ~/.ssh/config Include line`); }
					log('All host blocks removed, cleaned up config.srg and Include line');
				}
			} catch (e) { log(`Host block removal skipped: ${e}`); }
		}

		log(`SSH config updated for ${hostname} (enable=${enable})`);
	} catch (error) {
		log(`SSH config update error: ${error}`);
		throw error;
	}
}

/**
 * Get SSH config status by reading config.srg marker blocks.
 */
export async function readStatus(hostname?: string): Promise<{ enabled: boolean; port?: number; hosts?: string[] }> {
	const allStatus = await readAllStatus();
	
	if (hostname) {
		const hostData = allStatus.hostData.get(hostname);
		return {
			enabled: !!hostData,
			port: hostData?.port,
			hosts: allStatus.hosts,
		};
	}

	return {
		enabled: allStatus.enabled,
		port: allStatus.port,
		hosts: allStatus.hosts,
	};
}

export interface HostConfigData {
	port?: number;
}

/**
 * Read config.srg ONCE and return all host data.
 * Avoids N+1 file reads when iterating over hosts.
 */
export async function readAllStatus(): Promise<{
	enabled: boolean;
	port?: number;
	hosts: string[];
	hostData: Map<string, HostConfigData>;
}> {
	try {
		const srgConfigPath = getSrgConfigPath();
		const content = await fs.readFile(srgConfigPath, 'utf-8');

		const hostPattern = /^# --- SRG:(.*?) ---$/gm;
		const hosts: string[] = [];
		const hostData = new Map<string, HostConfigData>();
		let match;

		while ((match = hostPattern.exec(content)) !== null) {
			const name = match[1];
			if (!name.endsWith(' END')) {
				hosts.push(name);
			}
		}

		// Parse per-host port data in single pass
		for (const host of hosts) {
			const hostMarker = `# --- SRG:${host} ---`;
			const hostMarkerEnd = `# --- SRG:${host} END ---`;
			const blockStart = content.indexOf(hostMarker);
			const blockEnd = content.indexOf(hostMarkerEnd);

			if (blockStart !== -1 && blockEnd !== -1) {
				const block = content.substring(blockStart, blockEnd);
				const portMatch = block.match(/RemoteForward\s+(\d+)/);
				hostData.set(host, {
					port: portMatch ? parseInt(portMatch[1]) : undefined,
				});
			}
		}

		if (hosts.length > 0) {
			const portMatch = content.match(/RemoteForward\s+(\d+)/);
			return {
				enabled: true,
				port: portMatch ? parseInt(portMatch[1]) : undefined,
				hosts,
				hostData,
			};
		}
	} catch {
		// File doesn't exist
	}
	return { enabled: false, hosts: [], hostData: new Map() };
}
