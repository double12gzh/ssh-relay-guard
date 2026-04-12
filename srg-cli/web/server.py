#!/usr/bin/env python3
"""
SRG Web Server — 轻量级本地管理 API
通过 HTTP 接口暴露 srg CLI 命令，供 Web 管理面板调用。

用法:
    python3 server.py [port]           # 默认端口 9876
    或: srg web [port]                 # 通过 srg 命令启动

仅监听 127.0.0.1，不暴露到外网。
"""

import http.server
import json
import os
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SRG_CLI = SCRIPT_DIR.parent / "srg"
WEB_DIR = SCRIPT_DIR
SSH_CONFIG_SRG = Path.home() / ".ssh" / "config.srg"
SSH_SOCKET_DIR = Path.home() / ".ssh" / "sockets"

DEFAULT_PORT = 9876


def run_srg(args: list[str], input_text: str = None) -> tuple[int, str]:
    """Run an srg CLI command and return (returncode, output)."""
    cmd = ["bash", str(SRG_CLI)] + args
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            input=input_text,
            env={**os.environ, "TERM": "dumb"},
        )
        output = result.stdout + result.stderr
        # Strip ANSI escape codes for clean JSON output
        output = re.sub(r'\033\[[0-9;]*m', '', output)
        return result.returncode, output
    except subprocess.TimeoutExpired:
        return 1, "命令超时 (120s)"
    except Exception as e:
        return 1, f"执行错误: {e}"


def get_hosts() -> list[dict]:
    """Parse config.srg to get list of configured hosts and their status."""
    hosts = []
    if not SSH_CONFIG_SRG.exists():
        return hosts

    content = SSH_CONFIG_SRG.read_text()
    # Find all host markers: # --- SRG:hostname ---
    pattern = r'^# --- SRG:(.*?) ---$'
    for match in re.finditer(pattern, content, re.MULTILINE):
        name = match.group(1)
        if name.endswith(' END'):
            continue

        # Extract port from the block
        block_pattern = rf'# --- SRG:{re.escape(name)} ---\n(.*?)# --- SRG:{re.escape(name)} END ---'
        block_match = re.search(block_pattern, content, re.DOTALL)
        port = "7890"
        if block_match:
            port_match = re.search(r'RemoteForward\s+(\d+)', block_match.group(1))
            if port_match:
                port = port_match.group(1)

        # Check ControlMaster socket status via ssh -O check
        status = "offline"
        try:
            res = subprocess.run(
                ["ssh", "-O", "check", "-o", "BatchMode=yes", "-o", "ConnectTimeout=2", name],
                capture_output=True,
                text=True,
                timeout=3
            )
            # ssh -O check prints "Master running (pid=xxxx)" to stderr on success
            stderr_output = res.stderr.lower() if res.stderr else ""
            if res.returncode == 0 and "running" in stderr_output:
                status = "connected"
        except Exception:
            pass

        hosts.append({
            "name": name,
            "port": port,
            "status": status,
        })

    return hosts


