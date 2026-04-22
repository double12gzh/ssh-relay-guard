import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec, execFile, spawn, ChildProcess, ExecOptions, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { getSSHSocketDir } from './sshConfigManager';

// eslint-disable-next-line prefer-const
export let customExecAsyncForTesting:
	| ((cmd: string, options?: ExecOptions) => Promise<{ stdout: string; stderr: string }>)
	| undefined = undefined;
// eslint-disable-next-line prefer-const
export let customExecFileAsyncForTesting:
	| ((
			file: string,
			args: readonly string[],
			options?: ExecFileOptions,
	  ) => Promise<{ stdout: string; stderr: string }>)
	| undefined = undefined;
// eslint-disable-next-line prefer-const
export let customSpawnForTesting: typeof spawn | undefined = undefined;

const _execAsync = promisify(exec);
const execAsync = async (
	cmd: string,
	options?: ExecOptions,
): Promise<{ stdout: string; stderr: string }> => {
	if (customExecAsyncForTesting) return customExecAsyncForTesting(cmd, options);
	const res = await _execAsync(cmd, { maxBuffer: 1024 * 1024 * 10, ...options });
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};
const _execFileAsync = promisify(execFile);
const execFileAsync = async (
	file: string,
	args: readonly string[],
	options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> => {
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
	/** Timestamp of the last reconnection attempt (used for exponential backoff). */
	lastAttempt?: Date;
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
	/** Guard against overlapping health-check intervals. */
	private healthCheckRunning = false;
	/** Counts health-check cycles so we can run deep verification periodically. */
	private healthCheckCycle = 0;

	/** Interval between health checks in milliseconds. */
	private static readonly HEALTH_CHECK_INTERVAL_MS = 60_000; // 60s
	/** Run a deep verification (verifyTunnel) every N health-check cycles. */
	private static readonly DEEP_CHECK_EVERY_N_CYCLES = 5;

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

		// Clean orphaned local autossh/ssh processes for this connection signature
		await this.cleanOrphanedProcesses(localPort, remotePort);

		// Clean remote port binding before we establish the tunnel to prevent Address already in use error
		await this.cleanRemotePort(hostname, remotePort);

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
		controlPath: string,
	): Promise<boolean> {
		this.log(`TunnelManager: starting autossh tunnel for ${hostname}`);

		const args = [
			'-M',
			'0', // Disable autossh's own monitoring, rely on ServerAliveInterval
			'-N', // No remote command
			'-R',
			`${remotePort}:127.0.0.1:${localPort}`,
			'-o',
			'BatchMode=yes',
			'-o',
			'ConnectTimeout=15',
			'-o',
			'ServerAliveInterval=30',
			'-o',
			'ServerAliveCountMax=3',
			'-o',
			'ExitOnForwardFailure=yes',
			'-o',
			'ControlMaster=auto',
			'-o',
			`ControlPath=${controlPath}`,
			'-o',
			'ControlPersist=4h',
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

			// Wait for connection to stabilize with polling (up to 15 seconds)
			let healthy = false;
			let isAlive = true;
			for (let i = 0; i < 75; i++) {
				// 75 * 200ms = 15s
				await this.sleep(200);

				try {
					process.kill(pid, 0); // Signal 0 = just check existence
				} catch {
					isAlive = false;
					break;
				}

				healthy = await this.checkHealth(hostname);
				if (healthy) {
					break;
				}
			}

			if (!isAlive) {
				this.log(
					`TunnelManager: autossh process ${pid} exited immediately — connection failed`,
				);
				return false;
			}

			if (healthy) {
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
				this.log(`TunnelManager: autossh tunnel for ${hostname} established (PID ${pid})`);
				return true;
			} else {
				this.log(
					`TunnelManager: autossh (PID ${pid}) couldn't establish tunnel within 15s — terminating`,
				);
				try {
					if (child) {
						child.kill('SIGTERM');
					} else {
						process.kill(pid, 'SIGTERM');
					}
				} catch {
					// Process may already be dead
				}
				// Also clean up lingering ControlMaster socket if any
				await this.closeControlMasterSocket(hostname);
				return false;
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
		controlPath: string,
	): Promise<boolean> {
		this.log(
			`TunnelManager: starting plain ssh tunnel for ${hostname} (autossh not available)`,
		);

		const maxAttempts = 2;
		let lastError = '';

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const args = [
					'-fN',
					'-R',
					`${remotePort}:127.0.0.1:${localPort}`,
					'-o',
					'BatchMode=yes',
					'-o',
					'ConnectTimeout=15',
					'-o',
					'ServerAliveInterval=30',
					'-o',
					'ExitOnForwardFailure=yes',
					'-o',
					'ControlMaster=auto',
					'-o',
					`ControlPath=${controlPath}`,
					'-o',
					'ControlPersist=4h',
					hostname,
				];

				await execFileAsync('ssh', args, { timeout: 20000 });

				this.log(
					`TunnelManager: ssh tunnel for ${hostname} established (attempt ${attempt})`,
				);

				// Get background ssh PID via ControlMaster check
				let pid = 0;
				try {
					let out = '';
					try {
						const res = await execFileAsync('ssh', [
							'-O',
							'check',
							'-o',
							'BatchMode=yes',
							'-o',
							`ControlPath=${controlPath}`,
							hostname,
						]);
						out = res.stdout + res.stderr;
					} catch (e: unknown) {
						const err = e as { stdout?: string; stderr?: string };
						out = (err.stdout || '') + (err.stderr || '');
					}
					const pidMatch = out.match(/pid=(\d+)/);
					if (pidMatch) {
						pid = parseInt(pidMatch[1], 10);
					}
				} catch {
					/* ignore */
				}

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
				const res = await execFileAsync(
					'ssh',
					[
						'-O',
						'check',
						'-o',
						'BatchMode=yes',
						'-o',
						`ControlPath=${controlPath}`,
						hostname,
					],
					{ timeout: 5000 },
				);
				out = res.stdout + res.stderr;
			} catch (e: unknown) {
				const err = e as { stdout?: string; stderr?: string };
				out = (err.stdout || '') + (err.stderr || '');
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
	 *
	 * Safeguards:
	 *  - Concurrency lock prevents overlapping health-check runs.
	 *  - Map is snapshot'd before iteration so restartTunnel() mutations
	 *    don't affect the in-progress loop.
	 *  - Every N cycles a deep verification (verifyTunnel) is run to
	 *    catch "ControlMaster alive but RemoteForward dead" scenarios.
	 */
	startHealthMonitor(): void {
		this.stopHealthMonitor();

		this.healthCheckCycle = 0;
		this.log('TunnelManager: health monitor started');

		this.healthCheckInterval = setInterval(async () => {
			// Guard: skip if a previous check is still running (e.g. network timeout)
			if (this.healthCheckRunning) {
				this.log('TunnelManager: health check still running, skipping this cycle');
				return;
			}
			this.healthCheckRunning = true;
			this.healthCheckCycle++;

			const isDeepCheck =
				this.healthCheckCycle % TunnelManager.DEEP_CHECK_EVERY_N_CYCLES === 0;

			try {
				// Snapshot the map so mutations inside the loop (startTunnel → stopTunnel
				// → delete + set) don't corrupt the iterator.
				const snapshot = [...this.tunnels.entries()];

				for (const [hostname, info] of snapshot) {
					// Determine health: fast check normally, deep check every N cycles
					let healthy: boolean;
					if (isDeepCheck) {
						const { controlMasterRunning, remotePortVerified } =
							await this.verifyTunnel(hostname, info.remotePort);
						healthy = controlMasterRunning && remotePortVerified;
						if (controlMasterRunning && !remotePortVerified) {
							this.log(
								`TunnelManager: deep check for ${hostname}: ControlMaster running but RemoteForward port ${info.remotePort} NOT bound on remote`,
							);
						}
					} else {
						healthy = await this.checkHealth(hostname);
					}

					if (!healthy) {
						await this.handleUnhealthyTunnel(hostname, info);
					}
				}
			} finally {
				this.healthCheckRunning = false;
			}
		}, TunnelManager.HEALTH_CHECK_INTERVAL_MS);
	}

	/**
	 * Handle an unhealthy tunnel: attempt restart for dead processes.
	 * Extracted from the health-check loop for clarity and testability.
	 *
	 * Preserves reconnectCount across restarts by reading from the old
	 * TunnelInfo and patching the newly-created one after startTunnel().
	 */
	private async handleUnhealthyTunnel(hostname: string, info: TunnelInfo): Promise<void> {
		const prevReconnectCount = info.reconnectCount;

		try {
			// Notify remote side (if extension host allows cross-communication) that we are actively reconnecting
			await vscode.commands.executeCommand(
				'ssh-relay-guard.remote.setReconnectingState',
				true,
			);
		} catch {
			// Ignore if not connected to remote workspace
		}

		// Calculate backoff if it has already failed before
		if (prevReconnectCount > 0 && info.lastAttempt) {
			// Backoff: 1 min, 2 min, 4 min, 8 min, 15 min... max 15 minutes
			const backoffMins = Math.min(15, Math.pow(2, prevReconnectCount - 1));
			const elapsedMs = Date.now() - info.lastAttempt.getTime();
			const backoffMs = backoffMins * 60 * 1000;

			if (elapsedMs < backoffMs) {
				this.log(
					`TunnelManager: backing off reconnect for ${hostname} (waiting ${backoffMins}m, next attempt in ${Math.ceil((backoffMs - elapsedMs) / 1000)}s)`,
				);
				return;
			}
		}

		if (info.usingAutossh) {
			// autossh handles reconnection — check if autossh itself is still alive
			let autosshAlive = false;
			if (info.pid > 0) {
				try {
					process.kill(info.pid, 0);
					autosshAlive = true;
				} catch {
					autosshAlive = false;
				}
			}

			if (autosshAlive) {
				this.log(
					`TunnelManager: tunnel for ${hostname} is down, autossh (PID ${info.pid}) is reconnecting...`,
				);
				return;
			}

			this.log(
				`TunnelManager: autossh (PID ${info.pid}) for ${hostname} is dead — restarting`,
			);
		} else {
			this.log(`TunnelManager: ssh tunnel for ${hostname} is down — attempting reconnect`);
		}

		const currentAttempt = new Date();
		const nextReconnectCount = prevReconnectCount + 1;
		const ok = await this.startTunnel(hostname, info.localPort, info.remotePort);

		// Preserve accumulated reconnectCount on the newly-created TunnelInfo.
		// startTunnel() resets reconnectCount to 0; we patch it back here.
		const newInfo = this.tunnels.get(hostname);
		if (newInfo) {
			newInfo.reconnectCount = nextReconnectCount;
			newInfo.lastAttempt = currentAttempt;
		} else {
			// Re-add to manage retry backoff even though the tunnel process failed to spawn/connect
			this.tunnels.set(hostname, {
				hostname: hostname,
				localPort: info.localPort,
				remotePort: info.remotePort,
				pid: 0,
				process: null,
				usingAutossh: info.usingAutossh,
				startedAt: info.startedAt,
				reconnectCount: nextReconnectCount,
				lastAttempt: currentAttempt,
			});
		}

		if (ok) {
			this.log(
				`TunnelManager: tunnel for ${hostname} restarted (reconnect #${nextReconnectCount})`,
			);

			// Reset backoff since the connection is successfully established
			const currentInfo = this.tunnels.get(hostname);
			if (currentInfo) {
				currentInfo.reconnectCount = 0;
				currentInfo.lastAttempt = undefined;
			}

			vscode.window.showInformationMessage(
				`🔄 SSH tunnel to "${hostname}" was automatically reconnected.`,
			);
		} else {
			this.log(
				`TunnelManager: failed to restart tunnel for ${hostname}. Will retry with backoff.`,
			);
			// Only show warning on the FIRST failure to avoid spamming the user
			if (nextReconnectCount === 1) {
				vscode.window.showWarningMessage(
					`⚠️ SSH tunnel to "${hostname}" is down and could not be reconnected automatically. ` +
						`Will keep trying in the background.`,
				);
			}
		}

		try {
			// Clear reconnecting state if we failed (so it shows as disconnected)
			// Or keep it? If it's backing off, it's NOT actively connecting now.
			// True, we clear the state. When backoff ends and loop runs again, it will trigger it back to true.
			await vscode.commands.executeCommand(
				'ssh-relay-guard.remote.setReconnectingState',
				false,
			);
		} catch {
			// Ignore
		}
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
			const matchingFiles = files.filter((f) => f.includes(hostname));

			for (const socketFile of matchingFiles) {
				const socketPath = path.join(socketDir, socketFile);
				try {
					await execFileAsync('ssh', [
						'-O',
						'exit',
						'-o',
						`ControlPath=${socketPath}`,
						hostname,
					]);
					this.log(`TunnelManager: closed ControlMaster socket: ${socketFile}`);
				} catch {
					try {
						await fs.unlink(socketPath);
						this.log(`TunnelManager: removed stale socket file: ${socketFile}`);
					} catch {
						/* socket may already be gone */
					}
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
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// ── Verification ───────────────────────────────────────────────────

	/**
	 * Reap any orphaned local autossh or ssh processes matching our exact port forwarding signature
	 * to prevent multiple headless agents competing for the same connection lifecycle.
	 */
	private async cleanOrphanedProcesses(localPort: number, remotePort: number): Promise<void> {
		try {
			const signature = `${remotePort}:127.0.0.1:${localPort}`;
			// pkill will return 1 if nothing matched, which goes to catch
			await execAsync(`pkill -9 -f "${signature}"`);
			this.log(`TunnelManager: Reaped orphaned local processes matching ${signature}`);
		} catch {
			/* clean */
		}
	}

	/**
	 * Clean up remote port before establishing a new tunnel to avoid 'Address already in use'.
	 * Critically: Only kills the process if it explicitly belongs to 'sshd'.
	 */
	private async cleanRemotePort(hostname: string, remotePort: number): Promise<void> {
		this.log(`TunnelManager: Checking/cleaning up remote port ${remotePort} on ${hostname}...`);
		try {
			// Find processes listening on the port. If they are sshd, kill them.
			// This avoids wildly blowing up an innocent user server that happened to overlap.
			const cmd = `ss -lptn 'sport = :${remotePort}' 2>/dev/null | grep sshd | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r kill -9 || true`;
			await execAsync(`ssh -o BatchMode=yes ${hostname} "${cmd}"`, { timeout: 10000 });
		} catch {
			// It may fail purely because there are no processes on the port.
			// That is normal, so we just log silently.
		}
	}

	/**
	 * Verify a tunnel is fully functional: ControlMaster running + remote port bound.
	 * More thorough than checkHealth() — also validates RemoteForward on the remote side.
	 */
	async verifyTunnel(
		hostname: string,
		remotePort: number,
	): Promise<{
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
					'-O',
					'check',
					'-o',
					'BatchMode=yes',
					'-o',
					`ControlPath=${controlPath}`,
					hostname,
				]);
				out = res.stdout + res.stderr;
			} catch (e: unknown) {
				const err = e as { stdout?: string; stderr?: string };
				out = (err.stdout || '') + (err.stderr || '');
			}
			controlMasterRunning = out.toLowerCase().includes('running');
		} catch {
			/* ignore */
		}

		if (controlMasterRunning) {
			try {
				// Robust remote check chain: ss -> netstat -> /proc/net/tcp (hex conversion)
				const checkCmd = `
					if ss -tln 2>/dev/null | grep -q ':${remotePort}'; then
						echo SRG_PORT_OK
					elif netstat -tln 2>/dev/null | grep -q ':${remotePort} '; then
						echo SRG_PORT_OK
					elif cat /proc/net/tcp 2>/dev/null | grep -qi ":$(printf '%04X' ${remotePort}) "; then
						echo SRG_PORT_OK
					else
						echo SRG_PORT_FAIL
					fi
				`
					.trim()
					.replace(/\n\s+/g, ' '); // Inline it safely

				const { stdout } = await execAsync(
					`ssh -o BatchMode=yes -o ControlPath="${controlPath}" ${hostname} "${checkCmd}"`,
					{ timeout: 8000 },
				);
				remotePortVerified = stdout.includes('SRG_PORT_OK');
			} catch (err) {
				// If the check command fails entirely (e.g. timeout, network drop, or severe error),
				// do NOT assume the tunnel is healthy. Return false so it can be restarted.
				this.log(`TunnelManager: deep verification command failed for ${hostname}: ${err}`);
				remotePortVerified = false;
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
			} catch {
				/* ignore */
			}
		}
		this.tunnels.clear();
	}
}
