import * as vscode from 'vscode';
import {
	killTargetProcess,
	getMonitoredProcess,
	countSiblingServerInstances,
} from '../../utils/processUtils';

/**
 * Service for managing the lifecycle of processes (e.g. Language Server)
 * on the remote machine.
 */
export class RemoteProcessService {
	constructor(private log: (message: string) => void) {}

	/**
	 * Kill LS process and prompt user to reload window.
	 * If kill succeeds, shows prompt to reload.
	 * If kill fails, shows manual instructions.
	 */
	public async killLSAndAutoReload(): Promise<void> {
		// Check if killing would affect sibling windows
		const proc = await getMonitoredProcess();
		if (proc?.isPersistent) {
			const siblingCount = await countSiblingServerInstances();
			if (siblingCount > 1) {
				const action = await vscode.window.showWarningMessage(
					`⚠️ ${siblingCount} windows share this Language Server. Killing it will restart LS for ALL windows. Continue?`,
					'Kill & Reload All',
					'Cancel',
				);
				if (action !== 'Kill & Reload All') {
					this.log('Kill cancelled by user (sibling sessions detected)');
					return;
				}
			}
		}

		const killed = await killTargetProcess((m) => this.log(m));
		if (killed) {
			this.log('LS killed, prompting user to reload window...');
			vscode.window
				.showInformationMessage(
					'🔄 Language Server stopped to apply proxy settings. Reload window to take effect.',
					'Reload Now',
					'Later',
				)
				.then((selection) => {
					if (selection === 'Reload Now') {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
		} else {
			vscode.window
				.showWarningMessage(
					'Proxy configured but Language Server needs restart. ' +
						'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
					'Reload Now',
				)
				.then((selection) => {
					if (selection === 'Reload Now') {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
		}
	}
}
