/**
 * Pure HTML generation functions for the SRG status panel WebView.
 *
 * All functions here are side-effect free: they take plain data and return
 * an HTML string. No VS Code API or state management touches this module,
 * making it trivial to unit-test and easy to iterate on UI without touching
 * the DashboardManager business logic.
 */

import { DiagnosticCheck, DiagnosticReport, ProtocolTestResult } from '../diagnostics/healthChecker';
import { TrafficStats } from '../traffic/connectionMonitor';
import { ProxyStatus } from './dashboardManager';
import { Translations } from './translations';

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
    t: Pick<Translations, 'connected' | 'partial' | 'disconnected'>
): StatusAppearance {
    const isLocal = status.runningLocation === 'local';
    if (isLocal) {
        if (status.sshConfigEnabled && status.localProxyReachable) {
            return { color: '#22c55e', text: t.connected };
        } else if (status.sshConfigEnabled) {
            return { color: '#eab308', text: t.partial };
        }
        return { color: '#ef4444', text: t.disconnected };
    }
    return status.remoteProxyReachable
        ? { color: '#22c55e', text: t.connected }
        : { color: '#ef4444', text: t.disconnected };
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
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="status-indicator" id="status-dot"></div>
            <span class="title">${t.title}</span>
            <span class="env-badge">${isLocal ? t.local : t.remote}</span>
            <span class="status-badge" id="status-badge-text">${statusText}</span>
            <div class="lang-toggle">
                <button class="lang-btn ${ctx.currentLang === 'zh' ? 'active' : ''}" onclick="setLang('zh')">中</button>
                <button class="lang-btn ${ctx.currentLang === 'en' ? 'active' : ''}" onclick="setLang('en')">EN</button>
            </div>
        </div>

        ${!isLocal ? buildTunnelAlert(t, status) : ''}

        <!-- Status & Config Card -->
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">⚡</span>${t.statusConfig}</span>
            </div>
            <div class="card-body">
                ${isLocal ? buildLocalConfigSection(ctx) : buildRemoteConfigSection(ctx)}
            </div>
        </div>

        <!-- Diagnostics Card -->
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">◎</span>${t.diagnostics}</span>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-sm" onclick="runDiagnostics()" ${ctx.isRunningDiagnostics ? 'disabled' : ''}>
                        ${ctx.isRunningDiagnostics ? t.running : t.runCheck}
                    </button>
                    <button class="btn btn-sm" onclick="copyReport()" ${!ctx.diagnosticReport ? 'disabled' : ''}>
                        ${t.copyReport}
                    </button>
                </div>
            </div>
            <div class="card-body">
                ${diagnosticsHtml}
            </div>
        </div>

        <!-- Tips & Traffic Grid -->
        <div class="grid">
            <!-- Tips Card -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><span class="card-title-icon">◇</span>${t.tips}</span>
                </div>
                <div class="card-body">
                    <div class="tip-content">
                        ${isLocal ? buildLocalTips(t) : buildRemoteTips(t)}
                    </div>
                </div>
            </div>

            <!-- Traffic Card -->
            <div id="traffic-container">${trafficHtml}</div>
        </div>

        <!-- Actions -->
        <div class="actions">
            <button class="btn" onclick="rollback()">${t.rollback}</button>
            <button class="btn" onclick="refresh()">${t.refresh}</button>
            <button class="btn btn-primary" onclick="saveConfig()">${t.save}</button>
        </div>

        <!-- Footer -->
        <div class="footer">
            <span>${t.autoRefresh}: <span class="countdown-num" id="countdown">${ctx.secondsUntilRefresh}</span>s</span>
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

export function buildTrafficHtml(ctx: Pick<PanelContext, 't' | 'trafficStats' | 'sessionDuration'>, isLocal: boolean): string {
    const { t, trafficStats, sessionDuration } = ctx;

    if (isLocal) {
        return `
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><span class="card-title-icon">◈</span>${t.traffic}</span>
                </div>
                <div class="card-body">
                    <div class="traffic-unavailable">${t.remoteOnly}</div>
                </div>
            </div>`;
    }

    const barWidth = Math.min(trafficStats.activeConnections * 10, 100);

    return `
        <div class="card">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">◈</span>${t.traffic}</span>
            </div>
            <div class="card-body">
                <div class="traffic-stat">
                    <div class="traffic-label">${t.connections}</div>
                    <div class="traffic-value">${trafficStats.activeConnections}</div>
                    <div class="traffic-bar">
                        <div class="traffic-bar-fill" style="width: ${barWidth}%"></div>
                    </div>
                </div>
                <div class="traffic-stat">
                    <div class="traffic-label">${t.session}</div>
                    <div class="traffic-value small">${sessionDuration}</div>
                </div>
                <div class="traffic-stat">
                    <div class="traffic-label">${t.totalRequests}</div>
                    <div class="traffic-value small">${trafficStats.totalConnectionsSeen}</div>
                </div>
            </div>
        </div>`;
}

// ---------------------------------------------------------------------------
// Diagnostics HTML
// ---------------------------------------------------------------------------

function buildDiagnosticsHtml(ctx: PanelContext, isLocal: boolean): string {
    const { t, diagnosticReport } = ctx;

    const checks: DiagnosticCheck[] = diagnosticReport?.checks ?? [
        { id: 'local-proxy',           name: 'Local Proxy Service',     status: 'pending' },
        { id: 'ssh-config',            name: 'SSH Configuration',       status: 'pending' },
        { id: 'remote-forward',        name: 'Remote Port Forwarding',  status: 'pending' },
        { id: 'mgraftcp',              name: 'mgraftcp Binary',          status: 'pending' },
        { id: 'ls-wrapper',            name: 'Language Server Wrapper', status: 'pending' },
        { id: 'external-connectivity', name: 'External Connectivity',   status: 'pending' },
    ];

    return checks.map(check => {
        const isLocalCheck = ['local-proxy', 'ssh-config'].includes(check.id);
        const isDisabled = (isLocal && !isLocalCheck) || (!isLocal && isLocalCheck);

        const { statusText, statusClass } = resolveCheckStatus(check, isDisabled, isLocal, t);
        const message        = check.message;
        const suggestion     = check.suggestion;
        const protocolResults = check.protocolResults;
        const hasDetails     = !isDisabled && (message || suggestion || protocolResults);
        const protocolHtml   = buildProtocolListHtml(check, protocolResults);

        return `
            <div class="diag-item-wrapper">
                <div class="diag-item">
                    <div class="diag-dot ${isDisabled ? 'pending' : check.status}"></div>
                    <span class="diag-name ${isDisabled ? 'disabled' : ''}">${getDiagCheckName(check.id, t)}</span>
                    <span class="diag-status ${statusClass}">${statusText}</span>
                </div>
                ${hasDetails ? `
                <div class="diag-details">
                    ${protocolHtml}
                    ${message && !protocolResults ? `<div class="diag-message">${message}</div>` : ''}
                    ${suggestion ? `<div class="diag-suggestion">💡 ${suggestion}</div>` : ''}
                </div>` : ''}
            </div>`;
    }).join('');
}

function resolveCheckStatus(
    check: DiagnosticCheck,
    isDisabled: boolean,
    isLocal: boolean,
    t: Translations
): { statusText: string; statusClass: string } {
    if (isDisabled) {
        return { statusText: isLocal ? t.remoteOnly : t.localOnly, statusClass: 'muted' };
    }
    switch (check.status) {
        case 'success': return { statusText: '✓', statusClass: 'success' };
        case 'warning': return { statusText: '!', statusClass: 'warning' };
        case 'error':   return { statusText: '✗', statusClass: 'error' };
        case 'running': return { statusText: '...', statusClass: '' };
        default:        return { statusText: t.pending, statusClass: '' };
    }
}

function buildProtocolListHtml(check: DiagnosticCheck, protocolResults?: ProtocolTestResult[]): string {
    if (check.id !== 'external-connectivity' || !protocolResults?.length) { return ''; }

    const rows = protocolResults.map((result, index) => {
        const isLast  = index === protocolResults.length - 1;
        const prefix  = isLast ? '└──' : '├──';
        const icon    = result.success ? '✓' : '✗';
        const cls     = result.success ? 'success' : 'error';
        const label   = result.success ? 'Available' : 'Not working';
        const current = result.isCurrent ? ` ← Current` : '';
        return `
            <div class="protocol-item">
                <span class="protocol-prefix">${prefix}</span>
                <span class="protocol-name">${result.protocol.toUpperCase()}:</span>
                <span class="protocol-status ${cls}">${icon} ${label}</span>
                ${result.isCurrent ? `<span class="protocol-current">${current}</span>` : ''}
            </div>`;
    }).join('');

    return `<div class="protocol-list">${rows}</div>`;
}

function getDiagCheckName(id: string, t: Translations): string {
    const names: Record<string, string> = {
        'local-proxy':           t.localProxyService,
        'ssh-config':            t.sshConfig,
        'remote-forward':        t.remoteForward,
        'mgraftcp':              t.mgraftcp,
        'ls-wrapper':            t.lsWrapper,
        'external-connectivity': t.externalConn,
    };
    return names[id] ?? id;
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function buildTunnelAlert(t: Translations, status: ProxyStatus): string {
    return `
        <!-- Warning Alert: always in DOM for remote mode, visibility controlled by JS -->
        <div id="tunnel-alert" class="alert alert-warning" style="${!status.remoteProxyReachable ? '' : 'display:none;'}">
            <div class="alert-icon">⚠</div>
            <div class="alert-content">
                <div class="alert-title">${t.tunnelWarningTitle}</div>
                <div class="alert-message">${t.tunnelWarningMsg}</div>
                <div class="alert-steps">
                    <div class="alert-step"><span class="step-num">1</span>${t.tunnelStep1}</div>
                    <div class="alert-step"><span class="step-num">2</span>${t.tunnelStep2}</div>
                    <div class="alert-step"><span class="step-num">3</span>${t.tunnelStep3}</div>
                </div>
                <button class="btn btn-warning" onclick="closeRemote()">${t.closeRemote}</button>
            </div>
        </div>`;
}

function buildLocalConfigSection(ctx: PanelContext): string {
    const { status, t, enableForwarding } = ctx;
    return `
        <div class="row">
            <span class="row-label">${t.sshForwarding}</span>
            <span id="ssh-fwd-val" class="row-value ${status.sshConfigEnabled ? 'success' : 'error'}">${status.sshConfigEnabled ? t.on : t.off}</span>
        </div>
        <div class="row">
            <span class="row-label">${t.localProxy}</span>
            <span id="local-proxy-val" class="row-value ${status.localProxyReachable ? 'success' : 'error'}">${status.localProxyReachable ? t.reachable : t.unreachable}</span>
        </div>
        <div class="input-row">
            <label>${t.enableForwarding}</label>
            <label class="toggle">
                <input type="checkbox" id="enableForwarding" ${enableForwarding ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="input-row">
            <label>${t.localPort}</label>
            <input type="number" id="localProxyPort" value="${status.localProxyPort}" min="1" max="65535">
        </div>
        <div class="input-tip">${t.localPortTip}</div>
        <div class="input-row">
            <label>${t.remotePort}</label>
            <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
        </div>
        <div class="input-tip">${t.remotePortTipLocal}</div>`;
}

function buildRemoteConfigSection(ctx: PanelContext): string {
    const { status, t, proxyType } = ctx;
    return `
        <div class="row">
            <span class="row-label">${t.proxy}</span>
            <span id="remote-proxy-val" class="row-value ${status.remoteProxyReachable ? 'success' : 'error'}">${status.remoteProxyReachable ? t.reachable : t.unreachable}</span>
            <span id="remote-proxy-host-extra" class="row-extra">${status.remoteProxyHost}</span>
        </div>
        <div id="lang-server-row" class="row" style="${status.languageServerConfigured !== undefined ? '' : 'display:none;'}">
            <span class="row-label">${t.languageServer}</span>
            <span id="lang-server-val" class="row-value ${status.languageServerConfigured ? 'success' : 'error'}">${status.languageServerConfigured !== undefined ? (status.languageServerConfigured ? t.configured : t.notConfigured) : ''}</span>
        </div>
        <div class="input-row">
            <label>${t.proxyHost}</label>
            <input type="text" id="remoteProxyHost" value="${status.remoteProxyHost}">
        </div>
        <div class="input-row">
            <label>${t.proxyPort}</label>
            <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
        </div>
        <div class="input-tip">${t.remotePortTipRemote}</div>
        <div class="input-row">
            <label>${t.proxyType}</label>
            <select id="proxyType">
                <option value="http" ${proxyType === 'http' ? 'selected' : ''}>${t.proxyTypeHttp}</option>
                <option value="socks5" ${proxyType === 'socks5' ? 'selected' : ''}>${t.proxyTypeSocks5}</option>
            </select>
        </div>`;
}

function buildLocalTips(t: Translations): string {
    return `
        <div class="tip-title">${t.tipTitleLocal}</div>
        <ul class="tip-steps">
            <li class="tip-step"><span class="step-num">1</span><span>${t.tipStep1Local}</span></li>
            <li class="tip-step"><span class="step-num">2</span><span>${t.tipStep2Local}</span></li>
            <li class="tip-step"><span class="step-num">3</span><span>${t.tipStep3Local}</span></li>
            <li class="tip-step"><span class="step-num">4</span><span>${t.tipStep4Local}</span></li>
        </ul>
        <div class="tip-note"><strong>⚠</strong> ${t.tipNoteLocal}</div>`;
}

function buildRemoteTips(t: Translations): string {
    return `
        <div class="tip-title">${t.tipTitleRemote}</div>
        <ul class="tip-steps">
            <li class="tip-step"><span class="step-num">1</span><span>${t.tipStep1Remote}</span></li>
            <li class="tip-step"><span class="step-num">2</span><span>${t.tipStep2Remote}</span></li>
            <li class="tip-step"><span class="step-num">3</span><span>${t.tipStep3Remote}</span></li>
            <li class="tip-step"><span class="step-num">4</span><span>${t.tipStep4Remote}</span></li>
        </ul>
        <div class="tip-note">${t.tipNoteRemote}</div>
        <div style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed var(--border-color);">
            <div class="tip-title" style="color: var(--error); margin-bottom: 4px;">${t.rollbackTitle}</div>
            <div style="font-size: 10px; color: var(--text-muted);">${t.rollbackDesc}</div>
        </div>`;
}

// ---------------------------------------------------------------------------
// CSS — Static portion extracted as a constant to avoid re-generating on every render.
// Only --status-color is dynamic and injected via buildStyles().
// ---------------------------------------------------------------------------

const STATIC_CSS = `
        :root {
            --bg-primary: #0d0d0d;
            --bg-card: #1a1a1a;
            --border-color: #252525;
            --text-primary: #f0f0f0;
            --text-secondary: #666;
            --text-muted: #444;
            --accent: #888;
            --success: #22c55e;
            --error: #ef4444;
            --warning: #eab308;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            padding: 24px;
            font-size: 12px;
            line-height: 1.5;
        }

        .container { max-width: 720px; margin: 0 auto; }

        /* Header */
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
        }

        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 2px;
            background: var(--status-color);
            box-shadow: 0 0 12px color-mix(in srgb, var(--status-color) 38%, transparent);
        }

        .title { font-size: 14px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }

        .env-badge {
            font-size: 9px; font-weight: 600; padding: 3px 8px; border-radius: 2px;
            background: var(--border-color); color: var(--text-secondary);
            text-transform: uppercase; letter-spacing: 0.5px;
        }

        .status-badge {
            margin-left: auto; font-size: 10px; font-weight: 600;
            padding: 4px 10px; border-radius: 2px;
            background: color-mix(in srgb, var(--status-color) 8%, transparent);
            color: var(--status-color);
            text-transform: uppercase; letter-spacing: 0.5px;
        }

        .lang-toggle { display: flex; align-items: center; gap: 0; margin-left: 12px; }

        .lang-btn {
            padding: 4px 8px; font-size: 10px; font-weight: 600;
            background: transparent; border: 1px solid var(--border-color);
            color: var(--text-secondary); cursor: pointer; transition: all 0.15s; font-family: inherit;
        }
        .lang-btn:first-child { border-radius: 2px 0 0 2px; }
        .lang-btn:last-child  { border-radius: 0 2px 2px 0; border-left: none; }
        .lang-btn.active { background: var(--text-primary); color: var(--bg-primary); border-color: var(--text-primary); }

        /* Grid */
        .grid { display: grid; grid-template-columns: 1fr 200px; gap: 16px; margin-bottom: 16px; }
        .grid-full { grid-column: 1 / -1; }
        @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }

        /* Card */
        .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 4px; }

        .card-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary);
        }
        .card-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-secondary); }
        .card-title-icon { margin-right: 8px; opacity: 0.7; }
        .card-body { padding: 12px 16px; }

        /* Rows */
        .row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color); }
        .row:last-child { border-bottom: none; }
        .row-label { flex: 1; color: var(--text-secondary); font-size: 11px; }
        .row-value { font-weight: 600; font-size: 11px; }
        .row-value.success { color: var(--success); }
        .row-value.error   { color: var(--error); }
        .row-value.warning { color: var(--warning); }
        .row-value.muted   { color: var(--text-muted); }
        .row-extra { margin-left: 12px; color: var(--text-muted); font-size: 10px; font-family: 'JetBrains Mono', monospace; }

        /* Input rows */
        .input-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color); gap: 12px; }
        .input-row:last-child { border-bottom: none; }
        .input-row label { flex: 1; color: var(--text-secondary); font-size: 11px; }
        .input-row label.toggle { flex: none; }
        .input-row input[type="text"],
        .input-row input[type="number"] {
            width: 100px; padding: 6px 10px;
            border: 1px solid var(--border-color); border-radius: 2px;
            background: var(--bg-primary); color: var(--text-primary);
            font-family: inherit; font-size: 11px;
        }
        .input-row input:focus { outline: none; border-color: var(--accent); }
        .input-row select {
            width: 100px; padding: 6px 10px;
            border: 1px solid var(--border-color); border-radius: 2px;
            background: var(--bg-primary); color: var(--text-primary);
            font-family: inherit; font-size: 11px; cursor: pointer;
        }
        .input-row select:focus { outline: none; border-color: var(--accent); }

        /* Toggle switch */
        .toggle { position: relative; width: 32px; height: 16px; flex: none; }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-slider {
            position: absolute; cursor: pointer; inset: 0;
            background: var(--bg-primary); border: 1px solid var(--border-color);
            border-radius: 2px; transition: 0.2s;
        }
        .toggle-slider:before {
            position: absolute; content: ""; height: 10px; width: 10px;
            left: 2px; bottom: 2px; background: var(--text-secondary);
            border-radius: 1px; transition: 0.2s;
        }
        .toggle input:checked + .toggle-slider { background: var(--success); border-color: var(--success); }
        .toggle input:checked + .toggle-slider:before { transform: translateX(16px); background: var(--bg-primary); }

        /* Alert */
        .alert { display: flex; gap: 16px; padding: 16px; border-radius: 4px; border: 1px solid; margin-bottom: 16px; }
        .alert-warning {
            background: color-mix(in srgb, var(--status-color) 3%, transparent);
            border-color: color-mix(in srgb, var(--status-color) 25%, transparent);
        }
        .alert-icon { font-size: 18px; flex-shrink: 0; }
        .alert-content { flex: 1; }
        .alert-title { font-weight: 700; font-size: 12px; color: var(--warning); margin-bottom: 8px; }
        .alert-message { font-size: 11px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.6; }
        .alert-steps { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
        .alert-step { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-secondary); }
        .step-num {
            display: inline-flex; align-items: center; justify-content: center;
            width: 18px; height: 18px; border-radius: 2px;
            background: var(--warning); color: var(--bg-primary); font-size: 10px; font-weight: 700;
        }

        /* Diagnostics */
        .diag-item { display: flex; align-items: center; padding: 6px 0; gap: 10px; }
        .diag-dot { width: 6px; height: 6px; border-radius: 1px; flex-shrink: 0; }
        .diag-dot.pending { background: var(--text-muted); }
        .diag-dot.running { background: var(--warning); animation: pulse 1s infinite; }
        .diag-dot.success { background: var(--success); }
        .diag-dot.warning { background: var(--warning); }
        .diag-dot.error   { background: var(--error); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .diag-name { flex: 1; font-size: 11px; color: var(--text-secondary); }
        .diag-name.disabled { color: var(--text-muted); }
        .diag-status { font-size: 10px; color: var(--text-muted); }
        .diag-status.success { color: var(--success); }
        .diag-status.error   { color: var(--error); }
        .diag-status.warning { color: var(--warning); }
        .diag-item-wrapper { border-bottom: 1px solid var(--border-color); padding-bottom: 8px; margin-bottom: 8px; }
        .diag-item-wrapper:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
        .diag-details { margin-left: 16px; margin-top: 4px; padding-left: 10px; border-left: 2px solid var(--border-color); }
        .diag-message  { font-size: 10px; color: var(--text-secondary); line-height: 1.4; margin-bottom: 4px; }
        .diag-suggestion { font-size: 10px; color: var(--warning); line-height: 1.4; font-style: italic; }

        /* Protocol list */
        .protocol-list { margin-bottom: 6px; }
        .protocol-item { display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 1.8; }
        .protocol-prefix  { color: var(--text-muted); font-family: monospace; }
        .protocol-name    { color: var(--text-secondary); min-width: 55px; }
        .protocol-status  { font-weight: 600; }
        .protocol-status.success { color: var(--success); }
        .protocol-status.error   { color: var(--error); }
        .protocol-current { color: var(--text-muted); font-style: italic; }

        /* Traffic */
        .traffic-stat { padding: 8px 0; border-bottom: 1px solid var(--border-color); }
        .traffic-stat:last-child { border-bottom: none; }
        .traffic-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 4px; }
        .traffic-value { font-size: 18px; font-weight: 700; color: var(--text-primary); }
        .traffic-value.small { font-size: 12px; }
        .traffic-bar { display: flex; height: 4px; background: var(--bg-primary); border-radius: 2px; overflow: hidden; margin-top: 8px; }
        .traffic-bar-fill { background: var(--success); transition: width 0.3s; }
        .traffic-unavailable { color: var(--text-muted); font-size: 10px; text-align: center; padding: 20px; }

        /* Tips */
        .tip-content { font-size: 11px; color: var(--text-secondary); line-height: 1.7; }
        .tip-title { font-weight: 700; color: var(--text-primary); margin-bottom: 12px; font-size: 12px; }
        .tip-steps { list-style: none; padding: 0; margin: 0; }
        .tip-step { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
        .tip-step .step-num { background: var(--border-color); color: var(--text-secondary); margin-top: 2px; }
        .tip-note { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--border-color); font-size: 10px; color: var(--text-muted); }
        .tip-note strong { color: var(--warning); }

        /* Buttons */
        .actions { display: flex; gap: 8px; margin-top: 16px; }
        .btn {
            flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
            padding: 10px 16px; border: 1px solid var(--border-color); border-radius: 2px;
            background: var(--bg-card); color: var(--text-primary);
            font-size: 10px; font-weight: 600; font-family: inherit;
            text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; transition: all 0.15s;
        }
        .btn:hover { background: var(--border-color); }
        .btn-primary { background: var(--text-primary); color: var(--bg-primary); border-color: var(--text-primary); }
        .btn-primary:hover { background: var(--text-secondary); border-color: var(--text-secondary); }
        .btn-warning { background: var(--warning); color: var(--bg-primary); border-color: var(--warning); }
        .btn-warning:hover { opacity: 0.9; }
        .btn-sm { flex: none; padding: 6px 12px; font-size: 9px; }

        /* Input tip */
        .input-tip { font-size: 9.5px; color: var(--warning); margin-top: 3px; margin-bottom: 2px; line-height: 1.4; opacity: 0.85; }

        /* Footer */
        .footer {
            display: flex; align-items: center; justify-content: space-between;
            margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-color);
            font-size: 10px; color: var(--text-muted);
        }
        .countdown-num { font-weight: 600; color: var(--text-secondary); }
`;

function buildStyles(statusColor: string): string {
    return `:root { --status-color: ${statusColor}; }\n${STATIC_CSS}`;
}

// ---------------------------------------------------------------------------
// Client-side JavaScript (runs inside WebView, NOT in Node.js)
// ---------------------------------------------------------------------------

function buildClientScript(isLocal: boolean): string {
    return `
        const vscode = acquireVsCodeApi();
        const isLocal = ${isLocal};

        function refresh()  { vscode.postMessage({ command: 'refresh' }); }
        function rollback() { vscode.postMessage({ command: 'rollback' }); }

        function saveConfig() {
            const config = {};
            if (isLocal) {
                config.enableLocalForwarding = document.getElementById('enableForwarding').checked;
                config.localProxyPort  = parseInt(document.getElementById('localProxyPort').value);
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value);
            } else {
                config.remoteProxyHost = document.getElementById('remoteProxyHost').value;
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value);
                config.proxyType = document.getElementById('proxyType').value;
            }
            vscode.postMessage({ command: 'saveConfig', config });
        }

        function runDiagnostics() { vscode.postMessage({ command: 'runDiagnostics' }); }
        function copyReport()     { vscode.postMessage({ command: 'copyReport' }); }
        function setLang(lang)    { vscode.postMessage({ command: 'setLanguage', lang }); }

        function closeRemote() {
            vscode.postMessage({ command: 'closeRemote' });
        }

        window.addEventListener('message', event => {
            const message = event.data;

            if (message.command === 'updateCountdown') {
                const el = document.getElementById('countdown');
                if (el) el.textContent = message.seconds;
            }

            if (message.command === 'updateStatus') {
                const m = message;

                const dot = document.getElementById('status-dot');
                if (dot) {
                    dot.style.background  = m.statusColor;
                    dot.style.boxShadow   = '0 0 12px ' + m.statusColor + '60';
                }

                const badge = document.getElementById('status-badge-text');
                if (badge) {
                    badge.textContent     = m.statusText;
                    badge.style.color     = m.statusColor;
                    badge.style.background = m.statusColor + '15';
                }

                if (isLocal) {
                    const sshVal = document.getElementById('ssh-fwd-val');
                    if (sshVal) {
                        sshVal.textContent = m.sshConfigEnabled ? m.t.on : m.t.off;
                        sshVal.className   = 'row-value ' + (m.sshConfigEnabled ? 'success' : 'error');
                    }
                    const localVal = document.getElementById('local-proxy-val');
                    if (localVal) {
                        localVal.textContent = m.localProxyReachable ? m.t.reachable : m.t.unreachable;
                        localVal.className   = 'row-value ' + (m.localProxyReachable ? 'success' : 'error');
                    }
                } else {
                    const remoteVal = document.getElementById('remote-proxy-val');
                    if (remoteVal) {
                        remoteVal.textContent = m.remoteProxyReachable ? m.t.reachable : m.t.unreachable;
                        remoteVal.className   = 'row-value ' + (m.remoteProxyReachable ? 'success' : 'error');
                    }
                    const remoteHost = document.getElementById('remote-proxy-host-extra');
                    if (remoteHost) { remoteHost.textContent = m.remoteProxyHost; }

                    const lsRow = document.getElementById('lang-server-row');
                    if (lsRow) {
                        if (m.languageServerConfigured !== undefined) {
                            lsRow.style.display = '';
                            const lsVal = document.getElementById('lang-server-val');
                            if (lsVal) {
                                lsVal.textContent = m.languageServerConfigured ? m.t.configured : m.t.notConfigured;
                                lsVal.className   = 'row-value ' + (m.languageServerConfigured ? 'success' : 'error');
                            }
                        } else {
                            lsRow.style.display = 'none';
                        }
                    }

                    const tunnelAlert = document.getElementById('tunnel-alert');
                    if (tunnelAlert) {
                        tunnelAlert.style.display = m.remoteProxyReachable ? 'none' : 'flex';
                    }
                }

                const lastUpdated = document.getElementById('last-updated');
                if (lastUpdated) { lastUpdated.textContent = m.t.updated + ' ' + m.lastUpdated; }

                const trafficContainer = document.getElementById('traffic-container');
                if (trafficContainer && m.trafficHtml !== undefined) {
                    trafficContainer.innerHTML = m.trafficHtml;
                }
            }
        });
    `;
}
