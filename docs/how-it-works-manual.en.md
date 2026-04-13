# SSH Relay Guard — How It Works (Manual Reproduction)

**[中文版](how-it-works-manual.md)** | English

At its core, SRG does one thing: **establishes an SSH reverse tunnel from local to remote, then wraps the Language Server to route all its traffic through that tunnel back to your local proxy**.

---

## 📍 What Happens on the Local Machine

The extension does **2 things** locally:

### 1. Write SSH Config (Automatic RemoteForward)

```bash
# Create ~/.ssh/config.srg with per-host tunnel configuration
cat >> ~/.ssh/config.srg << 'EOF'
# --- SRG:my-server ---
Host my-server
    RemoteForward 7890 127.0.0.1:7890
    ExitOnForwardFailure no
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 4h
# --- SRG:my-server END ---
EOF

# Append Include to ~/.ssh/config
echo 'Include config.srg' >> ~/.ssh/config
```

### 2. Establish SSH Tunnel

```bash
# Start a background SSH connection with reverse port forwarding
ssh -fN -R 7890:127.0.0.1:7890 my-server
```

> [!NOTE]
> Here `7890` is the port your local proxy software (Clash/V2Ray/etc.) listens on. `-R` maps the remote `7890` back to local `7890`, so accessing `127.0.0.1:7890` on the remote machine is equivalent to reaching your local proxy.

---

## 📍 What Happens on the Remote Machine

The extension does **3 core things** remotely:

### 1. Replace Language Server with Wrapper (The Key Operation)

```bash
# Find the original Language Server binary
LS=~/.antigravity-server/bin/xxx/language_server_linux_x64

# Back up the original binary
mv "$LS" "${LS}.bak"

# Create wrapper script (transparent proxy via mgraftcp)
cat > "$LS" << 'EOF'
#!/bin/bash
PROXY_ADDR="127.0.0.1:7890"
MGRAFTCP="/path/to/mgraftcp-fakedns-linux-amd64"
exec "$MGRAFTCP" --http_proxy "$PROXY_ADDR" "$(dirname $0)/$(basename $0).bak" "$@"
EOF
chmod +x "$LS"
```

> [!IMPORTANT]
> This is the core operation of the entire extension. `mgraftcp-fakedns` is a transparent proxy tool (similar to `proxychains`, but using `LD_PRELOAD` + Fake DNS). It forces **all network requests** from the Language Server — including DNS resolution — through the proxy, without requiring the LS itself to support proxy settings.

### 2. Set VS Code's http.proxy

```bash
# Equivalent to adding these to remote VS Code settings.json:
# "http.proxy": "http://127.0.0.1:7890"
# "http.proxyStrictSSL": false
```

This ensures VS Code's own HTTP requests (extension marketplace, updates, etc.) also go through the proxy.

### 3. Deploy Convenience Tools to ~/bin/

```bash
# These are helper tools for terminal use — not core, but very useful:
# srg-on     → Sets HTTP_PROXY and related env vars via source
# srg-off    → Unsets proxy env vars
# srg-proxy  → Transparent proxy for a single command (e.g., srg-proxy curl google.com)
# srg-status → Check tunnel/proxy/LS status
# srg-shell  → Open a sub-shell with proxy enabled
```

---

## 🔑 Minimal Commands for Manual Reproduction

To manually replicate everything the extension does, you need **only 3 commands**:

### On the local machine (1 command):

```bash
# ① Establish reverse tunnel (local proxy port 7890)
ssh -fN -R 7890:127.0.0.1:7890 my-server
```

### On the remote machine (2 commands):

```bash
# Find language_server_linux_x64
find ~/.antigravity-server -type f -name "language_server_linux_*"

# ② Back up the original LS
# Safety check: ensure the target is an ELF binary, not an existing wrapper script
# If you accidentally back up a wrapper as .bak, the original binary is permanently lost!
LS=~/.antigravity-server/bin/xxx/language_server_linux_x64
if head -1 "$LS" | grep -q "^#!/bin/bash"; then
    echo "⚠ Target is already a script (likely a wrapper), skipping backup"
else
    mv "$LS" "${LS}.bak"   # mv won't trigger "Text file busy", safe even while LS is running
fi

# ③ Create wrapper
cat > ~/.antigravity-server/bin/xxx/language_server_linux_x64 << 'WRAP'
#!/bin/bash
# Force Go programs to use cgo DNS resolver, enabling LD_PRELOAD hijack
export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

exec /path/to/mgraftcp-fakedns-linux-amd64 \
  --http_proxy "127.0.0.1:7890" \
  "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
WRAP
chmod +x ~/.antigravity-server/bin/xxx/language_server_linux_x64
```

> [!TIP]
> `/path/to/mgraftcp-fakedns-linux-amd64` is the binary bundled with the extension, located under `resources/bin/` in the extension directory.
> The same directory also contains `libdnsredir-linux-amd64.so`, which `mgraftcp-fakedns` automatically loads at runtime via `LD_PRELOAD` — no manual configuration needed.

> [!WARNING]
> The `GODEBUG=netdns=cgo` line **must not be omitted**. Go uses a pure-Go DNS resolver by default (bypassing glibc). Without this flag, `libdnsredir.so`'s `LD_PRELOAD` hijack won't work for Go-based Language Servers, and DNS queries will leak to the polluted local DNS.

---

## 📊 Data Flow Overview

```
┌─────────────────────────┐         SSH Tunnel (-R)        ┌──────────────────────────────┐
│      LOCAL MACHINE       │ ◄─────────────────────────────► │       REMOTE SERVER           │
│                          │                                │                              │
│  Clash/V2Ray (:7890)     │                                │  127.0.0.1:7890 ──→ tunnel   │
│       ▲                  │                                │       ▲                      │
│       │ Local proxy      │                                │       │ TCP forwarding        │
│       │                  │                                │  mgraftcp-fakedns            │
│  Internet (clean DNS)    │                                │       ▲                      │
│                          │                                │       │ LD_PRELOAD            │
│                          │                                │  libdnsredir.so              │
│                          │                                │  (hijack getaddrinfo→FakeDNS)│
│                          │                                │       ▲                      │
│                          │                                │       │ GODEBUG=netdns=cgo   │
│                          │                                │  LS Wrapper (replaces LS)    │
│                          │                                │       ▲                      │
│                          │                                │       │                      │
│                          │                                │  VS Code / Cursor / etc.     │
└─────────────────────────┘                                └──────────────────────────────┘
```

### Component Responsibilities

| Component | Type | Responsibility |
|-----------|------|----------------|
| `ssh -R` | SSH tunnel | Maps the remote port back to the local proxy |
| LS Wrapper | Bash script | Replaces the original LS binary, injects `GODEBUG`, and launches via `mgraftcp` |
| `mgraftcp-fakedns` | ELF binary | Transparent TCP proxy + built-in Fake DNS server |
| `libdnsredir.so` | Shared library | `LD_PRELOAD` hijacks `getaddrinfo` and other DNS functions, redirecting to Fake DNS |
| `GODEBUG=netdns=cgo` | Env variable | Forces Go programs to use glibc DNS (enabling `LD_PRELOAD` hijack) |

**In one sentence**: Local opens tunnel, remote swaps wrapper, all DNS + TCP traffic routes back through local proxy.
