import * as vscode from 'vscode';
import { runDiagnostics, DiagnosticReport, generateReportText } from '../diagnostics/healthChecker';
import { ConnectionMonitor, TrafficStats } from '../traffic/connectionMonitor';
import { ConfigService } from '../core/configService';
import { isPortReachable, isSrgSetupCompleted } from '../utils/portProbe';
import { dict, Lang } from './translations';
import { buildPanelHtml, buildTrafficHtml, PanelContext, resolveStatusAppearance } from './panelRenderer';

export interface ProxyStatus {
    runningLocation: 'local' | 'remote';
    sshConfigEnabled: boolean;
    localProxyPort: number;
    remoteProxyPort: number;
    remoteProxyHost: string;
    localProxyReachable: boolean;
    remoteProxyReachable: boolean;
    lastUpdated: Date;
    languageServerConfigured?: boolean;
    remoteSetupCompleted?: boolean;
    /** Whether any host has been configured locally (config.srg has entries) */
    hasConfiguredHosts?: boolean;
    /** List of configured host names from config.srg */
    configuredHosts?: string[];
}

type StatusUpdateCallback = (status: ProxyStatus) => void;
type ConfigChangeCallback = () => Promise<void>;

const REFRESH_INTERVAL_SEC = 30;


export class DashboardManager {
    private statusBarItem: vscode.StatusBarItem;
    private currentStatus: ProxyStatus;
    private updateCallbacks: StatusUpdateCallback[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private statusPanel: vscode.WebviewPanel | undefined;
    private countdownInterval: NodeJS.Timeout | undefined;
    private secondsUntilRefresh: number = REFRESH_INTERVAL_SEC;
    private onConfigChange: ConfigChangeCallback | undefined;

    // New properties for unified dashboard
    private connectionMonitor: ConnectionMonitor;
    private currentDiagnosticReport: DiagnosticReport | null = null;
    private isRunningDiagnostics: boolean = false;
    private isVerifying: boolean = false;
    private currentLang: Lang = 'zh';

    constructor(private isLocal: boolean, private context: vscode.ExtensionContext, private configService: ConfigService) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            -100
        );
        this.statusBarItem.command = 'ssh-relay-guard.showStatusPanel';
        this.statusBarItem.name = 'SRG';

        this.currentStatus = {
            runningLocation: isLocal ? 'local' : 'remote',
            sshConfigEnabled: false,
            localProxyPort: configService.localProxyPort,
            remoteProxyPort: configService.remoteProxyPort,
            remoteProxyHost: configService.remoteProxyHost,
            localProxyReachable: false,
            remoteProxyReachable: false,
            lastUpdated: new Date(),
        };

        // Initialize connection monitor
        this.connectionMonitor = new ConnectionMonitor(configService);

        // Load saved language preference (default to Chinese)
        this.currentLang = this.context.globalState.get<Lang>('uiLanguage', 'zh');