def get_ssh_hosts() -> list[dict]:
    """Scan SSH config files for known Host entries.

    Scans:
      - ~/.ssh/config (main config)
      - ~/.ssh/config.d/*.conf
      - ~/.ssh/conf.d/*.conf

    Returns a list of {name, hostname, source} dicts.
    Excludes wildcards (*, ?) and already-configured SRG hosts.
    """
    ssh_dir = Path.home() / ".ssh"
    hosts_found = []  # [(name, hostname, source)]
    seen = set()

    # Already configured SRG hosts
    srg_hosts = {h["name"] for h in get_hosts()}

    def parse_config(filepath: Path, source_label: str):
        if not filepath.exists():
            return
        try:
            lines = filepath.read_text().splitlines()
        except Exception:
            return

        current_host = None
        current_hostname = None

        for line in lines:
            stripped = line.strip()
            if stripped.startswith('#') or not stripped:
                # If we were tracking a host, save it before reset
                continue

            # Match "Host <name>" lines
            m = re.match(r'^Host\s+(.+)', stripped, re.IGNORECASE)
            if m:
                # Save previous host
                if current_host and current_host not in seen:
                    seen.add(current_host)
                    hosts_found.append({
                        "name": current_host,
                        "hostname": current_hostname or "",
                        "source": source_label,
                        "configured": current_host in srg_hosts,
                    })
                # Parse new host(s) — may have multiple on one line
                host_names = m.group(1).split()
                # Take first non-wildcard
                current_host = None
                current_hostname = None
                for h in host_names:
                    if '*' not in h and '?' not in h and h != '*':
                        current_host = h
                        break
                continue

            # Match "HostName <value>"
            m = re.match(r'^HostName\s+(.+)', stripped, re.IGNORECASE)
            if m and current_host:
                current_hostname = m.group(1).strip()

        # Don't forget last host
        if current_host and current_host not in seen:
            seen.add(current_host)
            hosts_found.append({
                "name": current_host,
                "hostname": current_hostname or "",
                "source": source_label,
                "configured": current_host in srg_hosts,
            })

    # 1. Main config
    parse_config(ssh_dir / "config", "~/.ssh/config")

    # 2. config.d/*.conf
    config_d = ssh_dir / "config.d"
    if config_d.is_dir():
        for f in sorted(config_d.glob("*.conf")):
            parse_config(f, f"config.d/{f.name}")

    # 3. conf.d/*.conf  (alternative naming)
    conf_d = ssh_dir / "conf.d"
    if conf_d.is_dir():
        for f in sorted(conf_d.glob("*.conf")):
            parse_config(f, f"conf.d/{f.name}")

    return hosts_found


class SRGHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for SRG Web API."""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')

        if path == '/api/hosts':
            self.json_response({"hosts": get_hosts()})

        elif path == '/api/ssh-hosts':
            self.json_response({"hosts": get_ssh_hosts()})

        elif path == '' or path == '/' or path == '/index.html':
            self.serve_file(WEB_DIR / 'index.html', 'text/html')

        elif path.startswith('/'):
            # Serve static files
            file_path = WEB_DIR / path.lstrip('/')
            if file_path.exists() and file_path.is_file():
                content_type = 'text/html'
                if path.endswith('.css'):
                    content_type = 'text/css'
                elif path.endswith('.js'):
                    content_type = 'application/javascript'
                self.serve_file(file_path, content_type)
            else:
                self.send_error(404)

        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')

        # Read request body
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length else '{}'
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {}

        if path == '/api/setup':
            host = data.get('host', '')
            port = data.get('port', '7890')
            if not host:
                self.json_response({"success": False, "output": "缺少主机名"}, 400)
                return
            rc, output = run_srg(["setup", host, port])
            self.json_response({"success": rc == 0, "output": output})

        elif path == '/api/status':
            host = data.get('host', '')
            if not host:
                self.json_response({"success": False, "output": "缺少主机名"}, 400)
                return
            rc, output = run_srg(["status", host])
            self.json_response({"success": rc == 0, "output": output})

        elif path == '/api/doctor':
            host = data.get('host', '')
            if not host:
                self.json_response({"success": False, "output": "缺少主机名"}, 400)
                return
            rc, output = run_srg(["doctor", host])
            self.json_response({"success": rc == 0, "output": output})

        elif path == '/api/teardown':
            host = data.get('host', '')
            if not host:
                self.json_response({"success": False, "output": "缺少主机名"}, 400)
                return
            rc, output = run_srg(["teardown", host], input_text="y\n")
            self.json_response({"success": rc == 0, "output": output})

        else:
            self.send_error(404)

    def json_response(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, filepath: Path, content_type: str):
        try:
            content = filepath.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', f'{content_type}; charset=utf-8')
            self.send_header('Content-Length', len(content))
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_error(500)

    def log_message(self, format, *args):
        # Cleaner log format
        print(f"  {self.address_string()} - {format % args}")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

    server = http.server.HTTPServer(('127.0.0.1', port), SRGHandler)

    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║       SRG — Web 管理面板                      ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()
    print(f"  🌐 http://127.0.0.1:{port}")
    print(f"  📁 {WEB_DIR}")
    print()
    print("  仅监听 127.0.0.1，不暴露到外网")
    print("  按 Ctrl+C 停止")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
        server.server_close()


if __name__ == '__main__':
    main()
