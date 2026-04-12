import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Check if mgraftcp is currently running (i.e., Language Server is using proxy)
 */
export async function isMgraftcpRunning(): Promise<boolean> {
	try {
		const { stdout } = await execAsync('pgrep -f mgraftcp');
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

// Cache for getMonitoredProcess to avoid redundant `ps aux` calls within a short window
let processCache: { data: { pid: number; isPersistent: boolean; isUsingProxy: boolean } | null; timestamp: number } | null = null;
const PROCESS_CACHE_TTL_MS = 5000;

/** Invalidate the process cache (called after kill operations) */
function invalidateProcessCache(): void {
	processCache = null;
}

/**
 * Get monitored process (Language Server) info.
 * Returns PID and whether it's running in persistent mode.
 * Results are cached for 5 seconds to avoid redundant exec calls.
 */
export async function getMonitoredProcess(): Promise<{ pid: number; isPersistent: boolean; isUsingProxy: boolean } | null> {
	if (processCache && Date.now() - processCache.timestamp < PROCESS_CACHE_TTL_MS) {
		return processCache.data;
	}

	const result = await getMonitoredProcessUncached();
	processCache = { data: result, timestamp: Date.now() };
	return result;
}

async function getMonitoredProcessUncached(): Promise<{ pid: number; isPersistent: boolean; isUsingProxy: boolean } | null> {
	try {
		const { stdout } = await execAsync('ps aux | grep language_server_linux | grep -v grep');
		const lines = stdout.trim().split('\n').filter(l => l.length > 0);

		const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));

		for (const line of lines) {
			if (line.includes('mgraftcp-fakedns')) {
				continue;
			}
			if (line.includes('language_server_linux')) {
				const parts = line.split(/\s+/);
				if (parts.length >= 2) {
					const pid = parseInt(parts[1]);
					const isPersistent = line.includes('--persistent_mode') || line.includes('persistent_mode');
					if (!isNaN(pid)) {
						return { pid, isPersistent, isUsingProxy: hasMgraftcpWrapper };
					}
				}
			}
		}
	} catch {
		// no process found
	}
	return null;
}

/**
 * Kill monitored process (Language Server) to force restart through wrapper.
 */
export async function killTargetProcess(log: (msg: string) => void): Promise<boolean> {
	const proc = await getMonitoredProcess();
	if (!proc) {
		log('No Language Server process found to kill');
		return false;
	}

	try {
		log(`Killing Language Server process (PID: ${proc.pid}, persistent: ${proc.isPersistent})`);
		await execAsync(`kill ${proc.pid}`);
		invalidateProcessCache();

		await new Promise(resolve => setTimeout(resolve, 1000));

		const stillRunning = await getMonitoredProcess();
		if (stillRunning && stillRunning.pid === proc.pid) {
			log('Process still running, using SIGKILL');
			await execAsync(`kill -9 ${proc.pid}`);
			invalidateProcessCache();
		}

		log('Language Server process killed successfully');
		return true;
	} catch (error) {
		log(`Failed to kill Language Server: ${error}`);
		invalidateProcessCache();
		return false;
	}
}

/**
 * Show reload window prompt.
 */
export function promptReloadWindow(message: string): void {
	vscode.window.showInformationMessage(
		message,
		'Reload Now',
		'Later'
	).then(selection => {
		if (selection === 'Reload Now') {
			vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}
