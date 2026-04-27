import * as vscode from 'vscode';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';

// Test hook
// eslint-disable-next-line prefer-const
export let customExecAsyncForTesting:
	| ((cmd: string, options?: ExecOptions) => Promise<{ stdout: string; stderr: string }>)
	| undefined = undefined;

const _execAsync = promisify(exec);
export const execAsync = async (
	cmd: string,
	options?: ExecOptions,
): Promise<{ stdout: string; stderr: string }> => {
	if (customExecAsyncForTesting) return customExecAsyncForTesting(cmd, options);
	const res = await _execAsync(cmd, { maxBuffer: 1024 * 1024 * 10, ...options });
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

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
let processCache: {
	data: { pid: number; isPersistent: boolean; isUsingProxy: boolean } | null;
	timestamp: number;
} | null = null;
const PROCESS_CACHE_TTL_MS = 5000;

/** Invalidate the process cache (called after kill operations) */
export function invalidateProcessCache(): void {
	processCache = null;
}

/**
 * Get monitored process (Language Server) info.
 * Returns PID and whether it's running in persistent mode.
 * Results are cached for 5 seconds to avoid redundant exec calls.
 */
export async function getMonitoredProcess(): Promise<{
	pid: number;
	isPersistent: boolean;
	isUsingProxy: boolean;
} | null> {
	if (processCache && Date.now() - processCache.timestamp < PROCESS_CACHE_TTL_MS) {
		return processCache.data;
	}

	const result = await getMonitoredProcessUncached();
	processCache = { data: result, timestamp: Date.now() };
	return result;
}

/**
 * Walk the PPID chain of `candidatePid` upward (max `maxDepth` levels)
 * and return true if `ancestorPid` is found along the way.
 * This confirms the candidate process belongs to the current VS Code
 * Server's process tree.
 */
async function isDescendantOf(
	candidatePid: number,
	ancestorPid: number,
	maxDepth: number = 10,
): Promise<boolean> {
	let currentPid = candidatePid;
	for (let i = 0; i < maxDepth; i++) {
		try {
			const { stdout } = await execAsync(
				`ps -o ppid= -p ${currentPid} 2>/dev/null | tr -d ' '`,
			);
			const ppid = parseInt(stdout.trim());
			if (isNaN(ppid) || ppid <= 1) {
				return false; // Reached init/systemd — not a descendant
			}
			if (ppid === ancestorPid) {
				return true;
			}
			currentPid = ppid;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Check whether a candidate process's cwd contains the given server
 * directory prefix. Uses /proc/<pid>/cwd (Linux-specific) to read
 * the working directory without needing elevated permissions.
 *
 * @param serverDirPrefix - e.g. "/home/user/.antigravity-server"
 */
async function matchesCwd(candidatePid: number, serverDirPrefix: string): Promise<boolean> {
	try {
		const { stdout } = await execAsync(`readlink /proc/${candidatePid}/cwd 2>/dev/null`);
		const cwd = stdout.trim();
		return cwd.length > 0 && cwd.startsWith(serverDirPrefix);
	} catch {
		return false;
	}
}

/**
 * Derive the IDE server root directory from __dirname.
 * e.g. "~/.antigravity-server/extensions/srg-1.0.0/dist" → "~/.antigravity-server"
 * Returns null if the path doesn't match the expected pattern.
 */
function deriveServerDirPrefix(): string | null {
	const extIdx = __dirname.indexOf('/extensions/');
	if (extIdx > 0) {
		return __dirname.substring(0, extIdx);
	}
	return null;
}

/**
 * Count how many VS Code Server instances are running under the same
 * server root (e.g. ~/.antigravity-server). Used to decide if killing
 * a persistent LS would affect sibling windows.
 */
export async function countSiblingServerInstances(): Promise<number> {
	const serverDirPrefix = deriveServerDirPrefix();
	if (!serverDirPrefix) {
		return 1;
	}

	try {
		// Count unique PIDs whose cwd is under the server root
		const { stdout } = await execAsync(
			`ls -d /proc/*/cwd 2>/dev/null | xargs -I{} readlink {} 2>/dev/null | grep "^${serverDirPrefix}" | wc -l`,
		);
		const count = parseInt(stdout.trim());
		return isNaN(count) ? 1 : Math.max(1, count);
	} catch {
		return 1;
	}
}

/** Parsed candidate from ps aux output */
interface LSCandidate {
	pid: number;
	isPersistent: boolean;
	line: string;
}

async function getMonitoredProcessUncached(): Promise<{
	pid: number;
	isPersistent: boolean;
	isUsingProxy: boolean;
} | null> {
	try {
		// ── Multi-user isolation ──────────────────────────────────────
		// Use process tree filtering to find only LS processes belonging
		// to THIS VS Code Server instance. Falls back to global search
		// with PPID / cwd secondary filtering for safety.
		let stdout: string;
		let usedFallback = false;
		try {
			// Find LS processes descended from our server's process group
			const serverPid = process.ppid;
			const { stdout: pgrepOut } = await execAsync(
				`pgrep -a -g $(ps -o pgid= -p ${serverPid} | tr -d ' ') language_server_linux 2>/dev/null`,
			);
			stdout = pgrepOut;
		} catch {
			// Fallback: global search (single-user or pgrep unavailable)
			const { stdout: fallbackOut } = await execAsync(
				'ps aux | grep language_server_linux | grep -v grep',
			);
			stdout = fallbackOut;
			usedFallback = true;
		}
		const lines = stdout
			.trim()
			.split('\n')
			.filter((l) => l.length > 0);

		const hasMgraftcpWrapper = lines.some((line) => line.includes('mgraftcp'));

		// Parse all candidate LS processes
		const candidates: LSCandidate[] = [];
		for (const line of lines) {
			if (line.includes('mgraftcp-fakedns')) {
				continue;
			}
			if (line.includes('language_server_linux')) {
				const parts = line.split(/\s+/);
				if (parts.length >= 2) {
					const pid = parseInt(parts[1]);
					const isPersistent =
						line.includes('--persistent_mode') || line.includes('persistent_mode');
					if (!isNaN(pid)) {
						candidates.push({ pid, isPersistent, line });
					}
				}
			}
		}

		if (candidates.length === 0) {
			return null;
		}

		// ── Primary path (pgrep succeeded): trust the first candidate ──
		if (!usedFallback) {
			const c = candidates[0];
			return { pid: c.pid, isPersistent: c.isPersistent, isUsingProxy: hasMgraftcpWrapper };
		}

		// ── Fallback path: apply secondary filtering for safety ────────
		const serverPid = process.ppid;

		// Strategy 1: PPID chain — check if any candidate descends from our server
		for (const c of candidates) {
			if (await isDescendantOf(c.pid, serverPid)) {
				return {
					pid: c.pid,
					isPersistent: c.isPersistent,
					isUsingProxy: hasMgraftcpWrapper,
				};
			}
		}

		// Strategy 2: cwd match — check if candidate's cwd is under our server dir
		const serverDirPrefix = deriveServerDirPrefix();
		if (serverDirPrefix) {
			for (const c of candidates) {
				if (await matchesCwd(c.pid, serverDirPrefix)) {
					return {
						pid: c.pid,
						isPersistent: c.isPersistent,
						isUsingProxy: hasMgraftcpWrapper,
					};
				}
			}
		}

		// Strategy 3: Safe degradation
		// Single candidate on the system — likely single-user, use it directly
		if (candidates.length === 1) {
			const c = candidates[0];
			return { pid: c.pid, isPersistent: c.isPersistent, isUsingProxy: hasMgraftcpWrapper };
		}

		// Multiple candidates but none matched our session — refuse to guess
		return null;
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

	// Multi-window safety: warn if killing a persistent LS shared by multiple sessions
	if (proc.isPersistent) {
		const siblingCount = await countSiblingServerInstances();
		if (siblingCount > 1) {
			log(
				`WARNING: ${siblingCount} server instances detected. Killing persistent LS (PID ${proc.pid}) will affect all windows.`,
			);
		}
	}

	try {
		log(`Killing Language Server process (PID: ${proc.pid}, persistent: ${proc.isPersistent})`);
		await execAsync(`kill ${proc.pid}`);
		invalidateProcessCache();

		await new Promise((resolve) => setTimeout(resolve, 1000));

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
	vscode.window.showInformationMessage(message, 'Reload Now', 'Later').then((selection) => {
		if (selection === 'Reload Now') {
			vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}
