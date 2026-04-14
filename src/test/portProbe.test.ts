import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { isPortReachable, isProxyFunctional, isRunningLocally, isSrgSetupCompleted, customHomedirForTesting } from '../utils/portProbe';

suite('portProbe Tests', () => {
    let server: net.Server;
    let port: number;

    setup(async () => {
        // Create an ephemeral server to test against
        server = net.createServer();
        await new Promise<void>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                port = (server.address() as net.AddressInfo).port;
                resolve();
            });
        });
    });

    teardown(() => {
        server.close();
    });

    suite('isPortReachable', () => {
        test('should return true for an active port', async () => {
            const reachable = await isPortReachable('127.0.0.1', port);
            assert.strictEqual(reachable, true);
        });

        test('should return false for an inactive port', async () => {
            server.close(); // Close immediately to free port
            const reachable = await isPortReachable('127.0.0.1', port, 50);
            assert.strictEqual(reachable, false);
        });
    });

    suite('isProxyFunctional', () => {
        test('should return true when server responds with valid SOCKS5 greeting', async () => {
            server.on('connection', (socket) => {
                socket.on('data', () => {
                    // Send SOCKS5 response (0x05, 0x00 for NO AUTH)
                    socket.write(Buffer.from([0x05, 0x00]));
                });
            });

            const functional = await isProxyFunctional('127.0.0.1', port, 'socks5');
            assert.strictEqual(functional, true);
        });

        test('should return false when server responds with invalid SOCKS5', async () => {
            server.on('connection', (socket) => {
                socket.on('data', () => {
                    socket.write(Buffer.from([0x04, 0x00])); // Not SOCKS5
                });
            });

            const functional = await isProxyFunctional('127.0.0.1', port, 'socks5');
            assert.strictEqual(functional, false);
        });

        test('should return true when server responds with valid HTTP proxy response', async () => {
            server.on('connection', (socket) => {
                socket.on('data', () => {
                    socket.write('HTTP/1.1 200 OK\r\n\r\n');
                });
            });

            const functional = await isProxyFunctional('127.0.0.1', port, 'http');
            assert.strictEqual(functional, true);
        });
    });

    suite('isSrgSetupCompleted', () => {
        let tmpDir: string;
        let origHome: string;

        setup(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srg-test-'));
            origHome = os.homedir();
            (customHomedirForTesting as any) = tmpDir;
        });

        teardown(async () => {
            (customHomedirForTesting as any) = undefined;
            await fs.rm(tmpDir, { recursive: true, force: true });
        });

        test('should return false when ~/bin/srg-on does not exist', async () => {
            const completed = await isSrgSetupCompleted();
            assert.strictEqual(completed, false);
        });

        test('should return true when ~/bin/srg-on exists', async () => {
            await fs.mkdir(path.join(tmpDir, 'bin'), { recursive: true });
            await fs.writeFile(path.join(tmpDir, 'bin', 'srg-on'), '', { mode: 0o755 });
            
            const completed = await isSrgSetupCompleted();
            assert.strictEqual(completed, true);
        });
    });
});
