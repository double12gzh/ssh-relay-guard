import * as vscode from 'vscode';
import { ConfigService } from '../core/configService';
import * as fs from 'fs/promises';
import { execAsync } from '../utils/processUtils';
import { isPortReachable, isProxyFunctional } from '../utils/portProbe';

export interface TrafficStats {
	activeConnections: number;
	totalConnectionsSeen: number;
	sessionStartTime: Date;
	lastUpdated: Date;
	proxyReachable: boolean;
	localReconnecting?: boolean;
}

type StatsUpdateCallback = (stats: TrafficStats) => void;

export class ConnectionMonitor {
	private stats: TrafficStats;
	private refreshInterval: NodeJS.Timeout | undefined;
	private updateCallbacks: StatsUpdateCallback[] = [];
	private peakConnections: number = 0;
	private readonly refreshIntervalMs: number = 2000;
	private wasReachable: boolean | null = null;
	private collectCycle = 0;

	constructor(private configService: ConfigService) {
		this.stats = {
			activeConnections: 0,
			totalConnectionsSeen: 0,
			sessionStartTime: new Date(),
			lastUpdated: new Date(),
			proxyReachable: false,
			localReconnecting: false,
		};
	}

	/**
	 * Check if running in remote environment
	 */
	isRemote(): boolean {
		return !!vscode.env.remoteName;
	}

	/**
	 * Start collecting traffic statistics
	 */
	start(): void {
		if (!this.isRemote()) {
			return;
		}

		this.stats.sessionStartTime = new Date();
		this.stop(); // Clear any existing interval

		// Initial collection
		this.collect();

		// Set up periodic collection
		this.refreshInterval = setInterval(() => {
			this.collect();
		}, this.refreshIntervalMs);
	}

	/**
	 * Stop collecting traffic statistics
	 */
	stop(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
	}

	/**
	 * Pause monitoring when WebView panel is hidden.
	 * Eliminates CPU/IO overhead while the panel is invisible.
	 */
	pause(): void {
		this.stop();
	}

	/**
	 * Resume monitoring when WebView panel becomes visible again.
	 * Immediately collects fresh data before restarting the interval.
	 */
	resume(): void {
		if (!this.refreshInterval && this.isRemote()) {
			this.collect();
			this.refreshInterval = setInterval(() => {
				this.collect();
			}, this.refreshIntervalMs);
		}
	}

	/**
	 * Register a callback for stats updates
	 */
	onUpdate(callback: StatsUpdateCallback): vscode.Disposable {
		this.updateCallbacks.push(callback);
		return new vscode.Disposable(() => {
			const index = this.updateCallbacks.indexOf(callback);
			if (index >= 0) {
				this.updateCallbacks.splice(index, 1);
			}
		});
	}

	/**
	 * Get current statistics
	 */
	getStats(): TrafficStats {
		return { ...this.stats };
	}

	/**
	 * Manually trigger a stats refresh
	 */
	async refresh(): Promise<TrafficStats> {
		await this.collect();
		return this.getStats();
	}

	/**
	 * Allows the local extension to notify the remote side that it is actively trying to reconnect the tunnel.
	 */
	setLocalReconnectionState(reconnecting: boolean): void {
		if (this.stats.localReconnecting !== reconnecting) {
			this.stats.localReconnecting = reconnecting;
			// Notify listeners immediately
			for (const callback of this.updateCallbacks) {
				callback(this.getStats());
			}
		}
	}

