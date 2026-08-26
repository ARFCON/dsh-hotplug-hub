> 面向 AI 编程协作者：开始任何工作前，请先阅读本目录的 `AI_AGENTS.md`，并遵循其中的同步/检查/上报流程。

<p align="center">
  <img src="https://img.shields.io/badge/version-v1.0.4-6c5ce7" alt="version" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2d3436" alt="platform" />
  <img src="https://img.shields.io/badge/license-MIT-00b894" alt="license" />
  <img src="https://img.shields.io/badge/stack-WebView2%20%2B%20C%23%20WinForms-0984e3" alt="stack" />
</p>

<div align="center">
  <a href="#english">🇬🇧 English</a> · <a href="#简体中文">🇨🇳 简体中文</a>
</div>

---

<a id="english"></a>

# Dseam World — DSH-Hotplug-Hub

**DSH-Hotplug-Hub** is the plugin manager for **Dseam World** — a Windows desktop application (WebView2 + C# WinForms) that manages DSH plugins, Skills, and MCP servers, with global memory. It works **alongside** DSH Desktop, without touching the DSH Desktop installation directory, by installing everything into the unified official profile at `~/.dsh/profiles/web`.

## About

A hot-plug package manager for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). It introduces the concept of a **hotpack** — a versioned, portable bundle of plugins that can be imported, activated, deactivated, or removed without modifying the host. Built on the same mechanism as [dsh-hub](https://github.com/ARFCON/dsh-hub-DSH): `typert` Remote API + web page + atomic profile writes + `link` assembly.

## Current Version

| | |
|---|---|
| **Release** | **v1.0.4** |
| Releases page | <https://github.com/ARFCON/dsh-hotplug-hub/releases/tag/v1.0.4> |
| Windows installer | `DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe` |
| Windows portable | `DSH-Hotplug-Hub-win-x64-portable-v1.0.4.zip` |
| Linux installer | `DSH-Hotplug-Hub-linux-x64-setup-v1.0.4.sh` |
| Linux portable | `DSH-Hotplug-Hub-linux-x64-portable-v1.0.4.tar.gz` |
| macOS installer | `DSH-Hotplug-Hub-macos-x64-setup-v1.0.4.command` |
| macOS portable | `DSH-Hotplug-Hub-macos-x64-portable-v1.0.4.zip` |

## Key Features

- **Plugin management** — install / disable / uninstall plugins and plugin bundles.
- **Skill management** — scan a fixed source directory (default `%APPDATA%\reasonix\skills`, overridable via `DSH_SKILL_SOURCE_DIR`) for all `SKILL.md` files, then install / disable with a single click. Backed by the `dseam-skillmcp` CLI.
- **MCP management** — add / remove / disable `STDIO` and `streamable-http` MCP servers, written uniformly into the `dseam-skillmcp` manager module.
- **Global memory** — view / edit / delete entries per project via the built-in memory feature. When the AI needs key information (preferences / rules / constraints / notes / memories / project goals), it triggers the memory prompt and never lets the AI edit or delete memories on its own.
- **Bundled Skill/MCP manager** — `dseam-skillmcp` (derived from `dsh-skill-mcp-panel`, MIT), shipped with installer / EXE, auto-installed into the profile; no separate download needed.
- **Version consistency** — `dseam-skillmcp` and `dsh-hub` are embedded in the installer / portable app and updated atomically with each release; no repeated downloads.
- **Tray resident** — close to system tray; background processes keep running; double-clicking the icon reopens the existing window.
- **Self-check & self-heal** — on startup, auto-checks Node / pnpm / profile / plugins / config; auto-installs or repairs the environment if needed.

## The 5 Tabs

| Tab | Description |
|---|---|
| **Plugin management** | Import hotpack JSON (paste or pick a file), preview, download, activate / deactivate / remove, show store state. |
| **Plugin market** | Real GitHub market by topic tags; one-click install of entries. |
| **AI assembler** | Conversational assembly (persona switch + natural language) driven by real LLMs (DeepSeek / OpenCode / OpenRouter / Sensetime / Moonshot / Zhipu / MiniMax, OpenAI-compatible endpoints); validates hotpack manifest + README, writes a hotpack JSON in one click. |
| **Global memory** | Show the `~/.dsh/memory` global-memory directory path and store entry count. |
| **Self-check** | Run `check()` remote service; show Node/pnpm versions, profile state, patch state, plugin conflicts, pack/store state. |

## Installation

### Option 1 — Installer (recommended)

1. Download `DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe` from the Releases page.
2. Double-click and choose an install location (default `%LOCALAPPDATA%\Programs\DseamWorld`).
3. The installer auto-creates desktop / start-menu shortcuts and launches when finished.

Silent install:

```powershell
DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe --silent
DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe --silent --dir "D:\MyApps\DseamWorld"
```

### Option 2 — Portable

- **Windows**: unzip `DSH-Hotplug-Hub-win-x64-portable-v1.0.4.zip`, then double-click `DSH-Hotplug-Hub.exe` (WebView2 runtime DLLs are included in the same directory).
- **Linux**: `tar -xzf DSH-Hotplug-Hub-linux-x64-portable-v1.0.4.tar.gz`, then run `./dsh-hotplug-hub`.
- **macOS**: unzip `DSH-Hotplug-Hub-macos-x64-portable-v1.0.4.zip`, then double-click `Start-DSH-Hotplug-Hub.command`.

### Option 3 — From source

Requires Node.js 18+ (LTS recommended), pnpm, and the `dsh` CLI.

```bash
./install.sh          # auto-detect desktop / web / headless profile
./install.sh web      # target a specific profile
```

## hotpack Format

```json
{
  "hotpack": "1.0",
  "id": "pack.research",
  "name": "Research hotpack",
  "version": "1.0.0",
  "description": "Literature + mind-map + note sync",
  "tags": ["research", "study"],
  "plugins": [
    { "id": "literature", "name": "@dsh-community/dsh-tool-literature", "version": "1.2.3", "source": { "type": "npm" } },
    { "id": "mine", "name": "my-plugin", "source": { "type": "path", "path": "~/dev/my-plugin" } },
    { "id": "team", "name": "team-tool", "source": { "type": "github", "repo": "owner/team-tool", "ref": "v1.0.0" } }
  ]
}
```

Supported sources:

- `npm` — exact version required; `pnpm add --save-exact` into the profile, shared pnpm global store.
- `path` — link a local directory directly (same as `graph-memory`); supports `~` and `$DSH_HOME` expansion.
- `github` — zip → `~/.dsh/hotplug-store/<name>@<ref>` → link; official codeload first, then `ghfast.top` / `gh-proxy` / `ghproxy` mirrors.

## Directory Structure

```text
dsh-hotplug-hub-test/              # repo root
├── packages/shared-core/          # shared core: contracts / types / shared logic
├── release/                       # build EXE, installer, WebView2 DLLs, embedded C# contracts
├── scripts/                       # team scripts: sync / check / test / install
├── launcher/                      # Node CLI: assemble / check / launch / heal / status
├── dsh-hotplug-hub/               # hotplug-hub plugin + dsh-pack-hub
├── vendor/dseam-skillmcp/         # Skill/MCP manager source (MIT)
├── installer/                     # historical installer factories
├── uninstaller/                   # uninstaller factories
├── assembly/                      # assembly packs (hotpack 1.0, dshpack single-entry)
├── sandbox/                       # temporary profile sandboxes
├── 开发文档/                       # team docs & conventions
├── README.md                      # this file
└── LICENSE                        # MIT License
```

## Development

```powershell
# Before editing — sync the repo
pwsh -File scripts/sync-repo.ps1

# Before committing — full checks
pwsh -File scripts/check-before-upload.ps1

# After each change — record to global memory
pwsh -File scripts/remember-doc.ps1 -DocPath README.md
```

Team conventions live in `AI_AGENTS.md` and `开发文档/团队/`.

## Changelog

Full change history: [`开发文档/开发历史.md`](开发文档/开发历史.md)

## License

[MIT](LICENSE)

---

<a id="简体中文"></a>

# Dseam 世界（DSH-Hotplug-Hub）

**DSH-Hotplug-Hub** 是 **Dseam 世界** 的插件管理器——一款 Windows 桌面应用（WebView2 + C# WinForms），用于管理 DSH 的插件、Skill 与 MCP 服务器，并提供全局记忆。它与 DSH Desktop **并存运行**，不改动 DSH Desktop 安装目录，而是把所有内容统一安装到官方 profile `~/.dsh/profiles/web`，随 DSH 自行加载。

## 关于（About）

面向 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的热插拔包管理器。核心概念是 **hotpack**——一个带版本、可移植的插件集合，可以导入、激活、停用、移除，全程不动宿主。与 [dsh-hub](https://github.com/ARFCON/dsh-hub-DSH) 共用同一套机制：`typert` Remote API + 网页 + profile 原子写入 + `link` 装配。

## 当前版本

| | |
|---|---|
| **正式版** | **v1.0.4** |
| 发布页 | <https://github.com/ARFCON/dsh-hotplug-hub/releases/tag/v1.0.4> |
| Windows 安装版 | `DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe` |
| Windows 便携版 | `DSH-Hotplug-Hub-win-x64-portable-v1.0.4.zip` |
| Linux 安装版 | `DSH-Hotplug-Hub-linux-x64-setup-v1.0.4.sh` |
| Linux 便携版 | `DSH-Hotplug-Hub-linux-x64-portable-v1.0.4.tar.gz` |
| macOS 安装版 | `DSH-Hotplug-Hub-macos-x64-setup-v1.0.4.command` |
| macOS 便携版 | `DSH-Hotplug-Hub-macos-x64-portable-v1.0.4.zip` |

## 主要功能

- **插件管理**——安装 / 停用 / 卸载插件与插件集合。
- **Skill 管理**——扫描固定源目录（默认 `%APPDATA%\reasonix\skills`，可用 `DSH_SKILL_SOURCE_DIR` 覆盖）下的所有 `SKILL.md`，一键安装 / 停用；由 `dseam-skillmcp` CLI 支撑。
- **MCP 管理**——支持 `STDIO` 与 `streamable-http` 两类 MCP 服务器的添加 / 删除 / 停用，统一写入 `dseam-skillmcp` 管理模块。
- **全局记忆**——通过内置记忆功能按项目查看 / 编辑 / 删除条目；当 AI 需要关键信息（偏好 / 规则 / 约束 / 备注 / 记忆 / 项目目标）时触发记忆提示，且**不允许 AI 自行修改 / 删除记忆**。
- **内置 Skill/MCP 管理器**——`dseam-skillmcp`（源自 `dsh-skill-mcp-panel`，MIT License），随安装包 / EXE 内置，自动装入 profile，无需单独下载。
- **版本一致**——`dseam-skillmcp`、`dsh-hub` 已内嵌进安装包 / 便携包，每次发版同步更新，无需重复下载。
- **托盘常驻**——关闭后最小化到系统托盘，后台进程继续运行；重复打开只唤起已有窗口。
- **自检自愈**——启动时自动自检（Node / pnpm / profile / 插件 / 配置），自动安装或修复运行环境。

## 五大页面标签

| 标签 | 说明 |
|---|---|
| **插件管理** | 导入 hotpack JSON（粘贴或选文件），预览 / 下载，激活 / 停用 / 移除，展示 store 状态。 |
| **插件市场** | 按 topic 标签抓取真实 GitHub 市场，一键安装条目。 |
| **AI 装配员** | 对话式装配（人设切换 + 自然语言），由真实 LLM 驱动（DeepSeek / OpenCode / OpenRouter / 商汤 / Moonshot / 智谱 / MiniMax，OpenAI 兼容端点）；校验 hotpack manifest + README，一键产出 hotpack JSON。 |
| **全局记忆** | 展示 `~/.dsh/memory` 全局记忆目录路径与 store 条目数。 |
| **自检诊断** | 运行 `check()` 远程服务，展示 Node/pnpm 版本、profile 状态、patch 状态、插件冲突、pack/store 状态。 |

## 安装

### 方式一：安装包（推荐）

1. 在 Release 页面下载 `DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe`。
2. 双击运行，选择安装位置（默认 `%LOCALAPPDATA%\Programs\DseamWorld`）。
3. 安装包自动创建桌面 / 开始菜单快捷方式，完成后直接启动。

静默安装：

```powershell
DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe --silent
DSH-Hotplug-Hub-win-x64-setup-v1.0.4.exe --silent --dir "D:\MyApps\DseamWorld"
```

### 方式二：便携版

- **Windows**：解压 `DSH-Hotplug-Hub-win-x64-portable-v1.0.4.zip`，双击 `DSH-Hotplug-Hub.exe`（WebView2 运行时 DLL 已内置同目录）。
- **Linux**：`tar -xzf DSH-Hotplug-Hub-linux-x64-portable-v1.0.4.tar.gz`，运行 `./dsh-hotplug-hub`。
- **macOS**：解压 `DSH-Hotplug-Hub-macos-x64-portable-v1.0.4.zip`，双击 `Start-DSH-Hotplug-Hub.command`。

### 方式三：源码安装

前置依赖：Node.js 18+（推荐 LTS）、pnpm、`dsh` CLI。

```bash
./install.sh          # 自动探测 desktop / web / headless profile
./install.sh web      # 指定 profile
```

## hotpack 格式

```json
{
  "hotpack": "1.0",
  "id": "pack.research",
  "name": "科研热插拔包",
  "version": "1.0.0",
  "description": "文献 + 思维导图 + 笔记同步",
  "tags": ["科研", "学习"],
  "plugins": [
    { "id": "literature", "name": "@dsh-community/dsh-tool-literature", "version": "1.2.3", "source": { "type": "npm" } },
    { "id": "mine", "name": "my-plugin", "source": { "type": "path", "path": "~/dev/my-plugin" } },
    { "id": "team", "name": "team-tool", "source": { "type": "github", "repo": "owner/team-tool", "ref": "v1.0.0" } }
  ]
}
```

支持的源类型：

- `npm`——要求精确版本；`pnpm add --save-exact` 装入 profile，共享 pnpm 全局 store。
- `path`——本地目录直接 link（同 `graph-memory` 模式）；支持 `~` 与 `$DSH_HOME` 展开。
- `github`——zip → `~/.dsh/hotplug-store/<name>@<ref>` → link；优先官方 codeload，失败回退 `ghfast.top` / `gh-proxy` / `ghproxy` 镜像。

## 目录结构

```text
dsh-hotplug-hub-test/              # 仓库根目录
├── packages/shared-core/          # 共享内核：契约 / 类型 / 共享逻辑
├── release/                       # 构建 EXE、安装包、WebView2 DLL、内嵌 C# 契约
├── scripts/                       # 团队脚本：同步 / 检查 / 测试 / 安装
├── launcher/                      # Node CLI：assemble / check / launch / heal / status
├── dsh-hotplug-hub/               # hotplug-hub 插件 + dsh-pack-hub 原始页
├── vendor/dseam-skillmcp/         # Skill/MCP 管理器源码（MIT）
├── installer/                     # 历史安装包工厂
├── uninstaller/                   # 卸载器工厂
├── assembly/                      # 装配包（hotpack 1.0、dshpack 单一入口代码）
├── sandbox/                       # 临时 profile 沙箱
├── 开发文档/                       # 团队文档与规范
├── README.md                      # 项目说明
└── LICENSE                        # MIT License
```

## 开发

```powershell
# 修改前先同步仓库
pwsh -File scripts/sync-repo.ps1

# 提交前完整检查
pwsh -File scripts/check-before-upload.ps1

# 每次改动后记录到全局记忆
pwsh -File scripts/remember-doc.ps1 -DocPath README.md
```

团队规范见 `AI_AGENTS.md` 与 `开发文档/团队/`。

## 版本历史

完整变更记录：[`开发文档/开发历史.md`](开发文档/开发历史.md)

## License

[MIT](LICENSE)
