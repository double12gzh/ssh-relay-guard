import * as fs from 'fs/promises';
import { constants } from 'fs';

/**
 * Simple file-based mutual exclusion lock using atomic O_CREAT|O_EXCL.
 *
 * Used to protect concurrent read-modify-write operations on shared files
 * (e.g. ~/.ssh/config.srg) when multiple VS Code windows operate simultaneously.
 *
 * Features:
 *   - Atomic lock acquisition via O_CREAT|O_EXCL (guaranteed by OS)
 *   - PID written to lock file for debugging dead locks
 *   - Stale lock detection: if the lock-holding PID no longer exists, force-remove
 *   - Spin-wait with configurable timeout
 */

const LOCK_RETRY_INTERVAL_MS = 100;

/**
 * Check whether a process with the given PID is still alive.
 * Uses `kill(pid, 0)` which doesn't send a signal but checks existence.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Try to read the PID stored in a lock file.
 * Returns undefined if the file cannot be read or doesn't contain a valid PID.
 */
async function readLockPid(lockPath: string): Promise<number | undefined> {
	try {
		const content = await fs.readFile(lockPath, 'utf-8');
		const pid = parseInt(content.trim());
		return isNaN(pid) ? undefined : pid;
	} catch {
		return undefined;
	}
}

/**
 * Acquire a file lock, execute the callback, then release the lock.
 *
 * @param lockPath   - Path to the lock file (e.g. ~/.ssh/config.srg.lock)
 * @param fn         - Async function to execute while holding the lock
 * @param timeoutMs  - Maximum time to wait for lock acquisition (default 5000ms)
 * @returns          The return value of `fn`
 * @throws           If the lock cannot be acquired within the timeout
 */
export async function withFileLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	timeoutMs: number = 5000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	// Spin until we acquire the lock or time out
	while (true) {
		try {
			// O_CREAT|O_EXCL: atomic create — fails if file already exists
			const handle = await fs.open(
				lockPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			);
			await handle.writeFile(String(process.pid));
			await handle.close();
			break; // Lock acquired
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') {
				// Unexpected error (permissions, disk full, etc.) — don't block caller
				throw err;
			}

			// Lock file exists — check for stale lock
			const lockPid = await readLockPid(lockPath);
			if (lockPid !== undefined && !isProcessAlive(lockPid)) {
				// Holding process is dead — force remove stale lock
				try {
					await fs.unlink(lockPath);
				} catch {
					// Another process may have already cleaned it up
				}
				continue; // Retry immediately
			}

			// Lock is held by a live process — wait and retry
			if (Date.now() >= deadline) {
				throw new Error(
					`Failed to acquire file lock "${lockPath}" within ${timeoutMs}ms` +
						(lockPid ? ` (held by PID ${lockPid})` : ''),
				);
			}
			await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
		}
	}

	// Execute the callback and ensure lock is released
	try {
		return await fn();
	} finally {
		try {
			await fs.unlink(lockPath);
		} catch {
			// Lock file already removed — harmless
		}
	}
}
