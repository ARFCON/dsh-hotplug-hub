> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。

# Dseam世界（DSH-Hotplug-Hub）

DSH-Hotplug-Hub 是 **Dseam世界** 的桌面软件（Windows，WebView2 + C# WinForms），用于管理 DSH 的插件、Skill 与 MCP，并提供全局记忆中枢。它独立于 DSH Desktop 运行，不修改 DSH Desktop 安装目录；插件统一安装到官方 profile（`~/.dsh/profiles/web`），由 DSH 自己加载。

## 当前版本

- 最新正式版：**v0.9.8**
- 下载页：https://github.com/ARFCON/dsh-hotplug-hub/releases/tag/v0.9.8
- 安装程序：`DSH-Hotplug-Hub-Setup.exe`
- 绿色版主程序：`DSH-Hotplug-Hub.exe`

## 主要功能

- **插件管理**：安装 / 更新 / 卸载插件，插件健康自检与冲突矩阵。
- **Skill 管理**：从固定文件夹（默认 `%APPDATA%\reasonix\skills`，可用环境变量 `DSH_SKILL_SOURCE_DIR` 覆盖）扫描全部 SKILL.md，勾选批量安装；启用 / 停用真实调用内置 `dseam-skillmcp` CLI。
- **MCP 管理**：支持 `STDIO` 与 `streamable-http` 两种 MCP 的添加、删除、启停、测试，统一写入 `dseam-skillmcp` 受管块。
- **全局记忆中枢**：真实读写 `~/.dsh/memory-hub`，支持每条记忆的查看、编辑、删除；配合 `dsh-memory-hub` 插件，在 AI 听到重要信息（偏好 / 决定 / 约束 / 背景 / 纠正 / 长期目标）时主动提醒记忆，并允许 AI 修改 / 删除记忆。
- **内置 Skill/MCP 管理器**：`dseam-skillmcp`（原开源 `dsh-skill-mcp-panel` 改名适配，MIT License），随安装程序 / EXE 自动安装到 profile，无需另装。
- **托盘常驻**：关闭主窗口最小化到系统托盘，后台进程继续运行；单实例进程，重复启动只提示不重复打开。
- **自检与更新**：启动时自动自检（Node / pnpm / profile / 插件 / 内置管理器），并自动安装 / 更新 `dsh-memory-hub` 与内置管理器。

## 安装

### 方式一：安装程序（推荐）

1. 到 Release 页下载 `DSH-Hotplug-Hub-Setup.exe`。
2. 双击运行，选择安装位置（默认 `%LOCALAPPDATA%\Programs\DseamWorld`）。
3. 点击「立即安装」，自动创建桌面 / 开始菜单快捷方式，完成后可直接启动。

静默安装：

```powershell
DSH-Hotplug-Hub-Setup.exe --silent
DSH-Hotplug-Hub-Setup.exe --silent --dir "D:\MyApps\DseamWorld"
```

### 方式二：绿色版

下载 `DSH-Hotplug-Hub.exe`，放到任意目录后双击运行即可（Release 内的 WebView2 运行 DLL 与该 EXE 保持同目录时最稳）。

## 目录结构

```text
dsh-hotplug-hub-test/              # 仓库根目录
├── packages/shared-core/          # 共享内核（契约/纯逻辑单一真源，workspace 包）
├── release/                       # 桌面 EXE、安装程序、WebView2 DLL、内嵌包、C# 契约测试
├── scripts/                       # 团队协作脚本（同步 / 检查 / 记忆 / 安装）
├── launcher/                      # 独立 CLI 启动器（assemble / check / launch / heal / status）
├── dsh-hotplug-hub/               # hotplug-hub 插件源码 + dsh-pack-hub 原型页 + memory-hub
├── vendor/dseam-skillmcp/         # 内置 Skill/MCP 管理器源码（MIT）
├── installer/                     # 历史安装程序工程
├── uninstaller/                   # 卸载程序工程
├── assembly/                      # 组合描述（hotpack 1.0；dshpack 经单一桥接导入）
├── sandbox/                       # 临时 profile 工作区
├── 开发文档/                       # 团队文档与规范
├── README.md                      # 项目说明
└── LICENSE                        # MIT License
```

## 更新历史

完整更新公告见 [开发文档/更新历史.md](开发文档/更新历史.md)。

## 开发与检查

- 修改前先同步：`pwsh -File scripts/sync-repo.ps1`
- 提交前检查：`pwsh -File scripts/check-before-upload.ps1`
- 每次修改后记录记忆：`pwsh -File scripts/remember-doc.ps1 -DocPath README.md`
- 团队规范：`AI_AGENTS.md`、`开发文档/团队/`

## License

MIT
