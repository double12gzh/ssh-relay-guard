/**
 * Pure HTML generation functions for the SRG status panel WebView.
 *
 * All functions here are side-effect free: they take plain data and return
 * an HTML string. No VS Code API or state management touches this module,
 * making it trivial to unit-test and easy to iterate on UI without touching
 * the DashboardManager business logic.
 */

import {
	DiagnosticCheck,
	DiagnosticReport,
	ProtocolTestResult,
} from '../diagnostics/healthChecker';
import { TrafficStats } from '../traffic/connectionMonitor';
import { ProxyStatus } from './dashboardManager';
import { Translations } from './translations';
import { STATIC_CSS } from './panelStyle';
import { buildClientScript } from './panelScript';

// ---------------------------------------------------------------------------
// Public parameter types
// ---------------------------------------------------------------------------

export interface PanelContext {
	status: ProxyStatus;
	t: Translations;
	currentLang: string;

	// VS Code config values (read once by caller, passed here)
	enableForwarding: boolean;
	proxyType: string;
	rewriteCloudCodeEndpoint: boolean;

	// Diagnostic state
	diagnosticReport: DiagnosticReport | null;
	isRunningDiagnostics: boolean;

	// Traffic state
	trafficStats: TrafficStats;
	sessionDuration: string;

	// Countdown
	secondsUntilRefresh: number;
}

// ---------------------------------------------------------------------------
// Shared status-color resolution (used by both panelRenderer and dashboardManager)
// ---------------------------------------------------------------------------

export interface StatusAppearance {
	color: string;
	text: string;
}

/**
 * Derive status color + text from proxy status and locale.
 * Single source of truth for the 3-state (connected/partial/disconnected) logic.
 */
