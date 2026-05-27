# Change Log

All notable changes to "SSH Relay Guard" will be documented in this file.

## [0.1.0] - 2026-05-27

### Added

- **Session-Isolated Dynamic Port Fallback**: Implemented an elegant port lookup fallback to bypass IDE Server parent-child process environment variable isolation. The remote extension dynamically writes the active port to `~/.srg/port_<session_key>` (based on `VSCODE_IPC_HOOK_CLI` or SSH connection variables), and the Language Server wrapper `ls-wrapper.sh` automatically reads from this file as a fallback. This guarantees conflict-free isolation even when multiple developers share the exact same Linux system account.
- **Clean State Directory**: All transient session port files are organized inside a unified `~/.srg/` folder, maintaining a spotless home directory.

### Fixed

- **SSH Auto-Reconnection Port Escalation**: Fixed a critical bug in the Go tunnel daemon (`srg-tunnel-client`) where all exit code 255 connection errors (e.g. network drops, DNS timeouts) were incorrectly treated as port binding conflicts. The daemon now reads `stderr` to explicitly match `"port forwarding failed"` or `"forwarding failed"` to confirm actual port conflicts. This ensures that network disconnections retry and reconnect on the same base port, allowing remote VS Code connections to recover seamlessly without manual command execution or window reloads.

## [0.0.9] - 2026-05-24

### Added

- **Enhanced Remote Debug Logging**: Added detailed logging to the remote LS wrapper script (`/tmp/srg-ls-wrapper-*.log`) to aid in diagnosing remote startup failures.
- **Wrapper Logging Commands**: Added `Show Logs`, `Show Wrapper Path`, and `Show Remote Config` commands to the Command Palette for easier remote debugging.

### Fixed

- **No Proxy Environment Injection**: Added explicit `unset HTTP_PROXY HTTPS_PROXY` and `export NO_PROXY="localhost,..."` at the start of the remote wrapper script. This prevents double-proxying loops and ensures the Language Server doesn't try to connect through a proxy when `mgraftcp` is already intercepting syscalls.
- **Wrapper Path Discovery**: Added robust detection for the VS Code Server's extension directory path (`$HOME/.antigravity-ide-server/...`) to ensure `mgraftcp-fakedns` is found even when the extension path is not explicitly provided.

## [0.0.8] - 2026-05-21

### Fixed
- **Proxy Detection under pgrep**: Fixed a critical bug where `getMonitoredProcess` would fail to recognize that the Language Server was using the proxy wrapper because `pgrep` returned output without the word `mgraftcp` (only showing the `.bak` binary). This led to the extension repeatedly killing the Language Server in a loop via SIGTERM (Signal 15). Resolves the "Language server exited before sending start data" issue during startup.
- **Global Proxy Default**: Disabled writing `http.proxy` into `settings.json` by default to avoid multi-user conflicts, relying strictly on robust process-level environment variable injection.

## [0.0.7] - 2026-05-20

### Added
- **Support for New Antigravity IDE Server**: Added support for `.antigravity-ide-server` in the extension's health checks, diagnostics, deployment wrapper scripts, and srg-cli commands.

## [0.0.6] - 2026-04-27

### Added
- **Standalone Tunnel Daemon (Go)**: Introduced `srg-tunnel-client`, a standalone Go-based daemon to completely replace the Node.js `child_process` SSH management. This ensures absolute process stability and decoupled lifecycle management.
- **Smart Port Retries & Keep-Alive**: The new Go client natively handles automatic SSH tunnel reconnection, state monitoring, and incremental port binding retries (up to 10 attempts) if the target port is occupied.
- **Cross-Platform Binaries**: Added automated build pipelines (`build-tunnel-client.sh`) supporting amd64 and arm64 architectures across Darwin, Linux, and Windows.

### Changed
- **Core Architecture Refactoring**: Completely overhauled the `src/core` directory. Decoupled logic by introducing `modeController` (for separated Local/Remote mode handling), `stateManager` (global state management), and `remoteProcessService`, significantly improving maintainability.
- **Build System Upgrades**: Updated `package.json` to automatically trigger the Go client cross-platform compilation (`build:binaries`) before building the extension package.

