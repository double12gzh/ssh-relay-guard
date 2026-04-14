export function buildClientScript(isLocal: boolean): string {
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
                config.rewriteCloudCodeEndpoint = document.getElementById('rewriteCloudCodeEndpoint').checked;
            }
            vscode.postMessage({ command: 'saveConfig', config });
        }

        function runDiagnostics() { vscode.postMessage({ command: 'runDiagnostics' }); }
        function copyReport()     { vscode.postMessage({ command: 'copyReport' }); }
        function setLang(lang)    { vscode.postMessage({ command: 'setLanguage', lang }); }

        function closeRemote() {
            vscode.postMessage({ command: 'closeRemote' });
        }

        function fixDiag(action) {
            vscode.postMessage({ command: 'fixDiag', action: action });
        }

        function copyCmd(text) {
            vscode.postMessage({ command: 'copyCommand', text: text });
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
                        const proxyFunctional = m.remoteProxyFunctional;
                        remoteVal.textContent = proxyFunctional ? m.t.reachable : m.t.unreachable;
                        remoteVal.className   = 'stat-val ' + (proxyFunctional ? 'g' : (m.remoteProxyReachable ? 'a' : 'r'));
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
                        tunnelAlert.style.display = m.remoteProxyFunctional ? 'none' : 'flex';
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
