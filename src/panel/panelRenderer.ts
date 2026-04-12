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
    t: Pick<Translations, 'connected' | 'partial' | 'disconnected' | 'notSetup'>
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
    return status.remoteProxyReachable
        ? { color: '#34d399', text: t.connected }
        : { color: '#f87171', text: t.disconnected };
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

export function buildTrafficHtml(ctx: Pick<PanelContext, 't' | 'trafficStats' | 'sessionDuration' | 'status'>, isLocal: boolean): string {
    const { t, trafficStats, sessionDuration, status } = ctx;

    if (isLocal) {
        const hosts = status.configuredHosts ?? [];
        const hostListHtml = hosts.length > 0
            ? hosts.map(h => `
                <div class="host-row">
                    <div class="host-dot"></div>
                    <span class="host-name">${h}</span>
                    <span class="host-port">:${status.remoteProxyPort}</span>
                </div>`).join('')
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
            sshClass = 'g'; sshText = t.on;
        } else if (status.hasConfiguredHosts === false) {
            sshClass = 'a'; sshText = t.notSetup;
        } else {
            sshClass = 'r'; sshText = t.off;
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

    const proxyClass = status.remoteProxyReachable ? 'g' : 'r';
    const proxyText = status.remoteProxyReachable ? t.reachable : t.unreachable;
    const lsConfigured = status.languageServerConfigured;
    const lsClass = lsConfigured ? 'g' : 'r';
    const lsText = lsConfigured !== undefined
        ? (lsConfigured ? t.configured : t.notConfigured)
        : '';

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
        { id: 'local-proxy',           name: 'Local Proxy Service',     status: 'pending' },
        { id: 'ssh-config',            name: 'SSH Configuration',       status: 'pending' },
        { id: 'remote-forward',        name: 'Remote Port Forwarding',  status: 'pending' },
        { id: 'mgraftcp',              name: 'mgraftcp Binary',          status: 'pending' },
        { id: 'ls-wrapper',            name: 'Language Server Wrapper', status: 'pending' },
        { id: 'external-connectivity', name: 'External Connectivity',   status: 'pending' },
    ];

    // Filter: only show checks relevant to the current environment
    const LOCAL_CHECK_IDS = ['local-proxy', 'ssh-config'];
    const relevantChecks = checks.filter(check => {
        const isLocalCheck = LOCAL_CHECK_IDS.includes(check.id);
        return isLocal ? isLocalCheck : !isLocalCheck;
    });

    return relevantChecks.map(check => {
        const { statusText, statusClass } = resolveCheckStatus(check, false, isLocal, t);
        const message        = check.message;
        const suggestion     = check.suggestion;
        const protocolResults = check.protocolResults;
        const hasDetails     = message || suggestion || protocolResults;
        const protocolHtml   = buildProtocolListHtml(check, protocolResults);
        const dotClass       = STATUS_TO_DOT[check.status] ?? 'p';

        return `
            <div class="diag-wrap">
                <div class="diag">
                    <div class="diag-d ${dotClass}"></div>
                    <span class="diag-n">${getDiagCheckName(check.id, t)}</span>
                    <span class="diag-s ${statusClass}">${statusText}</span>
                </div>
                ${hasDetails ? `
                <div class="diag-detail">
                    ${protocolHtml}
                    ${message && !protocolResults ? `<div class="diag-msg">${message}</div>` : ''}
                    ${suggestion ? `<div class="diag-tip">💡 ${suggestion}</div>` : ''}
                </div>` : ''}
            </div>`;
    }).join('');
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
    t: Translations
): { statusText: string; statusClass: string } {
    if (isDisabled) {
        return { statusText: isLocal ? t.remoteOnly : t.localOnly, statusClass: '' };
    }
    switch (check.status) {
        case 'success': return { statusText: '✓', statusClass: 's' };
        case 'warning': return { statusText: '!', statusClass: 'w' };
        case 'error':   return { statusText: '✗', statusClass: 'e' };
        case 'running': return { statusText: '...', statusClass: '' };
        default:        return { statusText: t.pending, statusClass: '' };
    }
}

