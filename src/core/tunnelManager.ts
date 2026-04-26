import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';

/**
 * Track info for a running tunnel managed by the native Go daemon.
 */
interface TunnelInfo {
	hostname: string;
	localPort: number;
	remotePort: number;
	negotiatedPort: number;
	process: ChildProcess;
	statusFile: string;
	logFile: string;
	startedAt: Date;
}

export class TunnelManager implements vscode.Disposable {
	private tunnels: Map<string, TunnelInfo> = new Map();
	private healthCheckInterval: NodeJS.Timeout | undefined;
	private log: (message: string) => void;
	private extensionPath: string;

	constructor(extensionPath: string, log: (message: string) => void) {
		this.extensionPath = extensionPath;
		this.log = log;
	}

	private getDaemonPath(): string {
		const platform = os.platform();
		const arch = os.arch();
		let osStr = '';
		if (platform === 'darwin') osStr = 'darwin';
		else if (platform === 'linux') osStr = 'linux';
		else if (platform === 'win32') osStr = 'windows';

		let archStr = '';
		if (arch === 'x64') archStr = 'amd64';
		else if (arch === 'arm64') archStr = 'arm64';

		const ext = platform === 'win32' ? '.exe' : '';
		const binaryName = `srg-tunnel-client-${osStr}-${archStr}${ext}`;

		return path.join(this.extensionPath, 'resources', 'bin', binaryName);
	}

	async startTunnel(
		hostname: string,
		localPort: number,
		remotePort: number,
	): Promise<{
		connected: boolean;
		negotiatedPort?: number;
		logFile?: string;
		logContent?: string;
	}> {
		if (!/^[\w.\-@]+$/.test(hostname)) {
			this.log(`TunnelManager: Invalid hostname format '${hostname}'. Aborting.`);
			return { connected: false };
		}

		await this.stopTunnel(hostname);

		const daemonPath = this.getDaemonPath();
		try {
			await fs.access(daemonPath);
		} catch {
			this.log(`TunnelManager: Daemon binary not found at ${daemonPath}`);
			vscode.window.showErrorMessage(`Native tunnel daemon not found: ${daemonPath}`);
			return { connected: false };
		}

		// Cleanup any orphaned processes from previous ungraceful exits
		await this.cleanOrphanedDaemon(hostname);

		const statusFile = path.join(
			os.tmpdir(),
			`srg-status-${hostname.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}.json`,
		);
		const logFile = path.join(
			os.tmpdir(),
			`srg-daemon-${hostname.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}.log`,
		);

		this.log(`TunnelManager: Spawning Go daemon for ${hostname}`);
		this.log(`TunnelManager: Log file -> ${logFile}`);

		const args = [
			'-host',
			hostname,
			'-local-port',
			localPort.toString(),
			'-remote-port',
			remotePort.toString(),
			'-status-file',
			statusFile,
			'-log-file',
			logFile,
		];

		// We can support customSpawnForTesting if needed, but child_process.spawn is fine.
		const child = spawn(daemonPath, args, {
			detached: true,
			stdio: 'ignore',
		});

		child.unref();

		let negotiatedPort: number | undefined;
		let connected = false;

		// Poll for connection status (up to 20 seconds)
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 500));
			try {
				const content = await fs.readFile(statusFile, 'utf-8');
				const status = JSON.parse(content);
				if (status.state === 'connected') {
					connected = true;
					negotiatedPort = status.port;
					break;
				} else if (
					status.state === 'error' &&
					status.error === 'Max port retries exhausted'
				) {
					break;
				}
			} catch {
				// File might not exist yet or be half-written
			}

			if (child.exitCode !== null) {
				this.log(
					`TunnelManager: Daemon process exited prematurely with code ${child.exitCode}`,
				);
				break;
			}
		}

		if (connected && negotiatedPort !== undefined) {
			this.tunnels.set(hostname, {
				hostname,
				localPort,
				remotePort,
				negotiatedPort: negotiatedPort,
				process: child,
				statusFile,
				logFile,
				startedAt: new Date(),
			});
			this.log(
				`TunnelManager: Tunnel for ${hostname} established on remote port ${negotiatedPort}`,
			);
			this.log(`TunnelManager: Daemon log file: ${logFile}`);
			return { connected: true, negotiatedPort, logFile };
		} else {
			this.log(`TunnelManager: Failed to establish tunnel for ${hostname}`);
			// Read daemon log to surface SSH-level errors
			let logContent: string | undefined;
			try {
				const fullLog = await fs.readFile(logFile, 'utf-8');
				const lines = fullLog.trim().split('\n');
				const tail = lines.slice(-30).join('\n');
				logContent = tail;
				this.log(`TunnelManager: Daemon log (last 30 lines):\n${tail}`);
			} catch {
				this.log(`TunnelManager: Could not read daemon log at ${logFile}`);
			}
			try {
				child.kill('SIGTERM');
			} catch {}
			return { connected: false, logFile, logContent };
		}
	}

	async stopTunnel(hostname: string): Promise<void> {
		const info = this.tunnels.get(hostname);
		if (!info) {
			return;
		}

		this.log(`TunnelManager: stopping tunnel for ${hostname}`);
		try {
			info.process.kill('SIGTERM');
		} catch {}

		try {
			await fs.unlink(info.statusFile);
		} catch {}

		this.tunnels.delete(hostname);
	}

	async stopAll(): Promise<void> {
		for (const host of this.tunnels.keys()) {
			await this.stopTunnel(host);
		}
	}

	/**
	 * Ensure any orphaned Go daemon processes left over from previous
	 * ungraceful extension host exits (e.g. reload window) are terminated.
	 */
	private async cleanOrphanedDaemon(hostname: string): Promise<void> {
		const isWin = os.platform() === 'win32';
		try {
			const execAsync = promisify(exec);
			if (isWin) {
				// Windows fallback (less precise, kills all srg-tunnel-client)
				await execAsync(`taskkill /F /IM srg-tunnel-client-windows-amd64.exe /T`).catch(
					() => {},
				);
			} else {
				// pkill -f to match the exact command line args
				await execAsync(`pkill -9 -f "srg-tunnel-client.*-host ${hostname}"`).catch(
					() => {},
				);
			}
			this.log(`TunnelManager: Reaped orphaned daemon for ${hostname}`);
		} catch {
			// ignore
		}
	}

	async checkHealth(hostname: string): Promise<boolean> {
		const info = this.tunnels.get(hostname);
		if (!info) return false;

		try {
			const content = await fs.readFile(info.statusFile, 'utf-8');
			const status = JSON.parse(content);
			return status.state === 'connected';
		} catch {
			return false;
		}
	}

	startHealthMonitor(onTunnelCountChange: (count: number) => void): void {
		this.stopHealthMonitor();

		// The Go daemon natively handles process restart and SSH drops,
		// so TS side only needs to read the JSON status file.
		this.healthCheckInterval = setInterval(async () => {
			let activeCount = 0;
			for (const hostname of this.tunnels.keys()) {
				const healthy = await this.checkHealth(hostname);
				if (healthy) {
					activeCount++;
				}
			}
			onTunnelCountChange(activeCount);
		}, 10_000);
	}

	stopHealthMonitor(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = undefined;
		}
	}

	getManagedHosts(): string[] {
		return [...this.tunnels.keys()];
	}

	dispose(): void {
		this.stopHealthMonitor();
		for (const info of this.tunnels.values()) {
			try {
				info.process.kill('SIGTERM');
			} catch {}
		}
		this.tunnels.clear();
	}
}
