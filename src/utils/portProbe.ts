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
		socket.on('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.on('timeout', () => {
			socket.destroy();
			resolve(false);
		});
		socket.on('error', () => {
			socket.destroy();
			resolve(false);
		});
		socket.connect(port, host);
	});
}

/**
 * Verify that a proxy is actually functional by performing a protocol-level
 * handshake. Much more reliable than a simple TCP port probe, which would
 * return true even if a non-proxy process occupies the port.
 *
 * Strategy:
 *   - SOCKS5: send the 3-byte greeting (ver=0x05, nMethods=1, noAuth=0x00)
 *             and expect a 2-byte response starting with 0x05.
 *   - HTTP:   send a minimal "CONNECT 0.0.0.0:0 HTTP/1.1" request and look
 *             for *any* HTTP-like response (even 4xx / 5xx means a proxy is
 *             answering).
 *   - "any":  try SOCKS5 first (fast binary handshake), fall back to HTTP.
 *
 * @returns true if the endpoint responds like a real proxy.
 */
export function isProxyFunctional(
	host: string,
	port: number,
	proxyType: 'http' | 'socks5' | 'any' = 'any',
	timeoutMs = 3000,
): Promise<boolean> {
	if (proxyType === 'any') {
		// Try SOCKS5 first (faster binary handshake), then HTTP
		return isProxyFunctional(host, port, 'socks5', timeoutMs).then((ok) =>
			ok ? true : isProxyFunctional(host, port, 'http', timeoutMs),
		);
	}

	return new Promise((resolve) => {
		const socket = new net.Socket();
		let settled = false;
		const done = (result: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			resolve(result);
		};

		socket.setTimeout(timeoutMs);
		socket.on('timeout', () => done(false));
		socket.on('error', () => done(false));
		socket.on('close', () => done(false));

		socket.connect(port, host, () => {
			if (proxyType === 'socks5') {
				// SOCKS5 greeting: VER=0x05, NMETHODS=1, METHOD=0x00 (no auth)
				socket.write(Buffer.from([0x05, 0x01, 0x00]));
			} else {
				// HTTP CONNECT to a dummy target — any HTTP response means proxy
				socket.write('CONNECT 0.0.0.0:0 HTTP/1.1\r\nHost: 0.0.0.0:0\r\n\r\n');
			}
		});

		socket.on('data', (data: Buffer) => {
			if (proxyType === 'socks5') {
				// Valid SOCKS5 response: 2 bytes, first byte is 0x05
				done(data.length >= 2 && data[0] === 0x05);
			} else {
				// Any HTTP-ish response means the proxy is alive
				const head = data.toString('utf-8', 0, Math.min(data.length, 32));
				done(head.startsWith('HTTP/'));
			}
		});
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
// eslint-disable-next-line prefer-const
export let customHomedirForTesting: string | undefined = undefined;

export async function isSrgSetupCompleted(): Promise<boolean> {
	try {
		const srgOnPath = path.join(customHomedirForTesting ?? os.homedir(), 'bin', 'srg-on');
		await fs.access(srgOnPath);
		return true; // srg-on exists → setup completed
	} catch {
		return false; // srg-on missing → not set up
	}
}