function buildProtocolListHtml(check: DiagnosticCheck, protocolResults?: ProtocolTestResult[]): string {
    if (check.id !== 'external-connectivity' || !protocolResults?.length) { return ''; }

    const rows = protocolResults.map((result, index) => {
        const isLast  = index === protocolResults.length - 1;
        const prefix  = isLast ? '└─' : '├─';
        const icon    = result.success ? '✓' : '✗';
        const cls     = result.success ? 'g' : 'r';
        const label   = result.success ? 'OK' : 'Blocked';
        const current = result.isCurrent ? ` ← Current` : '';
        return `
            <div class="proto-row">
                <span class="proto-pre">${prefix}</span>
                <span class="proto-name">${result.protocol.toUpperCase()}</span>
                <span class="proto-st ${cls}">${icon} ${label}</span>
                ${result.isCurrent ? `<span class="proto-cur">${current}</span>` : ''}
            </div>`;
    }).join('');

    return `<div class="proto-list">${rows}</div>`;
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
        <div id="tunnel-alert" class="alert-banner" style="${!status.remoteProxyReachable ? '' : 'display:none;'}">
            <div class="alert-ico">⚠</div>
            <div class="alert-body">
                <h4>${t.tunnelWarningTitle}</h4>
                <p>${t.tunnelWarningMsg}</p>
                <div class="alert-steps">
                    <div class="step-item"><span class="step-n step-n-warn">1</span>${t.tunnelStep1}</div>
                    <div class="step-item"><span class="step-n step-n-warn">2</span>${t.tunnelStep2}</div>
                    <div class="step-item"><span class="step-n step-n-warn">3</span>${t.tunnelStep3}</div>
                </div>
                <button class="ab ab-warn" onclick="closeRemote()">${t.closeRemote}</button>
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
        </div>`;
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

const STATIC_CSS = `
        :root {
            --bg: #0e1525;
            --bg-elevated: #151d2e;
            --bg-card: rgba(21, 29, 46, 0.85);
            --bg-input: #0c1220;
            --border: rgba(255,255,255,0.06);
            --border-focus: rgba(99,179,237,0.45);
            --text: #cdd5e0;
            --text-dim: #6b7b95;
            --text-label: #8a9ab5;
            --accent: #63b3ed;
            --accent-soft: rgba(99,179,237,0.12);
            --green: #34d399;
            --green-soft: rgba(52,211,153,0.12);
            --red: #f87171;
            --red-soft: rgba(248,113,113,0.12);
            --amber: #fbbf24;
            --amber-soft: rgba(251,191,36,0.12);
            --radius: 10px;
            --radius-sm: 6px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            font-size: 13px;
            line-height: 1.5;
            padding: 16px;
            min-height: 100vh;
        }

        .root { max-width: 680px; margin: 0 auto; }

        /* Topbar */
        .topbar {
            display: flex; align-items: center; gap: 12px;
            margin-bottom: 16px;
        }
        .topbar-dot {
            width: 10px; height: 10px; border-radius: 50%;
            background: var(--status-color);
            box-shadow: 0 0 8px var(--status-color);
            animation: pulse 2.4s ease-in-out infinite;
        }
        @keyframes pulse {
            0%,100% { box-shadow: 0 0 6px var(--status-color); }
            50% { box-shadow: 0 0 14px var(--status-color), 0 0 24px color-mix(in srgb, var(--status-color) 20%, transparent); }
        }
        .topbar-title { font-size: 14px; font-weight: 700; color: #fff; letter-spacing: 0.2px; }
        .topbar-pill {
            font-size: 9px; font-weight: 700; text-transform: uppercase;
            letter-spacing: 1.2px; padding: 2px 8px; border-radius: 4px;
        }
        .pill-env { background: var(--accent-soft); color: var(--accent); }
        .pill-status {
            background: color-mix(in srgb, var(--status-color) 14%, transparent);
            color: var(--status-color);
        }
        .topbar-spacer { flex: 1; }

        /* Language switch */
        .lang-sw { display: flex; gap: 1px; }
        .lang-sw button {
            padding: 3px 9px; font: 600 10px/1 inherit;
            background: transparent; border: 1px solid var(--border);
            color: var(--text-dim); cursor: pointer; transition: all .15s;
        }
        .lang-sw button:first-child { border-radius: 5px 0 0 5px; }
        .lang-sw button:last-child  { border-radius: 0 5px 5px 0; border-left: 0; }
        .lang-sw button:hover { color: var(--text-label); border-color: rgba(255,255,255,0.1); }
        .lang-sw button.on { background: var(--accent); color: #fff; border-color: var(--accent); }

        /* Quick stat strip */
        .stats-strip { display: flex; gap: 8px; margin-bottom: 16px; }
        .stat-chip {
            flex: 1; display: flex; align-items: center; gap: 8px;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: var(--radius); padding: 10px 14px;
            transition: border-color .2s;
        }
        .stat-chip:hover { border-color: rgba(255,255,255,0.1); }
        .stat-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .stat-dot.g { background: var(--green); box-shadow: 0 0 5px var(--green-soft); }
        .stat-dot.r { background: var(--red); box-shadow: 0 0 5px var(--red-soft); }
        .stat-dot.a { background: var(--amber); box-shadow: 0 0 5px var(--amber-soft); }
        .stat-label { font-size: 11px; color: var(--text-dim); flex: 1; }
        .stat-val { font-size: 11px; font-weight: 600; }
        .stat-val.g { color: var(--green); }
        .stat-val.r { color: var(--red); }
        .stat-val.a { color: var(--amber); }

        /* Section / Card */
        .section { margin-bottom: 14px; }
        .section-head {
            display: flex; align-items: center; justify-content: space-between;
            padding: 9px 14px;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-bottom: none;
            border-radius: var(--radius) var(--radius) 0 0;
        }
        .section-label {
            font-size: 10px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 1px;
            color: var(--text-dim);
        }
        .section-actions { display: flex; gap: 4px; }
        .section-body {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-top: none;
            border-radius: 0 0 var(--radius) var(--radius);
            padding: 12px 14px;
        }

        /* Property rows */
        .prop {
            display: flex; align-items: center; min-height: 34px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .prop:last-child { border-bottom: none; }
        .prop-k { flex: 1; font-size: 12px; color: var(--text-label); }
        .prop-v { font-size: 12px; font-weight: 600; }
        .prop-v.g { color: var(--green); }
        .prop-v.r { color: var(--red); }
        .prop-extra {
            margin-left: 6px; font-size: 10px; color: var(--text-dim);
            font-family: 'SF Mono', Menlo, monospace;
            background: var(--bg-input); padding: 1px 6px; border-radius: 4px;
        }
        .prop input[type="number"],
        .prop input[type="text"] {
            width: 100px; padding: 5px 10px;
            background: var(--bg-input); border: 1px solid var(--border);
            border-radius: var(--radius-sm); color: var(--text);
            font: 12px 'SF Mono', Menlo, monospace;
            transition: border-color .15s, box-shadow .15s;
        }
        .prop input:focus {
            outline: none; border-color: var(--border-focus);
            box-shadow: 0 0 0 2px var(--accent-soft);
        }
        .prop select {
            width: 100px; padding: 5px 10px;
            background: var(--bg-input); border: 1px solid var(--border);
            border-radius: var(--radius-sm); color: var(--text);
            font: 12px inherit; cursor: pointer;
            transition: border-color .15s;
        }
        .prop select:focus { outline: none; border-color: var(--border-focus); }
        .hint { font-size: 10px; color: var(--text-label); opacity: .75; padding: 2px 0 4px; }

        /* Toggle switch */
        .sw { position: relative; width: 34px; height: 18px; }
        .sw input { opacity: 0; width: 0; height: 0; }
        .sw-track {
            position: absolute; inset: 0; cursor: pointer;
            background: rgba(255,255,255,0.08); border-radius: 9px;
            transition: .2s;
        }
        .sw-track::after {
            content: ''; position: absolute;
            width: 14px; height: 14px; left: 2px; top: 2px;
            background: var(--text-dim); border-radius: 50%; transition: .2s;
        }
        .sw input:checked + .sw-track { background: var(--green); }
        .sw input:checked + .sw-track::after { transform: translateX(16px); background: #fff; }

        /* Alert banner */
        .alert-banner {
            display: flex; gap: 12px; padding: 12px 14px;
            border-radius: var(--radius); margin-bottom: 14px;
            background: var(--amber-soft); border: 1px solid rgba(251,191,36,0.18);
        }
        .alert-ico { font-size: 16px; flex-shrink: 0; }
        .alert-body { flex: 1; }
        .alert-body h4 { font-size: 12px; font-weight: 700; color: var(--amber); margin-bottom: 4px; }
        .alert-body p { font-size: 11px; color: var(--text-label); margin-bottom: 8px; line-height: 1.5; }
        .alert-steps { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }

        /* Diagnostics */
        .diag-wrap {
            border-bottom: 1px solid rgba(255,255,255,0.03);
            padding-bottom: 2px; margin-bottom: 2px;
        }
        .diag-wrap:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
        .diag {
            display: flex; align-items: center; gap: 10px;
            min-height: 32px;
        }
        .diag-d { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .diag-d.s { background: var(--green); }
        .diag-d.w { background: var(--amber); }
        .diag-d.e { background: var(--red); }
        .diag-d.p { background: var(--text-dim); }
        .diag-d.run { background: var(--amber); animation: diagPulse 1.2s ease-in-out infinite; }
        @keyframes diagPulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.7); }
        }
        .diag-n { flex: 1; font-size: 12px; color: var(--text-label); }
        .diag-s { font-size: 11px; font-weight: 600; color: var(--text-dim); }
        .diag-s.s { color: var(--green); }
        .diag-s.w { color: var(--amber); }
        .diag-s.e { color: var(--red); }
        .diag-detail {
            margin: 4px 0 6px 16px; padding-left: 10px;
            border-left: 2px solid rgba(99,179,237,0.15);
        }
        .diag-msg { font-size: 10px; color: var(--text-label); line-height: 1.5; margin-bottom: 4px; }
        .diag-tip {
            font-size: 10px; color: var(--amber); line-height: 1.4;
            background: var(--amber-soft); padding: 4px 8px;
            border-radius: var(--radius-sm); margin-top: 4px;
        }

        /* Protocol list */
        .proto-list { margin-bottom: 4px; }
        .proto-row { display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 1.8; }
        .proto-pre { color: var(--text-dim); font-family: monospace; }
        .proto-name { color: var(--text-label); min-width: 48px; font-weight: 500; }
        .proto-st { font-weight: 600; }
        .proto-st.g { color: var(--green); }
        .proto-st.r { color: var(--red); }
        .proto-cur { color: var(--accent); font-size: 9px; font-weight: 600; }

        /* Traffic */
        .traffic-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
        .t-cell { text-align: center; }
        .t-cell-label {
            font-size: 9px; text-transform: uppercase; letter-spacing: .8px;
            color: var(--text-dim); font-weight: 600; margin-bottom: 4px;
        }
        .t-cell-val { font-size: 22px; font-weight: 800; color: #fff; }
        .t-cell-val.sm { font-size: 14px; font-weight: 600; }
        .t-unavail { color: var(--text-dim); font-size: 11px; text-align: center; padding: 8px; font-style: italic; }

        /* Host list (local panel) */
        .host-row {
            display: flex; align-items: center; gap: 10px;
            padding: 7px 0;
            border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .host-row:last-child { border-bottom: none; }
        .host-dot {
            width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
            background: var(--accent); box-shadow: 0 0 5px var(--accent-soft);
        }
        .host-name { font-size: 12px; font-weight: 600; color: #fff; flex: 1; }
        .host-port {
            font-size: 10px; color: var(--text-dim);
            font-family: 'SF Mono', Menlo, monospace;
            background: var(--bg-input); padding: 1px 6px; border-radius: 4px;
        }

        /* Tips */
        .tip-content { font-size: 12px; color: var(--text-label); line-height: 1.5; }
        .tips-title { font-size: 12px; font-weight: 700; color: #fff; margin-bottom: 10px; }
        .step-list { list-style: none; }
        .step-item {
            display: flex; align-items: flex-start; gap: 10px;
            padding: 4px 0; font-size: 12px; color: var(--text-label);
        }
        .step-n {
            display: inline-flex; align-items: center; justify-content: center;
            width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
            font-size: 9px; font-weight: 700; margin-top: 1px;
            background: var(--accent-soft); color: var(--accent);
        }
        .step-n-warn { background: var(--amber); color: var(--bg); }
        .note-box {
            margin-top: 10px; padding: 8px 10px; border-radius: var(--radius-sm);
            background: var(--amber-soft); font-size: 10px; color: var(--text-label);
            border: 1px solid rgba(251,191,36,0.1);
        }
        .note-box b { color: var(--amber); }
        .warn-block { margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.06); }
        .warn-block p { font-size: 10px; color: var(--text-dim); }

        /* Bottom grid */
        .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 0; }
        @media (max-width: 580px) { .bottom-grid { grid-template-columns: 1fr; } }

        /* Action buttons */
        .action-bar { display: flex; gap: 8px; margin-top: 14px; }
        .ab {
            flex: 1; display: flex; align-items: center; justify-content: center;
            padding: 9px; border-radius: var(--radius-sm);
            font: 600 11px/1 inherit; cursor: pointer;
            text-transform: uppercase; letter-spacing: .4px;
            transition: all .2s;
        }
        .ab-ghost {
            background: transparent; border: 1px solid var(--border);
            color: var(--text-dim);
        }
        .ab-ghost:hover {
            border-color: rgba(255,255,255,0.12); color: var(--text);
            background: rgba(255,255,255,0.03);
        }
        .ab-primary {
            background: var(--accent); border: none; color: #fff;
            box-shadow: 0 1px 8px rgba(99,179,237,0.25);
        }
        .ab-primary:hover {
            background: #5ba8db; box-shadow: 0 2px 14px rgba(99,179,237,0.35);
            transform: translateY(-1px);
        }
        .ab:active { transform: translateY(0) !important; }
        .ab-sm { flex: none; padding: 5px 10px; font-size: 9px; border-radius: 4px; }
        .ab:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }
        .ab-warn { background: var(--amber); color: var(--bg); border: none; font-weight: 700; }

        /* Footer */
        .foot {
            display: flex; justify-content: space-between;
            margin-top: 14px; padding: 8px 0;
            font-size: 10px; color: var(--text-dim);
            border-top: 1px solid var(--border);
        }
        .foot-accent { color: var(--accent); font-weight: 700; font-family: 'SF Mono', Menlo, monospace; }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
        ::selection { background: var(--accent-soft); color: var(--accent); }
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
                    dot.style.boxShadow   = '0 0 8px ' + m.statusColor;
                }

                const badge = document.getElementById('status-badge-text');
                if (badge) {
                    badge.textContent     = m.statusText;
                    badge.style.color     = m.statusColor;
                    badge.style.background = 'color-mix(in srgb, ' + m.statusColor + ' 14%, transparent)';
                }

                if (isLocal) {
                    const sshVal = document.getElementById('ssh-fwd-val');
                    if (sshVal) {
                        sshVal.textContent = m.sshConfigEnabled ? m.t.on : m.t.off;
                        sshVal.className   = 'stat-val ' + (m.sshConfigEnabled ? 'g' : 'r');
                    }
                    const localVal = document.getElementById('local-proxy-val');
                    if (localVal) {
                        localVal.textContent = m.localProxyReachable ? m.t.reachable : m.t.unreachable;
                        localVal.className   = 'stat-val ' + (m.localProxyReachable ? 'g' : 'r');
                    }
                } else {
                    const remoteVal = document.getElementById('remote-proxy-val');
                    if (remoteVal) {
                        remoteVal.textContent = m.remoteProxyReachable ? m.t.reachable : m.t.unreachable;
                        remoteVal.className   = 'stat-val ' + (m.remoteProxyReachable ? 'g' : 'r');
                    }

                    const lsRow = document.getElementById('lang-server-row');
                    if (lsRow) {
                        if (m.languageServerConfigured !== undefined) {
                            lsRow.style.display = '';
                            const lsVal = document.getElementById('lang-server-val');
                            if (lsVal) {
                                lsVal.textContent = m.languageServerConfigured ? m.t.configured : m.t.notConfigured;
                                lsVal.className   = 'stat-val ' + (m.languageServerConfigured ? 'g' : 'r');
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
