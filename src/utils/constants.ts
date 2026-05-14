/**
 * Shared constants used across the SSH Relay Guard extension.
 *
 * Shell scripts (setup-proxy.sh, ls-wrapper.sh) duplicate these values
 * because they cannot import TypeScript modules. When updating this list,
 * also update the shell-side definitions and add a comment pointing here.
 */

/**
 * Known IDE server directory names on the remote Linux host.
 * Each IDE stores its server runtime under `~/<dir>/`.
 */
export const IDE_SERVER_DIRS = [
	'.antigravity-server',
	'.vscode-server',
	'.cursor-server',
	'.windsurf-server',
] as const;
