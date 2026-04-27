import * as vscode from 'vscode';
import { buildInstallScript, buildRestoreScript } from '../setup/remoteInstaller';
import { DashboardManager } from '../panel/dashboardManager';
import { ConfigService } from './configService';
import { StateManager } from './stateManager';
import { isPortReachable, isProxyFunctional } from '../utils/portProbe';
import { getMonitoredProcess, promptReloadWindow } from '../utils/processUtils';
import { RemoteSetupService } from './services/remoteSetupService';
import { RemoteProcessService } from './services/remoteProcessService';
import { RemoteDiagnosticsService } from './services/remoteDiagnosticsService';
import { IModeController } from './modeController';

/**
 * RemoteModeController — Handles all remote-side SRG functionality.
 *
 * Responsibilities:
 * - Register remote-only VS Code commands (setup, rollback, checkProxy)
 * - Delegate to services for setup, process monitoring, and diagnostics.
 */
export class RemoteModeController implements IModeController {
	private setupService: RemoteSetupService;
	private processService: RemoteProcessService;
	private diagnosticsService: RemoteDiagnosticsService;

	constructor(
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private dashboardManager: DashboardManager,
		private stateManager: StateManager,
		private log: (message: string) => void,
	) {
		this.setupService = new RemoteSetupService(context, configService, log);
		this.processService = new RemoteProcessService(log);
		this.diagnosticsService = new RemoteDiagnosticsService(
			configService,
			this.processService,
			log,
		);
	}

	/**
	 * Detect the actual tunnel port on this remote server.
	 *
	 * The global `remoteProxyPort` setting may be stale if another host's
	 * tunnel negotiated a different port. This method probes the configured
	 * port first, then tries port+1..port+10 (matching the Go daemon's retry
	 * range) to find the real tunnel.
	 *
	 * @returns The detected port, or the configured port as fallback.
	 */
	private async detectTunnelPort(host: string, configuredPort: number): Promise<number> {
		const proxyType = this.configService.proxyType as 'http' | 'socks5' | 'any';
		const timeout = 3000; // Increased to 3s for high-latency SSH connections

		// 1. Check if we already have a functional port for this remote window
		const previousPort = this.stateManager.getState().detectedRemotePort;
		if (previousPort && previousPort !== configuredPort) {
			if (await isProxyFunctional(host, previousPort, proxyType, timeout)) {
				this.log(
					`detectTunnelPort: previously detected port ${previousPort} is still functional`,
				);
				return previousPort;
			}
		}

		// 2. Fast path: configured port is reachable AND acts like a proxy
		if (await isProxyFunctional(host, configuredPort, proxyType, timeout)) {
			return configuredPort;
		}

		// 3. Probe nearby ports in parallel (Go daemon uses max 10 retries)
		const MAX_OFFSET = 10;
		const probes = Array.from({ length: MAX_OFFSET }, (_, i) => {
			const port = configuredPort + i + 1;
			return isProxyFunctional(host, port, proxyType, timeout).then((ok) =>
				ok ? port : null,
			);
		});

		const results = await Promise.all(probes);
		const detectedPort = results.find((p): p is number => p !== null);

		if (detectedPort) {
			this.log(
				`detectTunnelPort: configured port ${configuredPort} unreachable, detected tunnel on port ${detectedPort}`,
			);
			return detectedPort;
		}

		// No port found — tunnel likely not established, use configured port
		this.log(
			`detectTunnelPort: no reachable port in range ${configuredPort}-${configuredPort + MAX_OFFSET}, using configured ${configuredPort}`,
		);
		return configuredPort;
	}