### Fixed
- **Deep Proxy Protocol Detection**: Replaced simple TCP port scanning with robust SOCKS5/HTTP protocol handshakes (`isProxyFunctional`) to accurately detect dynamic tunnel ports. This eliminates critical false-positives where unrelated background services (like Node.js debuggers) occupying ephemeral ports would hijack the language server configuration.
- **Multi-Window State Desync**: Fixed an edge-case bug where VS Code global configuration updates were skipped during local tunnel reconnections if the port matched local records. This ensures that concurrent multi-host sessions properly trigger remote synchronization events, preventing remote webviews and wrapper scripts from being permanently stuck on stale ports.
- **Per-Host State Isolation**: Fully decoupled remote port tracking in the UI and state manager. Dynamic port auto-negotiation (e.g., 7890 -> 7891) for one host now strictly isolates its UI and script updates without polluting or breaking the connection configuration of other concurrent remote sessions.

## [0.0.5] - 2026-04-25

### Fixed

- **ControlMaster conflict**: SRG tunnels now use a dedicated `srg-tunnel-` ControlPath prefix, preventing collisions with existing SSH sessions from WezTerm or other terminals
- **Reconnect killing other tunnels**: `cleanOrphanedProcesses` now matches both port signature AND hostname, so reconnecting one host no longer kills other hosts' tunnels
- **Silent autossh failures**: Capture stderr from autossh process (was `stdio:'ignore'`) to surface actual SSH errors like "Address already in use" in logs
- **Stale socket cleanup**: `cleanRemotePort` now uses `ControlPath=none` to avoid hanging on stale ControlMaster sockets
- **Race condition**: Extended port-release sleep from 500ms → 1500ms to let OS fully release resources
- **Health check timeout**: Extended poll window from 15s/200ms → 30s/500ms for slower network environments
- **SSH command port mismatch**: Copy commands now correctly use `remotePort:127.0.0.1:localPort` instead of using remotePort for both sides
- **`<hostname>` invisible in WebView**: HTML-escaped to `<your-host>` so it renders correctly instead of being swallowed as an HTML tag
- **Misleading error message**: Replaced "Ensure SSH key auth is configured" with actionable message listing common failure causes, added "Show Logs" button

### Added

- **Reconnect Tunnel command**: Manual tunnel re-establishment via Command Palette without disabling/enabling the plugin
- **Real-time status bar monitor**: Remote mode now checks proxy every 5 seconds and updates the status bar immediately on state transitions (was 30-second delay)
- **Cross-environment command stubs**: Running local-only commands from remote (or vice versa) now shows a friendly warning instead of "command not found"
- **Autossh debug command**: Tunnel alert panel now shows both basic `ssh` and `autossh` commands (with `AUTOSSH_LOGFILE` / `AUTOSSH_DEBUG=1`) for easier troubleshooting

### Changed

- Renamed "重试检测 / Retry" button to "刷新状态 / Refresh Status" to clearly distinguish quick status refresh from full diagnostics

## [0.0.4] -2026-04-22

- Enhance ssh tunnel manager

## [0.0.3] - 2026-04-16

- First release to OVSX

## [0.0.2] - 2026-04-16

- Add publish command

## [0.0.1] - 2026-04-11

### Added

- Initial release of SSH Relay Guard (SRG).
- SSH reverse tunnel management via `~/.ssh/config.srg` with per-host blocks.
- ControlMaster support for persistent SSH connections.
- Status dashboard with real-time proxy health monitoring.
- Remote Language Server wrapper via `mgraftcp-fakedns` for transparent proxy.
- DNS pollution detection and bypass.
- Diagnostic health check with full report.
- Traffic monitor for active proxy connections.
- `srg-cli` command-line tool for headless setup and management.
- Supports x86_64 and ARM64 Linux remote servers.
- Bilingual UI (Chinese / English).
