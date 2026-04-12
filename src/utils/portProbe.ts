import * as net from 'net';
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
