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
	/** Track consecutive unhealthy checks per host for dead-tunnel detection */
	private unhealthyStreak: Map<string, number> = new Map();
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

		// Clean up temp files (statusFile + logFile)
		for (const tmpFile of [info.statusFile, info.logFile]) {
			try {
				await fs.unlink(tmpFile);
			} catch {}
		}

		this.tunnels.delete(hostname);
		this.unhealthyStreak.delete(hostname);
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
				// Windows: use WMIC to filter by command-line args for precise host matching.
				// Falls back to broad taskkill if WMIC is unavailable (e.g. Windows 11 Home).
				const safeHost = hostname.replace(/'/g, "''");
				await execAsync(
					`wmic process where "CommandLine like '%-host ${safeHost}%' and Name like 'srg-tunnel-client%'" call terminate`,
				).catch(async () => {
					// WMIC unavailable — try PowerShell
					await execAsync(
						`powershell -NoProfile -Command "Get-Process srg-tunnel-client* -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*-host ${safeHost}*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
					).catch(async () => {
						// Last resort: broad kill (original behavior)
						await execAsync(
							`taskkill /F /IM srg-tunnel-client-windows-amd64.exe /T`,
						).catch(() => {});
					});
				});
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

	/**
	 * Check the health status of a tunnel.
	 * Returns 'healthy' (connected), 'transitional' (reconnecting/retrying — daemon is recovering),
	 * or 'unhealthy' (error, disconnected, or unreadable).
	 */
	async checkHealth(hostname: string): Promise<'healthy' | 'transitional' | 'unhealthy'> {
		const info = this.tunnels.get(hostname);
		if (!info) return 'unhealthy';

		try {
			const content = await fs.readFile(info.statusFile, 'utf-8');
			const status = JSON.parse(content);
			if (status.state === 'connected') {
				return 'healthy';
			}
			// Daemon is actively recovering — don't trigger unhealthy alerts yet
			if (
				status.state === 'reconnecting' ||
				status.state === 'retrying' ||
				status.state === 'connecting'
			) {
				return 'transitional';
			}
			return 'unhealthy';
		} catch {
			return 'unhealthy';
		}
	}

	startHealthMonitor(
		onTunnelCountChange: (count: number) => void,
		onTunnelUnhealthy?: (hostname: string) => void,
	): void {
		this.stopHealthMonitor();

		// Consecutive unhealthy checks required before firing the callback.
		// 3 checks × 10s interval = ~30 seconds of sustained failure.
		const UNHEALTHY_THRESHOLD = 3;

		// The Go daemon natively handles process restart and SSH drops,
		// so TS side only needs to read the JSON status file.
		this.healthCheckInterval = setInterval(async () => {
			let activeCount = 0;
			for (const hostname of this.tunnels.keys()) {
				const health = await this.checkHealth(hostname);
				if (health === 'healthy') {
					activeCount++;
					// Reset streak on recovery
					if (this.unhealthyStreak.has(hostname)) {
						this.log(
							`HealthMonitor: ${hostname} recovered after ${this.unhealthyStreak.get(hostname)} unhealthy checks`,
						);
						this.unhealthyStreak.delete(hostname);
					}
				} else if (health === 'transitional') {
					// Daemon is actively recovering (reconnecting/retrying).
					// Don't count as active, but don't increment unhealthy streak either —
					// the Go daemon is handling it. Reset streak to give it time.
					this.unhealthyStreak.delete(hostname);
				} else {
					// Truly unhealthy (error state, file unreadable, etc.)
					const streak = (this.unhealthyStreak.get(hostname) ?? 0) + 1;
					this.unhealthyStreak.set(hostname, streak);
					// Fire callback exactly once when threshold is reached
					if (streak === UNHEALTHY_THRESHOLD && onTunnelUnhealthy) {
						this.log(
							`HealthMonitor: ${hostname} unhealthy for ${streak} consecutive checks, notifying...`,
						);
						onTunnelUnhealthy(hostname);
					}
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
			// Best-effort cleanup of temp files on extension shutdown
			for (const tmpFile of [info.statusFile, info.logFile]) {
				fs.unlink(tmpFile).catch(() => {});
			}
		}
		this.tunnels.clear();
	}
}