        this.updateStatusBar();
        this.statusBarItem.show();
    }

    /**
     * Set the verifying state — when true, status bar shows spinning icon.
     * Used during startup full-connectivity checks to prevent premature green.
     */
    setVerifying(verifying: boolean): void {
        this.isVerifying = verifying;
        this.updateStatusBar();
    }

    /**
     * Set config change callback for SSH config updates
     */
    setConfigChangeCallback(callback: ConfigChangeCallback): void {
        this.onConfigChange = callback;
    }

    onStatusUpdate(callback: StatusUpdateCallback): vscode.Disposable {
        this.updateCallbacks.push(callback);
        return new vscode.Disposable(() => {
            const index = this.updateCallbacks.indexOf(callback);
            if (index >= 0) {
                this.updateCallbacks.splice(index, 1);
            }
        });
    }

    startAutoRefresh(): void {
        this.stopAutoRefresh();
        this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;

        this.refreshInterval = setInterval(() => {
            this.refreshStatus();
            this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        }, REFRESH_INTERVAL_SEC * 1000);

        this.countdownInterval = setInterval(() => {
            this.secondsUntilRefresh = Math.max(0, this.secondsUntilRefresh - 1);
            this.updatePanelCountdown();
        }, 1000);

        this.refreshStatus();
    }

    stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    async refreshStatus(): Promise<void> {
        this.currentStatus.localProxyPort = this.configService.localProxyPort;
        this.currentStatus.remoteProxyPort = this.configService.remoteProxyPort;
        this.currentStatus.remoteProxyHost = this.configService.remoteProxyHost;

        if (this.isLocal) {
            this.currentStatus.localProxyReachable = await isPortReachable(
                '127.0.0.1',
                this.currentStatus.localProxyPort
            );
        } else {
            const [reachable, setupDone] = await Promise.all([
                isPortReachable(
                    this.currentStatus.remoteProxyHost,
                    this.currentStatus.remoteProxyPort
                ),
                isSrgSetupCompleted(),
            ]);
            this.currentStatus.remoteProxyReachable = reachable;
            this.currentStatus.remoteSetupCompleted = setupDone;
        }

        this.currentStatus.lastUpdated = new Date();
        this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    updateSSHConfigStatus(enabled: boolean, port?: number, hosts?: string[]): void {
        this.currentStatus.sshConfigEnabled = enabled;
        if (port !== undefined) {
            this.currentStatus.remoteProxyPort = port;
        }
        this.currentStatus.hasConfiguredHosts = (hosts !== undefined && hosts.length > 0) || enabled;
        this.currentStatus.configuredHosts = hosts;
        this.currentStatus.lastUpdated = new Date();
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    updateLanguageServerStatus(configured: boolean): void {
        this.currentStatus.languageServerConfigured = configured;
        this.currentStatus.lastUpdated = new Date();
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    getStatus(): ProxyStatus {
        return { ...this.currentStatus };
    }

    showStatusPanel(): void {
        if (this.statusPanel) {
            this.statusPanel.reveal();
            return;
        }

        this.statusPanel = vscode.window.createWebviewPanel(
            'srgStatus',
            'SSH Relay Guard',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Start connection monitor when panel opens (remote only)
        if (!this.isLocal) {
            this.connectionMonitor.start();
            this.connectionMonitor.onUpdate(() => {
                this.updatePanelIfOpen();
            });
        }

        this.statusPanel.webview.html = this.getPanelHtml();

        this.statusPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this.refreshStatus();
                        if (!this.isLocal) {
                            await this.connectionMonitor.refresh();
                        }
                        // refreshStatus already calls updatePanelIfOpen — no full rebuild needed
                        break;
                    case 'saveConfig':
                        await this.saveConfig(message.config);
                        // saveConfig calls refreshStatus → updatePanelIfOpen — no full rebuild needed
                        break;
                    case 'runDiagnostics':
                        await this.runInlineDiagnostics();
                        break;
                    case 'copyReport':
                        await this.copyDiagnosticReport();
                        break;
                    case 'setLanguage':
                        this.currentLang = message.lang as Lang;
                        await this.context.globalState.update('uiLanguage', this.currentLang);
                        // Language change requires full rerender for all translated strings
                        this.forceRenderPanel();
                        break;
                    case 'closeRemote': {
                        // Detect hostname: try env.remoteName, fall back to extension host env
                        let hostname = 'your-host';
                        const remoteName = vscode.env.remoteName;
                        if (remoteName && remoteName !== 'ssh-remote') {
                            hostname = remoteName;
                        } else {
                            // Try parsing from environment
                            const sshConn = process.env['SSH_CONNECTION'];
                            if (sshConn) {
                                // SSH_CONNECTION format: "client_ip client_port server_ip server_port"
                                // We need the hostname from config, not IP. Try hostname command.
                                try {
                                    const { execSync } = require('child_process');
                                    hostname = String(execSync('hostname -s 2>/dev/null || hostname', { timeout: 2000 })).trim();
                                } catch { /* keep default */ }
                            }
                        }
                        const cleanupCmd = `ssh -O exit ${hostname}`;
                        const port = this.configService.remoteProxyPort;
                        const tunnelCmd = `ssh -fN -R ${port}:127.0.0.1:${port} ${hostname}`;

                        const action = await vscode.window.showWarningMessage(
                            `This will close the remote VS Code window.\n\n` +
                            `⚠️ The SSH tunnel (ControlMaster) may persist on the local machine.\n` +
                            `To fully close the tunnel, run on LOCAL terminal:\n` +
                            `  ${cleanupCmd}\n\n` +
                            `To manually establish the tunnel later:\n` +
                            `  ${tunnelCmd}`,
                            { modal: true },
                            'Close & Copy Commands',
                            'Just Close',
                            'Cancel'
                        );

                        if (action === 'Cancel' || !action) { break; }

                        if (action === 'Close & Copy Commands') {
                            const clipboardText = `# 1. Close existing tunnel\n${cleanupCmd}\n\n# 2. Establish new background static tunnel\n${tunnelCmd}`;
                            await vscode.env.clipboard.writeText(clipboardText);
                            vscode.window.showInformationMessage(
                                `Copied manual commands to clipboard. Paste in local terminal to manage the tunnel manually.`
                            );
                            // Brief delay so user can see the message
                            await new Promise(r => setTimeout(r, 1500));
                        }

                        vscode.commands.executeCommand('workbench.action.remote.close');
                        break;
                    }
                    case 'rollback':
                        vscode.commands.executeCommand('ssh-relay-guard.rollback');
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        this.statusPanel.onDidDispose(() => {
            this.statusPanel = undefined;
            if (!this.isLocal) {
                this.connectionMonitor.stop();
            }
        });

        // Smart throttling: pause monitor when panel is hidden, resume when visible
        this.statusPanel.onDidChangeViewState(e => {
            if (!this.isLocal) {
                if (e.webviewPanel.visible) {
                    this.connectionMonitor.resume();
                } else {
                    this.connectionMonitor.pause();
                }
            }
        });
    }

    /**
     * Run diagnostics inline and update panel
     */
    private async runInlineDiagnostics(): Promise<void> {
        if (this.isRunningDiagnostics) {
            return;
        }

        this.isRunningDiagnostics = true;
        // Full rerender to show "running..." button state (user-triggered)
        this.forceRenderPanel();

        try {
            this.currentDiagnosticReport = await runDiagnostics(this.configService, (checks) => {
                // Update panel with progress
                if (this.statusPanel) {
                    this.statusPanel.webview.postMessage({
                        command: 'diagnosticProgress',
                        checks: checks
                    });
                }
            }, this.context.extensionUri.fsPath);
        } finally {
            this.isRunningDiagnostics = false;
            // Full rerender to show diagnostic results
            this.forceRenderPanel();
        }
    }

    /**
     * Copy diagnostic report to clipboard
     */
    private async copyDiagnosticReport(): Promise<void> {
        if (this.currentDiagnosticReport) {
            const text = generateReportText(this.currentDiagnosticReport);
            await vscode.env.clipboard.writeText(text);
            const t = dict[this.currentLang];
            vscode.window.showInformationMessage(t.reportCopied);
        }
    }

    /**
     * Save configuration
     */
    private async saveConfig(newConfig: {
        localProxyPort?: number;
        remoteProxyPort?: number;
        remoteProxyHost?: string;
        enableLocalForwarding?: boolean;
        proxyType?: string;
    }): Promise<void> {
        const oldProxyType = this.configService.proxyType;
        const t = dict[this.currentLang];
        // ConfigService is the read cache; writes go through VS Code API
        const config = vscode.workspace.getConfiguration('ssh-relay-guard');

        try {
            if (newConfig.localProxyPort !== undefined) {
                await config.update('localProxyPort', newConfig.localProxyPort, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.remoteProxyPort !== undefined) {
                await config.update('remoteProxyPort', newConfig.remoteProxyPort, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.remoteProxyHost !== undefined) {
                await config.update('remoteProxyHost', newConfig.remoteProxyHost, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.enableLocalForwarding !== undefined) {
                await config.update('enableLocalForwarding', newConfig.enableLocalForwarding, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.proxyType !== undefined) {
                await config.update('proxyType', newConfig.proxyType, vscode.ConfigurationTarget.Global);
            }

            // Trigger config change callback
            if (this.onConfigChange) {
                await this.onConfigChange();
            }

            await this.refreshStatus();

            // If proxyType changed, prompt for reload
            if (newConfig.proxyType !== undefined && newConfig.proxyType !== oldProxyType) {
                const reloadMsg = this.currentLang === 'zh'
                    ? `代理类型已更改为 ${newConfig.proxyType.toUpperCase()}。请重新加载窗口以应用更改。`
                    : `Proxy type changed to ${newConfig.proxyType.toUpperCase()}. Please reload window to apply changes.`;
                const reloadNow = this.currentLang === 'zh' ? '立即重载' : 'Reload Now';
                const later = this.currentLang === 'zh' ? '稍后' : 'Later';

                vscode.window.showInformationMessage(reloadMsg, reloadNow, later).then(selection => {
                    if (selection === reloadNow) {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else {
                vscode.window.showInformationMessage(t.configSaved);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save config: ${error}`);
        }
    }

    private updatePanelIfOpen(): void {
        if (!this.statusPanel) { return; }

        const status = this.currentStatus;
        const isLocal = status.runningLocation === 'local';
        const t = dict[this.currentLang];
        const trafficStats = this.connectionMonitor.getStats();
        const { color: statusColor, text: statusText } = resolveStatusAppearance(status, t);

        this.statusPanel.webview.postMessage({
            command: 'updateStatus',
            statusColor,
            statusText,
            sshConfigEnabled: status.sshConfigEnabled,
            localProxyReachable: status.localProxyReachable,
            remoteProxyReachable: status.remoteProxyReachable,
            remoteProxyHost: status.remoteProxyHost,
            languageServerConfigured: status.languageServerConfigured,
            lastUpdated: status.lastUpdated.toLocaleTimeString(),
            trafficHtml: this.generateTrafficHtml(t, trafficStats, isLocal),
            t: {
                on: t.on, off: t.off,
                reachable: t.reachable, unreachable: t.unreachable,
                configured: t.configured, notConfigured: t.notConfigured,
                updated: t.updated,
            }
        });
    }

    private forceRenderPanel(): void {
        if (this.statusPanel) {
            this.statusPanel.webview.html = this.getPanelHtml();
        }
    }

    private updatePanelCountdown(): void {
        if (this.statusPanel) {
            this.statusPanel.webview.postMessage({
                command: 'updateCountdown',
                seconds: this.secondsUntilRefresh
            });
        }
    }

    private updateStatusBar(): void {
        // During startup verification: show spinning icon, don't resolve final status
        if (this.isVerifying) {
            this.statusBarItem.text = '$(sync~spin) SRG';
            this.statusBarItem.color = '#fbbf24';
            this.statusBarItem.tooltip = this.currentLang === 'zh'
                ? 'SSH Relay Guard (SRG)\n🔄 正在检查连接...'
                : 'SSH Relay Guard (SRG)\n🔄 Checking connectivity...';
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        const status = this.currentStatus;
        const t = dict[this.currentLang];
        const { color } = resolveStatusAppearance(status, t);
        this.statusBarItem.color = color;

        let tooltip: string;
        if (this.isLocal) {
            if (status.sshConfigEnabled && status.localProxyReachable) {
                tooltip = 'SSH Relay Guard (SRG)\n✅ Connected';
            } else if (status.sshConfigEnabled) {
                tooltip = 'SSH Relay Guard (SRG)\n⚠️ SSH configured, proxy unreachable';
            } else if (status.hasConfiguredHosts === false) {
                tooltip = this.currentLang === 'zh'
                    ? 'SSH Relay Guard (SRG)\n⚠️ 未配置主机\n\n运行「Add Host Forwarding」添加远程主机'
                    : 'SSH Relay Guard (SRG)\n⚠️ No hosts configured\n\nRun "Add Host Forwarding" to add a remote host';
            } else {
                tooltip = 'SSH Relay Guard (SRG)\n❌ Disconnected';
            }
        } else {
            if (status.remoteSetupCompleted === false) {
                tooltip = this.currentLang === 'zh'
                    ? 'SSH Relay Guard (SRG)\n⚠️ 隧道未建立\n\n① 在本地安装 SRG 插件\n② 本地运行「Add Host Forwarding」\n③ 重新连接此服务器'
                    : 'SSH Relay Guard (SRG)\n⚠️ Tunnel not established\n\n① Install SRG on your LOCAL machine\n② Run \"Add Host Forwarding\" locally\n③ Reconnect to this server';
            } else {
                tooltip = status.remoteProxyReachable
                    ? 'SSH Relay Guard (SRG)\n✅ Proxy OK'
                    : 'SSH Relay Guard (SRG)\n❌ Proxy unreachable';
            }
        }

        this.statusBarItem.text = '$(shield) SRG';
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.backgroundColor = undefined;
    }

    private notifyCallbacks(): void {
        const status = this.getStatus();
        for (const callback of this.updateCallbacks) {
            callback(status);
        }
    }


    private buildPanelContext(): PanelContext {
        const t = dict[this.currentLang];
        return {
            status: this.currentStatus,
            t,
            currentLang: this.currentLang,
            enableForwarding: this.configService.enableLocalForwarding,
            proxyType:        this.configService.proxyType,
            diagnosticReport: this.currentDiagnosticReport,
            isRunningDiagnostics: this.isRunningDiagnostics,
            trafficStats:    this.connectionMonitor.getStats(),
            sessionDuration: this.connectionMonitor.getSessionDuration(),
            secondsUntilRefresh: this.secondsUntilRefresh,
        };
    }

    private getPanelHtml(): string {
        return buildPanelHtml(this.buildPanelContext());
    }

    private generateTrafficHtml(t: typeof dict.zh, stats: TrafficStats, isLocal: boolean): string {
        return buildTrafficHtml(
            { t, trafficStats: stats, sessionDuration: this.connectionMonitor.getSessionDuration(), status: this.currentStatus },
            isLocal
        );
    }

    dispose(): void {
        this.stopAutoRefresh();
        this.statusBarItem.dispose();
        this.statusPanel?.dispose();
        this.connectionMonitor.dispose();
        this.updateCallbacks = [];
    }
}