export function resolveStatusAppearance(
	status: ProxyStatus,
	t: Pick<Translations, 'connected' | 'partial' | 'disconnected' | 'notSetup'>,
): StatusAppearance {
	const isLocal = status.runningLocation === 'local';
	if (isLocal) {
		if (status.sshConfigEnabled && status.localProxyReachable) {
			return { color: '#34d399', text: t.connected };
		} else if (status.sshConfigEnabled) {
			return { color: '#fbbf24', text: t.partial };
		}
		// No hosts configured yet → show "Not Setup" (yellow) instead of "Disconnected" (red)
		if (status.hasConfiguredHosts === false) {
			return { color: '#fbbf24', text: t.notSetup };
		}
		return { color: '#f87171', text: t.disconnected };
	}
	// Remote: if setup hasn't been completed, show "not setup" regardless of port reachability
	if (status.remoteSetupCompleted === false) {
		return { color: '#fbbf24', text: t.notSetup };
	}
	// Green only when proxy protocol handshake succeeds (not just TCP port open)
	if (status.remoteProxyFunctional) {
		return { color: '#34d399', text: t.connected };
	}
	// Port reachable but proxy handshake failed → partial (yellow)
	// This catches: port occupied by another process, local proxy not running, etc.
	if (status.remoteProxyReachable) {
		return { color: '#fbbf24', text: t.partial };
	}
	return { color: '#f87171', text: t.disconnected };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildPanelHtml(ctx: PanelContext): string {
	const { status, t } = ctx;
	const isLocal = status.runningLocation === 'local';

	const { color: statusColor, text: statusText } = resolveStatusAppearance(status, t);

	const diagnosticsHtml = buildDiagnosticsHtml(ctx, isLocal);
	const trafficHtml = buildTrafficHtml(ctx, isLocal);
	const statsStripHtml = buildStatsStrip(ctx, isLocal);

	return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${buildStyles(statusColor)}
    </style>
</head>
<body>
    <div class="root">
        <!-- Topbar -->
        <div class="topbar">
            <div class="topbar-dot" id="status-dot"></div>
            <span class="topbar-title">${t.title}</span>
            <span class="topbar-pill pill-env">${isLocal ? t.local : t.remote}</span>
            <span class="topbar-pill pill-status" id="status-badge-text">${statusText}</span>
            <span class="topbar-spacer"></span>
            <div class="lang-sw">
                <button class="${ctx.currentLang === 'zh' ? 'on' : ''}" onclick="setLang('zh')">中</button>
                <button class="${ctx.currentLang === 'en' ? 'on' : ''}" onclick="setLang('en')">EN</button>
            </div>
        </div>

        ${!isLocal ? buildTunnelAlert(t, status) : ''}

        <!-- Quick stats strip -->
        <div class="stats-strip">
            ${statsStripHtml}
        </div>

        <!-- Config section -->
        <div class="section">
            <div class="section-head">
                <span class="section-label">${isLocal ? t.statusConfig : t.statusConfig}</span>
            </div>
            <div class="section-body">
                ${isLocal ? buildLocalConfigSection(ctx) : buildRemoteConfigSection(ctx)}
            </div>
        </div>

        <!-- Diagnostics section -->
        <div class="section">
            <div class="section-head">
                <span class="section-label">${t.diagnostics}</span>
                <div class="section-actions">
                    <button class="ab ab-ghost ab-sm" onclick="runDiagnostics()" ${ctx.isRunningDiagnostics ? 'disabled' : ''}>
                        ${ctx.isRunningDiagnostics ? t.running : t.runCheck}
                    </button>
                    <button class="ab ab-ghost ab-sm" onclick="copyReport()" ${!ctx.diagnosticReport ? 'disabled' : ''}>
                        ${t.copyReport}
                    </button>
                </div>
            </div>
            <div class="section-body">
                ${diagnosticsHtml}
            </div>
        </div>

        <!-- Tips & Traffic -->
        <div class="bottom-grid">
            <div class="section" style="margin-bottom:0">
                <div class="section-head"><span class="section-label">${t.tips}</span></div>
                <div class="section-body">
                    <div class="tip-content">
                        ${isLocal ? buildLocalTips(t) : buildRemoteTips(t)}
                    </div>
                </div>
            </div>
            <div id="traffic-container">${trafficHtml}</div>
        </div>

        <!-- Actions -->
        <div class="action-bar">
            <button class="ab ab-ghost" onclick="rollback()">${t.rollback}</button>
            <button class="ab ab-ghost" onclick="refresh()">${t.refresh}</button>
            <button class="ab ab-primary" onclick="saveConfig()">${t.save}</button>
        </div>

        <!-- Footer -->
        <div class="foot">
            <span>${t.autoRefresh} <span class="foot-accent" id="countdown">${ctx.secondsUntilRefresh}</span>s</span>
            <span id="last-updated">${t.updated} ${status.lastUpdated.toLocaleTimeString()}</span>
        </div>
    </div>

    <script>
        ${buildClientScript(isLocal)}
    </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Traffic HTML (also called from DashboardManager for live postMessage updates)
// ---------------------------------------------------------------------------

export function buildTrafficHtml(
	ctx: Pick<PanelContext, 't' | 'trafficStats' | 'sessionDuration' | 'status'>,
	isLocal: boolean,
): string {
	const { t, trafficStats, sessionDuration, status } = ctx;

	if (isLocal) {
		const hosts = status.configuredHosts ?? [];
		const hostListHtml =
			hosts.length > 0
				? hosts
						.map(
							(h) => `
                <div class="host-row">
                    <div class="host-dot"></div>
                    <span class="host-name">${h}</span>
                    <span class="host-port">:${status.remoteProxyPort}</span>
                </div>`,
						)
						.join('')
				: `<div class="t-unavail">${t.noHostsYet}</div>`;

		return `
            <div class="section" style="margin-bottom:0">
                <div class="section-head"><span class="section-label">${t.configuredHosts}</span></div>
                <div class="section-body">
                    ${hostListHtml}
                </div>
            </div>`;
	}

	return `
        <div class="section" style="margin-bottom:0">
            <div class="section-head"><span class="section-label">${t.traffic}</span></div>
            <div class="section-body">
                <div class="traffic-grid">
                    <div class="t-cell">
                        <div class="t-cell-label">${t.connections}</div>
                        <div class="t-cell-val">${trafficStats.activeConnections}</div>
                    </div>
                    <div class="t-cell">
                        <div class="t-cell-label">${t.session}</div>
                        <div class="t-cell-val sm">${sessionDuration}</div>
                    </div>
                    <div class="t-cell">
                        <div class="t-cell-label">${t.totalRequests}</div>
                        <div class="t-cell-val sm">${trafficStats.totalConnectionsSeen}</div>
                    </div>
                </div>
            </div>
        </div>`;
}

// ---------------------------------------------------------------------------
// Stats strip (quick status chips at a glance)
// ---------------------------------------------------------------------------

function buildStatsStrip(ctx: PanelContext, isLocal: boolean): string {
	const { status, t } = ctx;

	if (isLocal) {
		let sshClass: string;
		let sshText: string;
		if (status.sshConfigEnabled) {
			sshClass = 'g';
			sshText = t.on;
		} else if (status.hasConfiguredHosts === false) {
			sshClass = 'a';
			sshText = t.notSetup;
		} else {
			sshClass = 'r';
			sshText = t.off;
		}
		const proxyClass = status.localProxyReachable ? 'g' : 'r';
		const proxyText = status.localProxyReachable ? t.reachable : t.unreachable;
		return `
            <div class="stat-chip">
                <div class="stat-dot ${sshClass}"></div>
                <span class="stat-label" id="ssh-fwd-label">${t.sshForwarding}</span>
                <span class="stat-val ${sshClass}" id="ssh-fwd-val">${sshText}</span>
            </div>
            <div class="stat-chip">
                <div class="stat-dot ${proxyClass}"></div>
                <span class="stat-label">${t.localProxy}</span>
                <span class="stat-val ${proxyClass}" id="local-proxy-val">${proxyText}</span>
            </div>`;
	}

	const proxyClass = status.remoteProxyFunctional ? 'g' : status.remoteProxyReachable ? 'a' : 'r';
	const proxyText = status.remoteProxyFunctional ? t.reachable : t.unreachable;
	const lsConfigured = status.languageServerConfigured;
	const lsClass = lsConfigured ? 'g' : 'r';
	const lsText =
		lsConfigured !== undefined ? (lsConfigured ? t.configured : t.notConfigured) : '';

	return `
        <div class="stat-chip">
            <div class="stat-dot ${proxyClass}"></div>
            <span class="stat-label">${t.proxy}</span>
            <span class="stat-val ${proxyClass}" id="remote-proxy-val">${proxyText}</span>
        </div>
        <div class="stat-chip" id="lang-server-row" style="${lsConfigured !== undefined ? '' : 'display:none;'}">
            <div class="stat-dot ${lsClass}"></div>
            <span class="stat-label">${t.languageServer}</span>
            <span class="stat-val ${lsClass}" id="lang-server-val">${lsText}</span>
        </div>`;
}

// ---------------------------------------------------------------------------
// Diagnostics HTML
// ---------------------------------------------------------------------------

function buildDiagnosticsHtml(ctx: PanelContext, isLocal: boolean): string {
	const { t, diagnosticReport } = ctx;

	const checks: DiagnosticCheck[] = diagnosticReport?.checks ?? [
		{ id: 'local-proxy', name: 'Local Proxy Service', status: 'pending' },
		{ id: 'ssh-config', name: 'SSH Configuration', status: 'pending' },
		{ id: 'remote-forward', name: 'Remote Port Forwarding', status: 'pending' },
		{ id: 'mgraftcp', name: 'mgraftcp Binary', status: 'pending' },
		{ id: 'ls-wrapper', name: 'Language Server Wrapper', status: 'pending' },
		{ id: 'external-connectivity', name: 'External Connectivity', status: 'pending' },
	];

	// Filter: only show checks relevant to the current environment
	const LOCAL_CHECK_IDS = ['local-proxy', 'ssh-config'];
	const relevantChecks = checks.filter((check) => {
		const isLocalCheck = LOCAL_CHECK_IDS.includes(check.id);
		return isLocal ? isLocalCheck : !isLocalCheck;
	});

	return relevantChecks
		.map((check) => {
			const { statusText, statusClass } = resolveCheckStatus(check, false, isLocal, t);
			const message = check.message;
			const suggestion = check.suggestion;
			const fixAction = check.fixAction;
			const protocolResults = check.protocolResults;
			const hasDetails = message || suggestion || protocolResults;
			const protocolHtml = buildProtocolListHtml(check, protocolResults);
			const dotClass = STATUS_TO_DOT[check.status] ?? 'p';

			// Build fix button HTML if fixAction is available
			let fixBtnHtml = '';
			if (fixAction) {
				const escaped = fixAction.replace(/'/g, "\\'").replace(/"/g, '&quot;');
				if (fixAction.startsWith('copyCommand:')) {
					fixBtnHtml = `<button class="ab ab-fix ab-sm" onclick="fixDiag('${escaped}')">${t.copyCmd}</button>`;
				} else {
					fixBtnHtml = `<button class="ab ab-fix ab-sm" onclick="fixDiag('${escaped}')">${t.fix}</button>`;
				}
			}

			return `
            <div class="diag-wrap">
                <div class="diag">
                    <div class="diag-d ${dotClass}"></div>
                    <span class="diag-n">${getDiagCheckName(check.id, t)}</span>
                    <span class="diag-s ${statusClass}">${statusText}</span>
                </div>
                ${
					hasDetails
						? `
                <div class="diag-detail">
                    ${protocolHtml}
                    ${message && !protocolResults ? `<div class="diag-msg">${message}</div>` : ''}
                    ${
						suggestion
							? `<div class="diag-tip-row">
                        <div class="diag-tip">💡 ${suggestion}</div>
                        ${fixBtnHtml}
                    </div>`
							: ''
					}
                </div>`
						: ''
				}
            </div>`;
		})
		.join('');
}

const STATUS_TO_DOT: Record<string, string> = {
	success: 's',
	warning: 'w',
	error: 'e',
	running: 'run',
	pending: 'p',
};

function resolveCheckStatus(
	check: DiagnosticCheck,
	isDisabled: boolean,
	isLocal: boolean,
	t: Translations,
): { statusText: string; statusClass: string } {
	if (isDisabled) {
		return { statusText: isLocal ? t.remoteOnly : t.localOnly, statusClass: '' };
	}
	switch (check.status) {
		case 'success':
			return { statusText: '✓', statusClass: 's' };
		case 'warning':
			return { statusText: '!', statusClass: 'w' };
		case 'error':
			return { statusText: '✗', statusClass: 'e' };
		case 'running':
			return { statusText: '...', statusClass: '' };
		default:
			return { statusText: t.pending, statusClass: '' };
	}
}

function buildProtocolListHtml(
	check: DiagnosticCheck,
	protocolResults?: ProtocolTestResult[],
): string {
	if (check.id !== 'external-connectivity' || !protocolResults?.length) {
		return '';
	}

	const rows = protocolResults
		.map((result, index) => {
			const isLast = index === protocolResults.length - 1;
			const prefix = isLast ? '└─' : '├─';
			const icon = result.success ? '✓' : '✗';
			const cls = result.success ? 'g' : 'r';
			const label = result.success ? 'OK' : 'Blocked';
			const current = result.isCurrent ? ` ← Current` : '';
			return `
            <div class="proto-row">
                <span class="proto-pre">${prefix}</span>
                <span class="proto-name">${result.protocol.toUpperCase()}</span>
                <span class="proto-st ${cls}">${icon} ${label}</span>
                ${result.isCurrent ? `<span class="proto-cur">${current}</span>` : ''}
            </div>`;
		})
		.join('');

	return `<div class="proto-list">${rows}</div>`;
}

function getDiagCheckName(id: string, t: Translations): string {
	const names: Record<string, string> = {
		'local-proxy': t.localProxyService,
		'ssh-config': t.sshConfig,
		'remote-forward': t.remoteForward,
		mgraftcp: t.mgraftcp,
		'ls-wrapper': t.lsWrapper,
		'external-connectivity': t.externalConn,
	};
	return names[id] ?? id;
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function buildTunnelAlert(t: Translations, status: ProxyStatus): string {
	const port = status.remoteProxyPort;
	const tunnelCmd = `ssh -fN -R ${port}:127.0.0.1:${port} <hostname>`;
	const escapedCmd = tunnelCmd.replace(/'/g, "\\'");

	return `
        <!-- Warning Alert: always in DOM for remote mode, visibility controlled by JS -->
        <div id="tunnel-alert" class="alert-banner" style="${!status.remoteProxyFunctional ? '' : 'display:none;'}">
            <div class="alert-ico">⚠</div>
            <div class="alert-body">
                <h4>${t.tunnelWarningTitle}</h4>
                <p>${t.tunnelWarningMsg}</p>
                <div class="alert-steps">
                    <div class="step-item"><span class="step-n step-n-warn">1</span>${t.tunnelStep0}</div>
                    <div class="step-item"><span class="step-n step-n-warn">2</span>${t.tunnelStep1}</div>
                    <div class="step-item"><span class="step-n step-n-warn">3</span>${t.tunnelStep2}</div>
                    <div class="step-item"><span class="step-n step-n-warn">4</span>${t.tunnelStep3}</div>
                    <div class="step-item"><span class="step-n step-n-warn">5</span>${t.tunnelStep4}</div>
                </div>
                <div class="tunnel-cmd-wrap">
                    <div class="tunnel-cmd-label">${t.tunnelCmdLabel}</div>
                    <div class="tunnel-cmd-row">
                        <code class="tunnel-cmd-code">${tunnelCmd}</code>
                        <button class="ab ab-fix ab-sm" onclick="copyCmd('${escapedCmd}')">${t.copyCmd}</button>
                    </div>
                </div>
                <div class="alert-actions">
                    <button class="ab ab-alert-btn" id="retry-btn" onclick="retryCheck()">${t.retryCheck}</button>
                    <button class="ab ab-alert-btn" onclick="runDiagnostics()">${t.runDiag}</button>
                    <button class="ab ab-alert-btn ab-alert-ghost" onclick="closeRemote()">${t.closeRemote}</button>
                </div>
            </div>
        </div>`;
}

function buildLocalConfigSection(ctx: PanelContext): string {
	const { status, t, enableForwarding } = ctx;
	return `
        <div class="prop">
            <span class="prop-k">${t.enableForwarding}</span>
            <label class="sw">
                <input type="checkbox" id="enableForwarding" ${enableForwarding ? 'checked' : ''}>
                <span class="sw-track"></span>
            </label>
        </div>
        <div class="hint">${t.globalForwardingTip}</div>
        <div class="prop">
            <span class="prop-k">${t.localPort}</span>
            <input type="number" id="localProxyPort" value="${status.localProxyPort}" min="1" max="65535">
        </div>
        <div class="hint">${t.localPortTip}</div>
        <div class="prop">
            <span class="prop-k">${t.remotePort}</span>
            <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
        </div>
        <div class="hint">${t.remotePortTipLocal}</div>`;
}

function buildRemoteConfigSection(ctx: PanelContext): string {
	const { status, t, proxyType } = ctx;
	return `
        <div class="prop">
            <span class="prop-k">${t.proxyHost}</span>
            <span class="prop-v">${status.remoteProxyHost}</span>
        </div>
        <div class="prop">
            <span class="prop-k">${t.proxyPort}</span>
            <span class="prop-v">${status.remoteProxyPort}</span>
        </div>
        <div class="hint">${t.remotePortTipRemote}</div>
        <div class="prop">
            <span class="prop-k">${t.proxyType}</span>
            <select id="proxyType">
                <option value="http" ${proxyType === 'http' ? 'selected' : ''}>${t.proxyTypeHttp}</option>
                <option value="socks5" ${proxyType === 'socks5' ? 'selected' : ''}>${t.proxyTypeSocks5}</option>
            </select>
        </div>
        <div class="prop">
            <span class="prop-k">${t.rewriteCloudCodeEndpoint}</span>
            <label class="sw">
                <input type="checkbox" id="rewriteCloudCodeEndpoint" ${ctx.rewriteCloudCodeEndpoint ? 'checked' : ''}>
                <span class="sw-track"></span>
            </label>
        </div>
        <div class="hint">${t.rewriteCloudCodeTip}</div>`;
}

function buildLocalTips(t: Translations): string {
	return `
        <div class="tips-title">${t.tipTitleLocal}</div>
        <ul class="step-list">
            <li class="step-item"><span class="step-n">1</span><span>${t.tipStep1Local}</span></li>
            <li class="step-item"><span class="step-n">2</span><span>${t.tipStep2Local}</span></li>
            <li class="step-item"><span class="step-n">3</span><span>${t.tipStep3Local}</span></li>
            <li class="step-item"><span class="step-n">4</span><span>${t.tipStep4Local}</span></li>
        </ul>
        <div class="note-box"><b>⚠</b> ${t.tipNoteLocal}</div>`;
}

function buildRemoteTips(t: Translations): string {
	return `
        <div class="tips-title">${t.tipTitleRemote}</div>
        <ul class="step-list">
            <li class="step-item"><span class="step-n">1</span><span>${t.tipStep1Remote}</span></li>
            <li class="step-item"><span class="step-n">2</span><span>${t.tipStep2Remote}</span></li>
            <li class="step-item"><span class="step-n">3</span><span>${t.tipStep3Remote}</span></li>
            <li class="step-item"><span class="step-n">4</span><span>${t.tipStep4Remote}</span></li>
        </ul>
        <div class="note-box">${t.tipNoteRemote}</div>
        <div class="warn-block">
            <div class="tips-title" style="color: var(--red);">${t.rollbackTitle}</div>
            <p style="font-size: 10px; color: var(--text-dim);">${t.rollbackDesc}</p>
        </div>`;
}

// ---------------------------------------------------------------------------
// CSS — v3 "Clean Control Panel" design system
// ---------------------------------------------------------------------------

function buildStyles(statusColor: string): string {
	return `:root { --status-color: ${statusColor}; }\n${STATIC_CSS}`;
}

// ---------------------------------------------------------------------------
// Client-side JavaScript (runs inside WebView, NOT in Node.js)
// ---------------------------------------------------------------------------