	/**
	 * Activate remote mode: ensure binaries, run setup, configure proxy,
	 * register commands, listen for config changes, run startup checks.
	 */
	async activate(): Promise<void> {
		const remoteHost = this.configService.remoteProxyHost;
		const remotePort = this.configService.remoteProxyPort;
		const proxyType = this.configService.proxyType;

		// ── Multi-user isolation ──────────────────────────────────────────
		// Inject proxy config into process.env so the LS wrapper (spawned
		// by the IDE's own extension, not by SRG) inherits session-specific
		// values. Each VS Code Server is a separate OS process, so different
		// users get different env values — zero cross-user interference.
		const rewriteCloudCode = this.configService.rewriteCloudCodeEndpoint;
		this.updateProxyEnv(remoteHost, remotePort, proxyType, rewriteCloudCode);

		if (process.platform !== 'linux') {
			this.log(
				`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`,
			);
			this.stateManager.updateState({ isVerifying: false });
			return;
		}

		const extensionPath = this.context.extensionUri.fsPath;

		await this.setupService.ensureMgraftcpExecutable(extensionPath);

		this.stateManager.onRequestConfigApply(async () => {
			const host = this.configService.remoteProxyHost;
			const port = this.configService.remoteProxyPort;
			const type = this.configService.proxyType;
			const rewrite = this.configService.rewriteCloudCodeEndpoint;
			this.updateProxyEnv(host, port, type, rewrite);
			const actual = await this.detectTunnelPort(host, port);
			this.updateProxyEnv(host, actual, type, rewrite); // Update with detected port
			this.stateManager.updateState({ detectedRemotePort: actual }); // Update state for dashboard
			this.log(`Config changed from panel, re-running setup: ${host}:${actual} (${type})`);
			await this.runSetupAndApply(host, actual, type, rewrite, extensionPath);
			await this.setupService.configureHttpProxy(host, actual, type);
		});

		this.log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);
		this.log(`Extension path: ${extensionPath}`);
		this.log('Auto-running setup script...');

		// Detect actual tunnel port (may differ from configured if another host
		// negotiated a different port and updated the global setting).
		const actualPort = await this.detectTunnelPort(remoteHost, remotePort);
		if (actualPort !== remotePort) {
			this.log(
				`Using detected tunnel port ${actualPort} instead of configured ${remotePort}`,
			);
			this.updateProxyEnv(remoteHost, actualPort, proxyType, rewriteCloudCode);
			this.stateManager.updateState({ detectedRemotePort: actualPort });
		}
		await this.runSetupAndApply(
			remoteHost,
			actualPort,
			proxyType,
			rewriteCloudCode,
			extensionPath,
		);

		await this.setupService.configureHttpProxy(remoteHost, actualPort, proxyType);

		this.context.subscriptions.push(
			this.configService.onChange(async () => {
				const host = this.configService.remoteProxyHost;
				const port = this.configService.remoteProxyPort;
				const type = this.configService.proxyType;
				const rewrite = this.configService.rewriteCloudCodeEndpoint;
				this.updateProxyEnv(host, port, type, rewrite);
				const actual = await this.detectTunnelPort(host, port);
				this.updateProxyEnv(host, actual, type, rewrite); // Update with detected port
				this.stateManager.updateState({ detectedRemotePort: actual });
				this.log(`Config changed, re-running setup: ${host}:${actual} (${type})`);
				await this.runSetupAndApply(host, actual, type, rewrite, extensionPath);
				await this.setupService.configureHttpProxy(host, actual, type);
				await this.dashboardManager.refreshStatus();
			}),
		);

