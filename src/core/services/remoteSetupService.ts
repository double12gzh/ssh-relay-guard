import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { buildInstallScript } from '../../setup/remoteInstaller';
import { execAsync } from '../../utils/processUtils';
import { ConfigService } from '../configService';

/**
 * Service for initializing the remote environment, setting up mgraftcp,
 * and generating/running the setup script.
 */
export class RemoteSetupService {
	constructor(
		private context: vscode.ExtensionContext,
		private configService: ConfigService,
		private log: (message: string) => void,
	) {}

	/**
	 * Ensure mgraftcp binary has execute permission
	 */
	public async ensureMgraftcpExecutable(extensionPath: string): Promise<void> {
		const arch = os.arch();
		let binaryName: string;

		switch (arch) {
			case 'x64':
			case 'amd64':
				binaryName = 'mgraftcp-fakedns-linux-amd64';
				break;
			case 'arm64':
			case 'aarch64':
				binaryName = 'mgraftcp-fakedns-linux-arm64';
				break;
			default:
				this.log(`Unsupported architecture: ${arch}`);
				return;
		}

		const mgraftcpPath = path.join(extensionPath, 'resources', 'bin', binaryName);

		try {
			await execAsync(`chmod +x "${mgraftcpPath}"`);
			this.log(`Set execute permission for ${mgraftcpPath}`);
		} catch (error) {
			this.log(`Failed to set execute permission for mgraftcp: ${error}`);
		}
	}

	/**
	 * Auto-configure VS Code's http.proxy on the remote side.
	 */
	public async configureHttpProxy(
		proxyHost: string,
		proxyPort: number,
		proxyType: string,
	): Promise<void> {
		const proxyUrl =
			proxyType === 'socks5'
				? `socks5://${proxyHost}:${proxyPort}`
				: `http://${proxyHost}:${proxyPort}`;

		// ── Multi-user isolation ──────────────────────────────────────
		// Set process-level env vars so ALL child processes in this
		// VS Code Server instance use the correct proxy. These are
		// per-process and do not conflict with other users' servers.
		process.env.HTTP_PROXY = proxyUrl;
		process.env.HTTPS_PROXY = proxyUrl;
		process.env.http_proxy = proxyUrl;
		process.env.https_proxy = proxyUrl;
		this.log(`Set process.env HTTP(S)_PROXY = ${proxyUrl}`);

		const httpConfig = vscode.workspace.getConfiguration('http');
		const currentProxy = httpConfig.get<string>('proxy', '');

		if (!this.configService.setGlobalHttpProxy) {
			if (currentProxy === proxyUrl) {
				this.log(
					`Global HTTP proxy is disabled in settings. Clearing existing proxy: ${proxyUrl}`,
				);
				try {
					await httpConfig.update('proxy', '', vscode.ConfigurationTarget.Global);
				} catch (error) {
					this.log(`Failed to clear http.proxy: ${error}`);
				}
			}
			return;
		}

		if (currentProxy === proxyUrl) {
			this.log(`http.proxy already set to ${proxyUrl}`);
			return;
		}

		const inspected = httpConfig.inspect<string>('proxy');
		if (inspected?.globalValue && inspected.globalValue !== '') {
			const isLocalOrHost =
				inspected.globalValue.includes('127.0.0.1') ||
				inspected.globalValue.includes('localhost') ||
				inspected.globalValue.includes(proxyHost);
			if (!isLocalOrHost) {
				this.log(
					`http.proxy has external user-configured value "${inspected.globalValue}", not overriding`,
				);
				return;
			}
		}

		try {
			await httpConfig.update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
			await httpConfig.update('proxyStrictSSL', false, vscode.ConfigurationTarget.Global);
			this.log(`Set http.proxy = ${proxyUrl}`);
		} catch (error) {
			this.log(`Failed to set http.proxy: ${error}`);
		}
	}

	/**
	 * Run setup script silently in background (idempotent).
	 * Returns the output of the script to be processed by the caller.
	 */
	public async runSetupScriptSilently(
		proxyHost: string,
		proxyPort: number,
		proxyType: string,
		rewriteCloudCode: boolean,
		extensionPath: string,
	): Promise<{ success: boolean; output: string }> {
		try {
			const script = await buildInstallScript(
				proxyHost,
				proxyPort,
				rewriteCloudCode,
				extensionPath,
			);
			const tempScriptPath = path.join(
				os.tmpdir(),
				`srg_setup_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.sh`,
			);
			await fs.writeFile(tempScriptPath, script, { mode: 0o755 });

			const extensionVersion = this.context.extension.packageJSON.version || 'unknown';

			const env = {
				...process.env,
				PROXY_HOST: proxyHost,
				PROXY_PORT: String(proxyPort),
				PROXY_TYPE: proxyType,
				REWRITE_CLOUDCODE: rewriteCloudCode ? 'true' : 'false',
				EXTENSION_PATH: extensionPath,
				EXTENSION_VERSION: extensionVersion,
			};

			const { stdout, stderr } = await execAsync(`bash "${tempScriptPath}" 2>&1`, { env });
			const output = stdout || stderr || '';

			// Clean up
			await fs.unlink(tempScriptPath).catch(() => {});

			this.log(`Setup output: ${output}`);

			return { success: true, output };
		} catch (error: unknown) {
			const err = error as { message?: string; stdout?: string; stderr?: string };
			this.log(`Setup error: ${err.message || error}`);
			if (err.stdout) {
				this.log(`stdout: ${err.stdout}`);
			}
			if (err.stderr) {
				this.log(`stderr: ${err.stderr}`);
			}
			return { success: false, output: '' };
		}
	}
}
