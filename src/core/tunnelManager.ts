import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec, execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { getSSHSocketDir } from './sshConfigManager';

export let customExecAsyncForTesting: ((cmd: string, options?: any) => Promise<{ stdout: string; stderr: string }>) | undefined = undefined;
export let customExecFileAsyncForTesting: ((file: string, args: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }>) | undefined = undefined;
export let customSpawnForTesting: typeof spawn | undefined = undefined;

const _execAsync = promisify(exec);
const execAsync = async (cmd: string, options?: any): Promise<{ stdout: string; stderr: string }> => {
	if (customExecAsyncForTesting) return customExecAsyncForTesting(cmd, options);
	const res = await _execAsync(cmd, { maxBuffer: 1024 * 1024 * 10, ...options });
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};
const _execFileAsync = promisify(execFile);
const execFileAsync = async (file: string, args: readonly string[], options?: any): Promise<{ stdout: string; stderr: string }> => {
	if (customExecFileAsyncForTesting) return customExecFileAsyncForTesting(file, args, options);
	const res = await _execFileAsync(file, args, options);
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

/**
 * Track info for a running tunnel managed by autossh (or plain ssh as fallback).
 */
interface TunnelInfo {
	hostname: string;
	localPort: number;
	remotePort: number;
	/** PID of the autossh/ssh foreground process. */
	pid: number;
	/** Reference to the child process (only if spawned by us). */
	process: ChildProcess | null;
	/** Whether we used autossh (true) or plain ssh (false). */
	usingAutossh: boolean;
	/** Timestamp when the tunnel was started. */
	startedAt: Date;
	/** Number of automatic reconnections observed. */
	reconnectCount: number;
}

/**
 * TunnelManager — Manages autossh-based SSH tunnels with automatic reconnection.
 *
 * Responsibilities:
 * - Detects whether `autossh` is available on the local machine
 * - Starts/stops autossh (or fallback ssh) tunnel processes
 * - Periodically monitors tunnel health via `ssh -O check`
 * - Automatically restarts tunnels that have died (ssh-only fallback)
 * - Tracks PIDs for clean shutdown
 */
export class TunnelManager implements vscode.Disposable {
	private tunnels: Map<string, TunnelInfo> = new Map();
	private healthCheckInterval: NodeJS.Timeout | undefined;
	private autosshAvailable: boolean | null = null; // null = not yet checked
	private log: (message: string) => void;

	/** Interval between health checks in milliseconds. */
	private static readonly HEALTH_CHECK_INTERVAL_MS = 60_000; // 60s

	constructor(log: (message: string) => void) {
		this.log = log;
	}

	// ── autossh Detection ──────────────────────────────────────────────

	/**
	 * Check if `autossh` is available in PATH.
	 * Result is cached after first check.
	 */
	async isAutosshAvailable(): Promise<boolean> {
		if (this.autosshAvailable !== null) {
			return this.autosshAvailable;
		}

		try {
			await execAsync('which autossh');
			this.autosshAvailable = true;
			this.log('TunnelManager: autossh is available');
		} catch {
			this.autosshAvailable = false;
			this.log('TunnelManager: autossh not found, will use plain ssh as fallback');
		}

		return this.autosshAvailable;
	}

	// ── Tunnel Lifecycle ───────────────────────────────────────────────

	/**
	 * Start a tunnel for the given host.
	 * Uses autossh if available, otherwise falls back to plain ssh.
	 *
	 * @returns true if tunnel was established successfully
	 */
	async startTunnel(hostname: string, localPort: number, remotePort: number): Promise<boolean> {
		const socketDir = getSSHSocketDir();
		const controlPath = `${socketDir}/%r@%h-%p`;

		// Stop any existing tunnel for this host first
		await this.stopTunnel(hostname);

		// Clean up stale socket
		await this.cleanStaleSocket(hostname);

		// Brief pause to let socket fully close
		await this.sleep(500);

		const useAutossh = await this.isAutosshAvailable();

		if (useAutossh) {
			return this.startAutosshTunnel(hostname, localPort, remotePort, controlPath);
		} else {
			return this.startSshTunnel(hostname, localPort, remotePort, controlPath);
		}
	}

	/**
	 * Start tunnel using autossh.
	 * autossh -M 0 relies on SSH's ServerAliveInterval for dead-peer detection.
	 */
	private async startAutosshTunnel(
		hostname: string,
		localPort: number,
		remotePort: number,
		controlPath: string
	): Promise<boolean> {
		this.log(`TunnelManager: starting autossh tunnel for ${hostname}`);

		const args = [
			'-M', '0', // Disable autossh's own monitoring, rely on ServerAliveInterval
			'-N',      // No remote command
			'-R', `${remotePort}:127.0.0.1:${localPort}`,
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=15',
			'-o', 'ServerAliveInterval=30',
			'-o', 'ServerAliveCountMax=3',
			'-o', 'ExitOnForwardFailure=yes',
			'-o', 'ControlMaster=auto',
			'-o', `ControlPath=${controlPath}`,
			'-o', 'ControlPersist=4h',
			hostname,
		];

		const env = {
			...process.env,
			// AUTOSSH_GATETIME=0: don't give up if initial connection fails quickly
			AUTOSSH_GATETIME: '0',
			// AUTOSSH_POLL: interval (seconds) between connection checks
			AUTOSSH_POLL: '30',
		};

		try {
			const spawnFn = customSpawnForTesting || spawn;
			const child = spawnFn('autossh', args, {
				detached: true,
				stdio: 'ignore',
				env,
			});

			child.unref(); // Allow parent to exit independently

			const pid = child.pid;
			if (!pid) {
				this.log('TunnelManager: autossh failed to spawn (no PID)');
				return false;
			}

			// Wait for connection to stabilize
			await this.sleep(2000);

			// Check if process is still alive
			try {
				process.kill(pid, 0); // Signal 0 = just check existence
			} catch {
				this.log(`TunnelManager: autossh process ${pid} exited immediately — connection failed`);
				return false;
			}

			this.tunnels.set(hostname, {
				hostname,
				localPort,
				remotePort,
				pid,
				process: child,
				usingAutossh: true,
				startedAt: new Date(),
				reconnectCount: 0,
			});

			// Verify tunnel via ControlMaster check
			const healthy = await this.checkHealth(hostname);
			if (healthy) {
				this.log(`TunnelManager: autossh tunnel for ${hostname} established (PID ${pid})`);
				return true;
			} else {
				this.log(`TunnelManager: autossh started (PID ${pid}) but tunnel not verified yet — will monitor`);
				// Still return true — autossh will retry
				return true;
			}

		} catch (error) {
			this.log(`TunnelManager: failed to start autossh: ${error}`);
			return false;
		}
	}

	/**
	 * Fallback: start tunnel using plain ssh (no auto-reconnection).
	 */
	private async startSshTunnel(
		hostname: string,
		localPort: number,
		remotePort: number,
		controlPath: string
	): Promise<boolean> {
		this.log(`TunnelManager: starting plain ssh tunnel for ${hostname} (autossh not available)`);

		const maxAttempts = 2;
		let lastError = '';

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const args = [
					'-fN',
					'-R', `${remotePort}:127.0.0.1:${localPort}`,
					'-o', 'BatchMode=yes',
					'-o', 'ConnectTimeout=15',
					'-o', 'ServerAliveInterval=30',
					'-o', 'ExitOnForwardFailure=yes',
					'-o', 'ControlMaster=auto',
					'-o', `ControlPath=${controlPath}`,
					'-o', 'ControlPersist=4h',
					hostname
				];

				await execFileAsync('ssh', args, { timeout: 20000 });

				this.log(`TunnelManager: ssh tunnel for ${hostname} established (attempt ${attempt})`);

				// Get background ssh PID via ControlMaster check
				let pid = 0;
				try {
					let out = '';
					try {
						const res = await execFileAsync('ssh', [
							'-O', 'check',
							'-o', 'BatchMode=yes',
							'-o', `ControlPath=${controlPath}`,
							hostname
						]);
						out = res.stdout + res.stderr;
					} catch (e: any) {
						out = (e.stdout || '') + (e.stderr || '');
					}
					const pidMatch = out.match(/pid=(\d+)/);
					if (pidMatch) {
						pid = parseInt(pidMatch[1], 10);
					}
				} catch { /* ignore */ }

				this.tunnels.set(hostname, {
					hostname,
					localPort,
					remotePort,
					pid,
					process: null, // forked to background
					usingAutossh: false,
					startedAt: new Date(),
					reconnectCount: 0,
				});

				return true;
			} catch (error) {
				const err = error as { message?: string };
				lastError = err.message || String(error);
				this.log(`TunnelManager: ssh attempt ${attempt} failed: ${lastError}`);

				if (attempt < maxAttempts) {
					await this.cleanStaleSocket(hostname);
					await this.sleep(1000);
				}
			}
		}

		this.log(`TunnelManager: ssh tunnel failed after ${maxAttempts} attempts: ${lastError}`);
		return false;
	}

	/**
	 * Stop the tunnel for a specific host.
	 */
	async stopTunnel(hostname: string): Promise<void> {
		const info = this.tunnels.get(hostname);
		if (!info) {
			return;
		}

		this.log(`TunnelManager: stopping tunnel for ${hostname} (PID ${info.pid})`);

		// Kill the process
		try {
			if (info.process) {
				info.process.kill('SIGTERM');
			} else if (info.pid > 0) {
				process.kill(info.pid, 'SIGTERM');
			}
		} catch {
			// Process may already be dead
		}

		// Also close ControlMaster socket
		await this.closeControlMasterSocket(hostname);

		this.tunnels.delete(hostname);
		this.log(`TunnelManager: tunnel for ${hostname} stopped`);
	}

	/**
	 * Stop all running tunnels.
	 */
	async stopAll(): Promise<void> {
		const hosts = [...this.tunnels.keys()];
		for (const host of hosts) {
			await this.stopTunnel(host);
		}
	}

	// ── Health Monitoring ──────────────────────────────────────────────

	/**
	 * Check if the tunnel for a specific host is healthy.
	 * Uses `ssh -O check` to verify the ControlMaster socket.
	 */
	async checkHealth(hostname: string): Promise<boolean> {
		const socketDir = getSSHSocketDir();
		const controlPath = `${socketDir}/%r@%h-%p`;

		try {
			let out = '';
			try {
				const res = await execFileAsync('ssh', [
					'-O', 'check',
					'-o', 'BatchMode=yes',
					'-o', `ControlPath=${controlPath}`,
					hostname
				], { timeout: 5000 });
				out = res.stdout + res.stderr;
			} catch (e: any) {
				out = (e.stdout || '') + (e.stderr || '');
			}
			return out.toLowerCase().includes('running');
		} catch {
			return false;
		}
	}

	/**
	 * Start periodic health monitoring for all tunnels.
	 * For plain-ssh tunnels: if unhealthy, attempt automatic restart.
	 * For autossh tunnels: autossh handles reconnection, we just log.
	 */
	startHealthMonitor(): void {
		this.stopHealthMonitor();

		this.log('TunnelManager: health monitor started');

		this.healthCheckInterval = setInterval(async () => {
			for (const [hostname, info] of this.tunnels.entries()) {
				const healthy = await this.checkHealth(hostname);

				if (!healthy) {
					if (info.usingAutossh) {
						// autossh handles reconnection — check if autossh itself is still alive
						let autosshAlive = false;
						try {
							process.kill(info.pid, 0);
							autosshAlive = true;
						} catch {
							autosshAlive = false;
						}

						if (autosshAlive) {
							this.log(`TunnelManager: tunnel for ${hostname} is down, autossh (PID ${info.pid}) is reconnecting...`);
						} else {
							this.log(`TunnelManager: autossh (PID ${info.pid}) for ${hostname} is dead — restarting`);
							info.reconnectCount++;
							const ok = await this.startTunnel(hostname, info.localPort, info.remotePort);
							if (ok) {
								this.log(`TunnelManager: tunnel for ${hostname} restarted (reconnect #${info.reconnectCount})`);
								vscode.window.showInformationMessage(
									`🔄 SSH tunnel to "${hostname}" was automatically reconnected.`
								);
							} else {
								this.log(`TunnelManager: failed to restart tunnel for ${hostname}`);
								vscode.window.showWarningMessage(
									`⚠️ SSH tunnel to "${hostname}" is down and could not be reconnected automatically. ` +
									`Please check your network and local proxy.`
								);
							}
						}
					} else {
						// Plain ssh — no auto-reconnect built in, we handle it
						this.log(`TunnelManager: ssh tunnel for ${hostname} is down — attempting reconnect`);
						info.reconnectCount++;
						const ok = await this.startTunnel(hostname, info.localPort, info.remotePort);
						if (ok) {
							this.log(`TunnelManager: tunnel for ${hostname} reconnected (reconnect #${info.reconnectCount})`);
							vscode.window.showInformationMessage(
								`🔄 SSH tunnel to "${hostname}" was automatically reconnected.`
							);
						} else {
							this.log(`TunnelManager: failed to reconnect tunnel for ${hostname}`);
							vscode.window.showWarningMessage(
								`⚠️ SSH tunnel to "${hostname}" is down and could not be reconnected automatically. ` +
								`Please check your network and local proxy.`
							);
						}
					}
				}
			}
		}, TunnelManager.HEALTH_CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the health monitor.
	 */
	stopHealthMonitor(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = undefined;
		}
	}

	// ── Helpers ────────────────────────────────────────────────────────

	/**
	 * Get info about a running tunnel.
	 */
	getTunnelInfo(hostname: string): TunnelInfo | undefined {
		return this.tunnels.get(hostname);
	}

	/**
	 * Get list of all managed hostnames.
	 */
	getManagedHosts(): string[] {
		return [...this.tunnels.keys()];
	}

	/**
	 * Close the ControlMaster socket for a given host.
	 * Public so that other modules can close sockets without going through stopTunnel().
	 */
	async closeControlMasterSocket(hostname: string): Promise<void> {
		const socketDir = getSSHSocketDir();

		try {
			const files = await fs.readdir(socketDir);
			const matchingFiles = files.filter(f => f.includes(hostname));

			for (const socketFile of matchingFiles) {
				const socketPath = path.join(socketDir, socketFile);
				try {
					await execFileAsync('ssh', ['-O', 'exit', '-o', `ControlPath=${socketPath}`, hostname]);
					this.log(`TunnelManager: closed ControlMaster socket: ${socketFile}`);
				} catch {
					try {
						await fs.unlink(socketPath);
						this.log(`TunnelManager: removed stale socket file: ${socketFile}`);
					} catch { /* socket may already be gone */ }
				}
			}
		} catch {
			// Socket dir doesn't exist or can't be read
		}
	}

	/**
	 * Clean up stale ControlMaster socket before starting a new tunnel.
	 */
	private async cleanStaleSocket(hostname: string): Promise<void> {
		await this.closeControlMasterSocket(hostname);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// ── Verification ───────────────────────────────────────────────────

	/**
	 * Verify a tunnel is fully functional: ControlMaster running + remote port bound.
	 * More thorough than checkHealth() — also validates RemoteForward on the remote side.
	 */
	async verifyTunnel(hostname: string, remotePort: number): Promise<{
		controlMasterRunning: boolean;
		remotePortVerified: boolean;
	}> {
		const socketDir = getSSHSocketDir();
		const controlPath = `${socketDir}/%r@%h-%p`;

		let controlMasterRunning = false;
		let remotePortVerified = false;

		try {
			let out = '';
			try {
				const res = await execFileAsync('ssh', [
					'-O', 'check',
					'-o', 'BatchMode=yes',
					'-o', `ControlPath=${controlPath}`,
					hostname
				]);
				out = res.stdout + res.stderr;
			} catch (e: any) {
				out = (e.stdout || '') + (e.stderr || '');
			}
			controlMasterRunning = out.toLowerCase().includes('running');
		} catch { /* ignore */ }

		if (controlMasterRunning) {
			try {
				const { stdout } = await execAsync(
					`ssh -o BatchMode=yes -o ControlPath="${controlPath}" ${hostname} "ss -tln 2>/dev/null | grep -q ':${remotePort}' && echo SRG_PORT_OK || echo SRG_PORT_FAIL"`,
					{ timeout: 8000 }
				);
				remotePortVerified = stdout.includes('SRG_PORT_OK');
			} catch {
				// ss not available — trust ExitOnForwardFailure
				remotePortVerified = true;
			}
		}

		return { controlMasterRunning, remotePortVerified };
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	dispose(): void {
		this.stopHealthMonitor();
		// Stop all tunnels synchronously-ish (best effort)
		for (const [, info] of this.tunnels.entries()) {
			try {
				if (info.process) {
					info.process.kill('SIGTERM');
				} else if (info.pid > 0) {
					process.kill(info.pid, 'SIGTERM');
				}
			} catch { /* ignore */ }
		}
		this.tunnels.clear();
	}
}
