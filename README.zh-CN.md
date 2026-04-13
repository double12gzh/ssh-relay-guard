**中文** | [English](README.md)

<p align="center">
  <img src="docs/srg-icon.png" alt="SRG Icon" width="160" />
</p>

# SSH Relay Guard (SRG)

**SSH Relay Guard** 是一个 Antigravity 扩展，用于管理 SSH 反向隧道，并将远程服务器的流量透明转发到本地代理 —— 绕过远端服务器上的网络限制和 DNS 污染。

> GitHub: [double12gzh/ssh-relay-guard](https://github.com/double12gzh/ssh-relay-guard)

---

## 功能特性

- 🔒 **SSH 反向隧道** — 自动在 `~/.ssh/config.srg` 中配置每个主机的 `RemoteForward` 和 `ControlMaster` 块。
- 🛡️ **语言服务代理** — 使用 `mgraftcp-fakedns` 包装远程语言服务二进制文件，实现透明进程级代理，绕过 DNS 污染。
- 📊 **状态仪表板** — 实时面板展示本地/远程代理健康状态、SSH 隧道状态和连接指标。
- 🔍 **健康检查** — 完整诊断套件：本地代理、SSH 配置、远程端口转发、二进制文件检查、外部连接和 DNS 污染检测。
- 📈 **流量监控** — 远程侧的实时连接数和会话统计。
- 🌐 **双语界面** — 支持中文和英文。

---

## 工作原理

![SRG 架构图](docs/srg-architecture.png)

1. **本地端**: 扩展在 `~/.ssh/config.srg` 中写入 SSH 配置块，将远程代理端口转发回本地代理。
2. **远程端**: 扩展为语言服务二进制文件安装包装脚本，强制其通过 `mgraftcp-fakedns` 代理。

📖 **[核心命令拆解 (Manual Reproduction Guide)](docs/how-it-works-manual.md)** — 详解插件在本地和远端分别执行了哪些操作，以及手动复现所需的最少命令和完整数据流图。

---

## 安装方式

SRG 采用**本地 + 远程双端部署**模式，两端各有分工：

![SRG 安装部署图](docs/srg-installation.png)

### 环境要求

- 本地已运行代理软件（Clash / V2Ray / 其他），且 Antigravity AI 功能**在本地可用**
- 远程为 Linux x86_64 服务器，可通过 SSH 连接

---

## 快速开始

**本地端**

1. 在本地 Antigravity 的扩展市场中搜索并安装 **SSH Relay Guard**
2. 打开设置，将 `localProxyPort` 设为你本地代理端口（默认 `7890`）
3. 运行命令 `SSH Relay Guard: Add Host Forwarding`，输入远程主机名（与 `~/.ssh/config` 中一致）

**远程端**

4. 使用 Antigravity 通过 SSH 连接远程服务器
5. 在远程的扩展列表中，再次安装 **SSH Relay Guard**
6. 根据提示重启远程窗口（可能需要多次重启）

**验证**

7. 打开 SRG 面板 → 运行「健康检查」→ 所有项目显示 ✅ 即表示配置成功

---

## 配置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| `ssh-relay-guard.enableLocalForwarding` | `true` | 启用 SSH 反向隧道管理 |
| `ssh-relay-guard.localProxyPort` | `7890` | 本地代理端口（如 Clash、V2Ray） |
| `ssh-relay-guard.remoteProxyPort` | `7890` | 远程代理端口（须与本地一致） |
| `ssh-relay-guard.remoteProxyHost` | `127.0.0.1` | 远程代理主机地址 |
| `ssh-relay-guard.proxyType` | `http` | 代理协议：`http` 或 `socks5` |
| `ssh-relay-guard.showStatusOnStartup` | `true` | 连接时显示状态通知 |

---

## 命令

| 命令 | 说明 |
|---|---|
| `SSH Relay Guard: Show Dashboard` | 打开状态仪表板 |
| `SSH Relay Guard: Add Host Forwarding` | 为指定主机配置 SSH 隧道 |
| `SSH Relay Guard: Remove Host Forwarding` | 移除指定主机的 SSH 隧道 |
| `SSH Relay Guard: Run Health Check` | 运行完整诊断报告 |
| `SSH Relay Guard: Setup Remote Environment` | 安装语言服务包装脚本 |
| `SSH Relay Guard: Rollback Remote Environment` | 恢复原始语言服务 |
| `SSH Relay Guard: Show Traffic Monitor` | 查看连接统计 |

---

## srg-cli（可选，独立工具）

> **srg-cli 不随插件安装**。它是一个独立的命令行工具，面向不使用 Antigravity 或需要在终端中管理多台远程主机的场景。
>
> 如果你只使用 Antigravity，**无需安装 srg-cli** —— 插件会通过 `Setup Remote Environment` 命令自动完成所有配置。

### 安装

```bash
# 克隆仓库
git clone https://github.com/double12gzh/ssh-relay-guard.git
cd ssh-relay-guard/srg-cli

# (可选) 编译 mgraftcp-fakedns 预编译二进制
# 需要 Linux 环境 + go, make, gcc
bash build-bin.sh

# 将 srg 加入 PATH
export PATH="$PWD:$PATH"
# 或创建符号链接
ln -s "$PWD/srg" /usr/local/bin/srg
```

### 使用

```bash
# 一次性配置远程主机
srg setup my-server

# 检查状态
srg status my-server

# 问题排查（本地+远程全面诊断）
srg doctor my-server

# 列出已配置的主机
srg list

# 完全卸载
srg teardown my-server
```

### 插件 vs srg-cli 对比

| 功能 | Antigravity 插件 | srg-cli |
|------|-------------|---------|
| SSH 隧道配置 | ✅ 自动 | ✅ `srg setup` |
| 语言服务代理 | ✅ 自动 | ✅ `srg setup` |
| 远程工具部署 (srg-on/off/...) | ✅ 自动（内嵌脚本）| ✅ `srg setup`（独立脚本文件）|
| 状态仪表板 | ✅ WebView 面板 | ✅ `srg status` / `srg tui` |
| 健康诊断 | ✅ 面板内运行 | ✅ `srg doctor` |
| 需要 Antigravity | ✅ 是 | ❌ 否 |
| 多主机管理 | ⚠️ 逐个窗口 | ✅ `srg list` 集中管理 |

### 远程命令（setup 后在远程可用）

| 命令 | 说明 |
|---|---|
| `srg-on` | 为当前 Shell 启用代理 |
| `srg-off` | 为当前 Shell 禁用代理 |
| `srg-shell` | 打开一个已启用代理的新 Shell |
| `srg-proxy <cmd>` | 通过透明代理运行单条命令 |
| `srg-status` | 显示当前代理状态 |

---

## SSH 配置格式

SRG 使用独立的 `~/.ssh/config.srg` 文件，通过主 SSH 配置文件 Include 引入：

```
# SSH Relay Guard — Tunnel & Proxy Config
# --- SRG:my-server ---
Host my-server
    RemoteForward 7890 127.0.0.1:7890
    ExitOnForwardFailure no
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 4h
# --- SRG:my-server END ---
```

---

## 卸载

卸载扩展时，会自动清理本地 SSH 配置（`~/.ssh/config.srg` 和 `~/.ssh/config` 中的 `Include` 行），无需手动 rollback。

远程残留物（LS wrapper、`~/bin/srg-*` 工具）可以安全保留 —— LS wrapper 内置 fallback 机制，找不到 `mgraftcp` 时会自动执行原始二进制文件。如需完全清理远程服务器，可在卸载前运行 `SSH Relay Guard: Rollback Remote Environment`。

---

## 许可证

MIT © [double12gzh](https://github.com/double12gzh)
