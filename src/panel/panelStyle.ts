export const STATIC_CSS = `
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
        .alert-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

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
        .diag-tip-row {
            display: flex; align-items: flex-start; gap: 8px; margin-top: 4px;
        }
        .diag-tip-row .diag-tip { flex: 1; margin-top: 0; }
        .ab-fix {
            font-size: 10px !important; padding: 2px 8px !important;
            white-space: nowrap; flex-shrink: 0;
            background: var(--amber) !important; color: #1a1a2e !important;
            border: none !important; font-weight: 700 !important;
        }
        .ab-fix:hover { opacity: 0.85; }

        /* Tunnel command block */
        .tunnel-cmd-wrap {
            margin-top: 10px; padding: 8px 10px;
            background: rgba(0,0,0,0.25); border-radius: var(--radius-sm);
            border: 1px solid rgba(255,255,255,0.06);
        }
        .tunnel-cmd-label { font-size: 10px; color: var(--text-dim); margin-bottom: 4px; }
        .tunnel-cmd-row { display: flex; align-items: center; gap: 8px; }
        .tunnel-cmd-code {
            flex: 1; font-family: 'SF Mono', Menlo, monospace;
            font-size: 11px; color: var(--amber); word-break: break-all;
        }
        .tunnel-cmd-row .ab-fix { margin: 0; }

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
        .ab-alert-btn {
            padding: 7px 16px !important; font-size: 11px !important;
            border-radius: var(--radius-sm) !important;
            background: var(--amber); color: var(--bg); border: none;
            font-weight: 700; flex: none;
        }
        .ab-alert-btn:hover { opacity: 0.85; }
        .ab-alert-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .ab-alert-ghost {
            background: transparent !important; color: var(--text-dim) !important;
            border: 1px solid var(--border) !important;
        }
        .ab-alert-ghost:hover {
            border-color: rgba(255,255,255,0.12) !important;
            color: var(--text) !important;
            background: rgba(255,255,255,0.03) !important;
        }

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
