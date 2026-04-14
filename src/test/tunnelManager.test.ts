import * as assert from 'assert';
import { EventEmitter } from 'events';
import { 
    TunnelManager, 
    customExecAsyncForTesting, 
    customExecFileAsyncForTesting, 
    customSpawnForTesting 
} from '../core/tunnelManager';

suite('TunnelManager', () => {
    let tunnelManager: TunnelManager;

    setup(() => {
        // Mock all external processes by default to prevent actual command execution
        (customExecAsyncForTesting as any) = async () => ({ stdout: '', stderr: '' });
        (customExecFileAsyncForTesting as any) = async () => ({ stdout: '', stderr: '' });
        (customSpawnForTesting as any) = () => {
            const mockChild = new EventEmitter() as any;
            mockChild.unref = () => {};
            mockChild.pid = process.pid;
            return mockChild;
        };
        
        tunnelManager = new TunnelManager((msg) => { /* mock log */ });
        // Bypass internal sleep to avoid hitting mocha timeout of 2000ms
        (tunnelManager as any).sleep = async () => {};
    });

    teardown(async () => {
        await tunnelManager.stopAll();
        tunnelManager.stopHealthMonitor();
        
        (customExecAsyncForTesting as any) = undefined;
        (customExecFileAsyncForTesting as any) = undefined;
        (customSpawnForTesting as any) = undefined;
    });

    suite('Initialization and Basic Usage', () => {
        test('should initialize with empty tunnels', () => {
            assert.strictEqual(tunnelManager.getManagedHosts().length, 0);
        });

        test('should return undefined for unknown tunnel', () => {
            assert.strictEqual(tunnelManager.getTunnelInfo('unknown-host'), undefined);
        });
    });

    suite('autossh Detection', () => {
        test('should cache and return true if autossh is available', async () => {
            (customExecAsyncForTesting as any) = async (cmd: string) => {
                if (cmd === 'which autossh') return { stdout: '/usr/bin/autossh', stderr: '' };
                return { stdout: '', stderr: '' };
            };

            const isAvailable = await tunnelManager['isAutosshAvailable']();
            assert.strictEqual(isAvailable, true);
        });

        test('should cache and return false if autossh is missing', async () => {
            (customExecAsyncForTesting as any) = async (cmd: string) => {
                if (cmd === 'which autossh') throw new Error('not found');
                return { stdout: '', stderr: '' };
            };

            const isAvailable = await tunnelManager['isAutosshAvailable']();
            assert.strictEqual(isAvailable, false);
        });
    });

    suite('Tunnel Management', () => {
        test('should successfully start a plain ssh tunnel (fallback mode)', async () => {
            // Mock autossh detection to false
            (customExecAsyncForTesting as any) = async (cmd: string) => {
                if (cmd === 'which autossh') throw new Error('not found');
                return { stdout: '', stderr: '' };
            };

            // Mock ssh tunnel spawn and health check
            (customExecFileAsyncForTesting as any) = async (file: string, args: readonly string[]) => {
                if (file === 'ssh' && args.includes('check')) {
                    return { stdout: 'pid=54321', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            };

            const started = await tunnelManager.startTunnel('testhost', 8080, 8080);
            assert.strictEqual(started, true);
            
            const info = tunnelManager.getTunnelInfo('testhost');
            assert.ok(info);
            assert.strictEqual(info?.usingAutossh, false);
            assert.strictEqual(info?.pid, 54321);
        });

        test('should successfully start an autossh tunnel', async () => {
            // Mock autossh detection to true
            (customExecAsyncForTesting as any) = async (cmd: string) => {
                if (cmd === 'which autossh') return { stdout: '/usr/bin/autossh', stderr: '' };
                return { stdout: '', stderr: '' }; // for ssh socket checks
            };

            // Mock checkHealth (it parses check)
            (customExecFileAsyncForTesting as any) = async (file: string, args: readonly string[]) => {
                if (file === 'ssh' && args.includes('check')) {
                    return { stdout: 'Master running (pid=99999)', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            };

            const started = await tunnelManager.startTunnel('autossh_host', 9000, 9000);
            assert.strictEqual(started, true);

            const info = tunnelManager.getTunnelInfo('autossh_host');
            assert.ok(info);
            assert.strictEqual(info?.usingAutossh, true);
            assert.strictEqual(info?.pid, process.pid); // Mocked via customSpawnForTesting
        });

        test('stopTunnel should kill the process and clean up sockets', async () => {
            // First mock starting a tunnel
            let customExecCalledForCleanStaleSocket = false;
            (customExecAsyncForTesting as any) = async (cmd: string) => {
                if (cmd === 'which autossh') return { stdout: '/usr/bin/autossh', stderr: '' };
                if (cmd.includes('rm -f')) customExecCalledForCleanStaleSocket = true;
                return { stdout: '', stderr: '' };
            };

            let checkHealthCalled = false;
            (customExecFileAsyncForTesting as any) = async (file: string, args: readonly string[]) => {
                if (args.includes('check')) {
                    checkHealthCalled = true;
                    return { stdout: 'Master running', stderr: '' };
                }
                // Simulate stop via ssh -O stop
                if (args.includes('stop')) {
                    return { stdout: '', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            };

            let mockChildKillCalled = false;
            (customSpawnForTesting as any) = () => {
                const mockChild = new EventEmitter() as any;
                mockChild.unref = () => {};
                mockChild.pid = process.pid;
                mockChild.kill = () => { mockChildKillCalled = true; };
                return mockChild;
            };

            await tunnelManager.startTunnel('killing_host', 8888, 8888);
            
            assert.ok(tunnelManager.getTunnelInfo('killing_host'));
            assert.strictEqual(checkHealthCalled, true);
            
            await tunnelManager.stopTunnel('killing_host');
            
            assert.strictEqual(tunnelManager.getTunnelInfo('killing_host'), undefined);
            assert.strictEqual(mockChildKillCalled, true);
        });
    });
});
