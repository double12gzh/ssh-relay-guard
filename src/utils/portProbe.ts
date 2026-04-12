import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';

/**
 * Check if a TCP port is reachable (i.e. a service is actively listening).
 *
 * @param host      - Hostname or IP address to connect to.
 * @param port      - TCP port number.
 * @param timeoutMs - Connection timeout in milliseconds (default 2000).
 * @returns         true if the port is reachable, false otherwise.
 *
 * NOTE: "reachable" means a service is *listening* on the port.
 *       Do NOT confuse this with "port is available / free to bind".
 *       Use the name `isPortReachable` at call sites to make intent clear.
 */
export function isPortReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error',   () => { socket.destroy(); resolve(false); });
        socket.connect(port, host);
    });
}

/**
 * Returns true when the extension host is running locally
 * (not inside a Remote-SSH / SSH extension host).
 */
export function isRunningLocally(): boolean {
    return !vscode.env.remoteName;
}

/**
 * Check if SRG setup has been completed on the remote server.
 * Detects prior setup by checking for ~/bin/srg-on (deployed by setup-proxy.sh).
 * Returns true if setup was completed, false if this is a first run.
 */
export async function isSrgSetupCompleted(): Promise<boolean> {
    try {
        const srgOnPath = path.join(os.homedir(), 'bin', 'srg-on');
        await fs.access(srgOnPath);
        return true; // srg-on exists → setup completed
    } catch {
        return false; // srg-on missing → not set up
    }
}