	/**
	 * Collect traffic statistics
	 */
	private async collect(): Promise<void> {
		const remoteProxyHost = this.configService.remoteProxyHost;
		const remoteProxyPort = this.configService.remoteProxyPort;

		this.collectCycle++;

		// Deep protocol check every 5th cycle (10 seconds), otherwise just fast port reachability
		let isReachable = false;
		if (this.collectCycle % 5 === 0) {
			const proxyType = this.configService.proxyType as 'http' | 'socks5' | 'any';
			isReachable = await isProxyFunctional(
				remoteProxyHost,
				remoteProxyPort,
				proxyType,
				1500,
			);
		} else {
			isReachable = await isPortReachable(remoteProxyHost, remoteProxyPort, 1500);
		}

		this.stats.proxyReachable = isReachable;

		// Notify user if tunnel transitions from working to disconnected
		if (this.wasReachable === true && !isReachable) {
			vscode.window
				.showWarningMessage(
					`⚠️ 代理隧道断开！无法连接到 ${remoteProxyHost}:${remoteProxyPort}`,
					'打开控制面板',
					'运行健康检查',
				)
				.then((action) => {
					if (action === '打开控制面板') {
						vscode.commands.executeCommand('ssh-relay-guard.showStatusPanel');
					} else if (action === '运行健康检查') {
						vscode.commands.executeCommand('ssh-relay-guard.diagnose');
					}
				});
		}
		this.wasReachable = isReachable;

		// Get active connections using ss command
		const activeConnections = await this.getActiveConnections(remoteProxyPort);

		// Track total connections seen.
		// Only count upward deltas: new connections being established.
		// Downward deltas (connections closing) are NOT new connections,
		// so we only update the peak reference without adding to the total.
		if (activeConnections > this.peakConnections) {
			this.stats.totalConnectionsSeen += activeConnections - this.peakConnections;
			this.peakConnections = activeConnections;
		} else if (activeConnections < this.peakConnections) {
			// Connections closed — update baseline but don't double-count
			this.peakConnections = activeConnections;
		}

		this.stats.activeConnections = activeConnections;
		this.stats.lastUpdated = new Date();

		// Notify callbacks
		for (const callback of this.updateCallbacks) {
			callback(this.getStats());
		}
	}

	/**
	 * Get active connection count by reading /proc/net/tcp directly.
	 * ~100x faster than exec('ss'): 1-5ms vs 50-200ms per call.
	 * Falls back to exec('ss') on non-Linux platforms.
	 */
	private async getActiveConnections(port: number): Promise<number> {
		try {
			return await this.getActiveConnectionsFromProc(port);
		} catch {
			// /proc/net/tcp not available (non-Linux), fall back to ss
			return await this.getActiveConnectionsFromSs(port);
		}
	}

	/**
	 * Parse /proc/net/tcp and /proc/net/tcp6 to count ESTABLISHED connections.
	 * Format: sl  local_address  rem_address  st  ...
	 * State 01 = ESTABLISHED
	 */
	private async getActiveConnectionsFromProc(port: number): Promise<number> {
		const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
		let count = 0;

		for (const procFile of ['/proc/net/tcp', '/proc/net/tcp6']) {
			try {
				const data = await fs.readFile(procFile, 'utf-8');
				const lines = data.split('\n');
				// Skip header line (index 0)
				for (let i = 1; i < lines.length; i++) {
					const line = lines[i].trim();
					if (!line) {
						continue;
					}
					// Fields: sl local_address rem_address st ...
					// local_address and rem_address are in format ADDR:PORT (hex)
					const fields = line.split(/\s+/);
					if (fields.length < 4) {
						continue;
					}
					const st = fields[3]; // Connection state
					if (st !== '01') {
						continue;
					} // Only ESTABLISHED
					const localPort = fields[1].split(':').pop() ?? '';
					const remotePort = fields[2].split(':').pop() ?? '';
					if (localPort === hexPort || remotePort === hexPort) {
						count++;
					}
				}
			} catch {
				// File doesn't exist (e.g., no IPv6), skip
			}
		}
		return count;
	}

	/**
	 * Fallback: use ss command for non-Linux platforms.
	 */
	private async getActiveConnectionsFromSs(port: number): Promise<number> {
		try {
			const { stdout } = await execAsync(
				`ss -tn state established '( dport = :${port} or sport = :${port} )' 2>/dev/null | tail -n +2 | wc -l`,
				{ timeout: 5000 },
			);
			const count = parseInt(stdout.trim(), 10);
			return isNaN(count) ? 0 : count;
		} catch {
			return 0;
		}
	}

	/**
	 * Get session duration in human-readable format
	 */
	getSessionDuration(): string {
		const now = new Date();
		const diffMs = now.getTime() - this.stats.sessionStartTime.getTime();
		const diffSec = Math.floor(diffMs / 1000);

		const hours = Math.floor(diffSec / 3600);
		const minutes = Math.floor((diffSec % 3600) / 60);
		const seconds = diffSec % 60;

		return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
	}

	dispose(): void {
		this.stop();
		this.updateCallbacks = [];
	}
}