		const showStatusOnStartup = this.configService.showStatusOnStartup;
		if (showStatusOnStartup) {
			this.runFullStartupCheck(remoteHost, remotePort);
		} else {
			await this.dashboardManager.refreshStatus();
			this.stateManager.updateState({ isVerifying: false });
		}
	}

	private async runSetupAndApply(
		host: string,
		port: number,
		type: string,
		rewrite: boolean,
		extensionPath: string,
	): Promise<boolean> {
		const { success, output } = await this.setupService.runSetupScriptSilently(
			host,
			port,
			type,
			rewrite,
			extensionPath,
		);
		this.stateManager.updateState({ languageServerConfigured: success });

		const isNewConfig =
			output.includes('Setup complete') ||
			(output.includes('configured') && !output.includes('Already configured'));

		if (isNewConfig) {
			this.log('Setup: New configuration applied');
			const lsProcess = await getMonitoredProcess();
			if (lsProcess) {
				this.log(
					`Setup: LS running (PID ${lsProcess.pid}, persistent=${lsProcess.isPersistent}), killing to apply wrapper`,
				);
				await this.processService.killLSAndAutoReload();
			} else {
				this.log('Setup: LS not running, will start with proxy on next use');
				promptReloadWindow(
					'Proxy configured. Reload window to apply changes to the language server.',
				);
			}
			return true;
		} else if (output.includes('Already configured')) {
			this.log('Setup: Already configured');
			const lsProcess = await getMonitoredProcess();
			const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
			const lsIsPersistent = lsProcess?.isPersistent ?? false;

			if (lsProcess && !lsActuallyUsingProxy) {
				this.log(
					`Setup: Proxy configured but LS not using it (PID ${lsProcess.pid}, persistent=${lsIsPersistent}), auto-fixing...`,
				);
				await this.processService.killLSAndAutoReload();
			} else if (lsActuallyUsingProxy) {
				this.log('Setup: Proxy is active, no reload needed');
			} else {
				this.log('Setup: LS not running, will use proxy when started');
			}
			return true;
		}
		return false;
	}

	public async setup(): Promise<void> {
		const host = this.configService.remoteProxyHost;
		const port = this.configService.remoteProxyPort;
		const rewrite = this.configService.rewriteCloudCodeEndpoint;
		const extensionPath = this.context.extensionUri.fsPath;
		const terminal = vscode.window.createTerminal('SRG Setup');
		terminal.show();
		const script = await buildInstallScript(host, port, rewrite, extensionPath);
		const tempFileCmd = `TMP_SCRIPT=$(mktemp /tmp/srg_setup.XXXXXX.sh) && cat > "$TMP_SCRIPT" << 'EOF'\n${script}\nEOF\nbash "$TMP_SCRIPT" && rm -f "$TMP_SCRIPT"`;
		terminal.sendText(tempFileCmd);
	}

	public async rollback(): Promise<void> {
		const terminal = vscode.window.createTerminal('SRG Rollback');
		terminal.show();
		terminal.sendText(buildRestoreScript());
		this.stateManager.updateState({ languageServerConfigured: false });
	}

	public async checkProxy(): Promise<void> {
		const remoteHost = this.configService.remoteProxyHost;
		const remotePort = this.configService.remoteProxyPort;
		const ok = await isPortReachable(remoteHost, remotePort);
		await this.dashboardManager.refreshStatus();
		vscode.window.showInformationMessage(ok ? `Proxy OK` : `Proxy NOT reachable`);
	}

	public setReconnectingState(state: boolean): void {
		this.dashboardManager.setLocalReconnectionState(state);
	}

	private async runFullStartupCheck(remoteHost: string, remotePort: number): Promise<void> {
		try {
			await this.showStartupStatus(remoteHost, remotePort);
		} catch (err) {
			this.log(`Startup check error: ${err}`);
		} finally {
			await this.dashboardManager.refreshStatus();
			this.stateManager.updateState({ isVerifying: false });
		}
	}

	private async showStartupStatus(proxyHost: string, proxyPort: number): Promise<void> {
		try {
			const diag = await this.diagnosticsService.diagnoseStartup(proxyHost, proxyPort);
			const result = await this.diagnosticsService.resolveStartupAction(
				proxyHost,
				proxyPort,
				diag,
			);

			if (!result) {
				return;
			}

			this.log(`Startup status: ${result.message}`);

			if (result.actions.length > 0) {
				const selection = await vscode.window.showInformationMessage(
					result.message,
					...result.actions,
				);
				await this.diagnosticsService.handleStartupAction(selection);
			} else {
				vscode.window.showInformationMessage(result.message);
			}
		} catch (error) {
			this.log(`Startup status check failed: ${error}`);
		}
	}

	// ── Multi-user isolation helpers ──────────────────────────────────

	/**
	 * Inject proxy configuration into process.env.
	 *
	 * Each VS Code Remote SSH connection creates a separate Server process.
	 * Setting process.env here makes these values available to ALL child
	 * processes (including the LS wrapper) within this Server instance,
	 * while other users' Server processes have their own independent env.
	 */
	private updateProxyEnv(
		host: string,
		port: number,
		proxyType: string,
		rewriteCloudCode: boolean,
	): void {
		process.env.SRG_PROXY_ADDR = `${host}:${port}`;
		process.env.SRG_PROXY_TYPE = proxyType;
		process.env.SRG_PROXY_PORT = String(port);
		process.env.SRG_REWRITE_CLOUDCODE = rewriteCloudCode ? 'true' : 'false';
		this.log(`Injected process.env: SRG_PROXY_ADDR=${host}:${port}, type=${proxyType}`);
	}
}
