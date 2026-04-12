import * as vscode from 'vscode';
import { ProxyOrchestrator } from './core/proxyOrchestrator';

let orchestrator: ProxyOrchestrator;

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('SSH Relay Guard');
	context.subscriptions.push(outputChannel);

	orchestrator = new ProxyOrchestrator(context, outputChannel);
	orchestrator.initialize();
	context.subscriptions.push(orchestrator);
}

export function deactivate() {
	// ProxyOrchestrator.dispose() handles cleanup via subscriptions.
	// SSH config is PERSISTENT — not deleted on deactivate.
	// Users can use Rollback command or 'srg teardown' to clean up.
}
