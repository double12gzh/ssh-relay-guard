# SSH Relay Guard — 核心命令拆解

插件的本质：**在本地建立 SSH 反向隧道，在远端用 wrapper 拦截 Language Server 并透过隧道走代理**。

---

## 📍 本地 (Local) 做的事情

插件在本地只做了 **2 件事**：

### 1. 写 SSH 配置（自动 RemoteForward）

```bash
# 创建 ~/.ssh/config.srg，写入 per-host 隧道配置
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

# 在 ~/.ssh/config 末尾追加 Include
echo 'Include config.srg' >> ~/.ssh/config
```

### 2. 建立 SSH 隧道

```bash
# 建立后台 SSH 连接，开启反向端口转发
ssh -fN -R 7890:127.0.0.1:7890 my-server
```

> [!NOTE]
> 这里 `7890` 是你本地代理软件（Clash/V2Ray 等）监听的端口。`-R` 把远端的 `7890` 映射回本地的 `7890`，这样远端访问 `127.0.0.1:7890` 就等于访问你本地的代理。

---

## 📍 远端 (Remote) 做的事情

插件在远端做了 **3 件核心事**：

### 1. 替换 Language Server 为 Wrapper（最关键）

```bash
# 找到 Language Server 原始二进制
LS=~/.antigravity-server/bin/xxx/language_server_linux_x64

# 备份原始二进制
mv "$LS" "${LS}.bak"

# 创建 wrapper 脚本（用 mgraftcp 透明代理）
cat > "$LS" << 'EOF'
#!/bin/bash
PROXY_ADDR="127.0.0.1:7890"
MGRAFTCP="/path/to/mgraftcp-fakedns-linux-amd64"
exec "$MGRAFTCP" --http_proxy "$PROXY_ADDR" "$(dirname $0)/$(basename $0).bak" "$@"
EOF
chmod +x "$LS"
```

> [!IMPORTANT]
> 这是整个插件的核心操作。`mgraftcp-fakedns` 是一个透明代理工具（类似 `proxychains`，但通过 `LD_PRELOAD` + Fake DNS 实现），它让 Language Server 的**所有网络请求**（包括 DNS 解析）强制走代理，无需 LS 本身支持代理设置。

### 2. 设置 VS Code 的 http.proxy

```bash
# 等价于在远端 VS Code settings.json 中设置：
# "http.proxy": "http://127.0.0.1:7890"
# "http.proxyStrictSSL": false
```

这一步让 VS Code 自身的 HTTP 请求（扩展市场、插件更新等）也走代理。

### 3. 部署便捷工具到 ~/bin/

```bash
# 这些是方便终端使用的辅助工具，非核心但很实用：
# srg-on     → source 方式设 HTTP_PROXY 等环境变量
# srg-off    → unset 代理环境变量
# srg-proxy  → 用 mgraftcp 透明代理单个命令（如 srg-proxy curl google.com）
# srg-status → 检查隧道/代理/LS 状态
# srg-shell  → 开一个带代理的子 shell
```

---

## 🔑 手动复现的最少命令

如果要手动完成插件所做的一切，**最少只需 3 条命令**：

### 本地执行 1 条：

```bash
# ① 建立反向隧道（本地代理端口 7890）
ssh -fN -R 7890:127.0.0.1:7890 my-server
```

### 远端执行 2 条：

```bash
# 找到 language_server_linux_x64
find ~/.antigravity-server -type f -name "language_server_linux_*"

# ② 备份原始 LS
# 安全检查：确保目标是 ELF 二进制，而不是已有的 wrapper 脚本
# 如果误把 wrapper 备份为 .bak，原始二进制就永久丢失了！
LS=~/.antigravity-server/bin/xxx/language_server_linux_x64
if head -1 "$LS" | grep -q "^#!/bin/bash"; then
    echo "⚠ 目标已经是脚本（可能是 wrapper），跳过备份"
else
    mv "$LS" "${LS}.bak"   # mv 不会触发 "Text file busy"，即使 LS 正在运行也安全
fi

# ③ 创建 wrapper
cat > ~/.antigravity-server/bin/xxx/language_server_linux_x64 << 'WRAP'
#!/bin/bash
# 强制 Go 程序使用 cgo DNS 解析器，使 LD_PRELOAD 劫持生效
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
> `/path/to/mgraftcp-fakedns-linux-amd64` 是插件自带的二进制，位于扩展目录的 `resources/bin/` 下。
> 同目录还有 `libdnsredir-linux-amd64.so`，由 `mgraftcp-fakedns` 在运行时自动通过 `LD_PRELOAD` 加载，无需手动指定。

> [!WARNING]
> `GODEBUG=netdns=cgo` 这行**不能省略**。Go 默认用纯 Go DNS 解析器（绕过 glibc），不加这行的话 `libdnsredir.so` 的 `LD_PRELOAD` 劫持对 Go 写的 Language Server 无效，DNS 请求会泄漏到本地被污染的 DNS。

---

## 📊 数据流全景

```
┌─────────────────────────┐         SSH Tunnel (-R)        ┌──────────────────────────────┐
│      LOCAL MACHINE       │ ◄─────────────────────────────► │       REMOTE SERVER           │
│                          │                                │                              │
│  Clash/V2Ray (:7890)     │                                │  127.0.0.1:7890 ──→ tunnel   │
│       ▲                  │                                │       ▲                      │
│       │ 本地代理          │                                │       │ TCP 转发              │
│       │                  │                                │  mgraftcp-fakedns            │
│  正常上网（含真实DNS）    │                                │       ▲                      │
│                          │                                │       │ LD_PRELOAD            │
│                          │                                │  libdnsredir.so              │
│                          │                                │  (劫持 getaddrinfo → FakeDNS) │
│                          │                                │       ▲                      │
│                          │                                │       │ GODEBUG=netdns=cgo   │
│                          │                                │  LS Wrapper (替换原始 LS)     │
│                          │                                │       ▲                      │
│                          │                                │       │                      │
│                          │                                │  VS Code / Cursor / etc.     │
└─────────────────────────┘                                └──────────────────────────────┘
```

### 各组件职责

| 组件 | 类型 | 职责 |
|------|------|------|
| `ssh -R` | SSH 隧道 | 将远端端口映射回本地代理 |
| LS Wrapper | Bash 脚本 | 替换原始 LS 二进制，注入 `GODEBUG` 并用 `mgraftcp` 启动 |
| `mgraftcp-fakedns` | ELF 二进制 | 透明 TCP 代理 + 内置 Fake DNS 服务器 |
| `libdnsredir.so` | 共享库 | `LD_PRELOAD` 劫持 `getaddrinfo` 等 DNS 函数，重定向到 Fake DNS |
| `GODEBUG=netdns=cgo` | 环境变量 | 强制 Go 程序用 glibc DNS（使 `LD_PRELOAD` 劫持生效） |

**一句话总结**：本地开隧道，远端换 wrapper，DNS + TCP 全部绕回本地代理出去。
