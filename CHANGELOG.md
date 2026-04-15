# Change Log

All notable changes to "SSH Relay Guard" will be documented in this file.

## 【0.0.2】 - 2026-04-16

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
