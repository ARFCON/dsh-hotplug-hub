# Dseam世界（DSH-Hotplug-Hub）

DSH-Hotplug-Hub 是一个**独立于 DSH 的插件拼装启动器**。

它在 DSH 进程之外读取插件组合 → 拼装临时 profile → 冲突预检 → 拉起官方 DSH → 捕获日志 → 自愈闭环。

## 更新公告 · v0.1.5

- 新增 Linux 跨平台支持：`scripts/linux/`，launcher 支持 `dsh` CLI。
- 新增自更新检查：自检页显示「本程序版本 / 最新版本」，可一键检查更新与下载新版本。
- macOS / Linux / Windows 三端支持。


- 新增 macOS 跨平台支持：`launcher` 可在 macOS 运行，提供 `.app` 壳脚本。
- 修复 Windows 自检 pnpm 未检测到。
- 新增跨平台规范：`开发文档/规范/跨平台支持规范.md`。
- 团队协作/AI 协作文档同步更新。
## 仓库整理状态

本仓库已经过整理，当前文件即为整理后的最终结构。
- 文档目录已统一：`开发文档/团队/`、`开发文档/规范/`
- 生成文件已忽略：`assembly/*/resolvedAssembly.json`、`sandbox/.sandbox/`
- 任何修改请在修改记录中说明原因和影响。
## 特性

- **独立启动器**：不依赖 `dsh plugin add link:` 装进 DSH
- **五大模块**：Market / Assembler / Check / Launcher / Standard+Adapter
- **hotpack v1 复用**：以 hotpack 作为组合载体，叠加 `resolvedAssembly` 索引
- **冲突预检**：版本冲突、角色冲突、bundle↔cordis 重分类
- **自愈**：错误分类 + 受限动作集（默认预览，`--yes` 写入建议）
- **Windows 桌面 GUI**：WebView2 + C# WinForms
- **macOS / Linux 支持**：Node 启动器 + `.app` / shell 壳 / dsh CLI
- **官方 DSH 集成**：自动检测 / 手动选择 DSH Desktop
- **API 模型配置**：直接读取官方 DSH 的 API 配置（`~/.dsh/settings.yaml` + `.credentials.yaml`）
- **安装程序**：`installer/Setup.exe`，默认安装到 `C:\DSH-Hotplug-Hub`

## 目录结构

```text
dsh-hotplug-hub-test/           # 本仓库根目录
├── installer/                  # Windows 安装程序（Setup.exe + 源码）
├── uninstaller/                # 卸载程序（Uninstall_Hotplug_Hub.exe + 源码）
├── scripts/                    # 团队协作脚本（同步/检查/记忆）
├── release/                    # 桌面 EXE + WebView2 DLL + 使用说明
├── launcher/                   # 独立启动器（CLI）
├── assembly/                   # 组合描述与 resolvedAssembly
├── sandbox/                    # 临时 profile 工作区
├── 开发文档/                    # 开发文档（MD / TXT / DOCX）
├── dsh-hotplug-hub/            # 原始 DSH 插件源码（历史兼容 / 修改参考）
├── README.md                   # 项目说明
├── README-安装说明.txt          # 快速安装说明
├── LICENSE                     # MIT License
└── .gitignore
```

## 快速开始

### 启动器 CLI

```bash
cd launcher

node index.js assemble example   # 组装 sandbox profile
node index.js check example      # 冲突预检
node index.js launch example     # 同步 ~/.dsh/profiles/<id> 并拉起 DSH
node index.js heal example       # 自愈预览
node index.js heal example --yes # 写入自愈建议
node index.js status example     # 查看状态
```

### Windows 桌面 GUI

1. 运行 `installer/Setup.exe`
2. 默认安装到 `C:\DSH-Hotplug-Hub`（可更改）
3. 安装完成后双击桌面/开始菜单的“DSH 热插拔中枢”快捷方式

## 架构

```text
读 assembly / hotpack
        ↓
Assembler：生成 sandbox/<id>/ profile（依赖解析 + 版本 pin）
        ↓
Check：静态冲突矩阵 + 预检
        ↓
Launcher：sandbox 同步为 ~/.dsh/profiles/<id>
        ↓
以 DSH_PROFILE=<id> 拉起 DSH
        ↓
捕获日志（DSH 内部日志 + stdout/stderr tee）
        ↓
自愈循环：错误分类 → 受限动作 → 重启复检
```

## 文档

- 开发文档：`开发文档/DSH-Hotplug-Hub-开发文档.md`
- 使用说明：`release/DSH热插拔中枢-说明.txt`
- hotpack 格式：`dsh-hotplug-hub/docs/hotpack-format.zh.md`

## 多人开发

- 贡献指南：`CONTRIBUTING.md`
- Issue 模板：`.github/ISSUE_TEMPLATE/`
- CI：`.github/workflows/ci.yml`（自动跑启动器测试 + Windows 构建）
- 分支：`main`（稳定） / `develop`（集成） / `feature/*`（功能）
## License

MIT
## 全局记忆

- 重要内容必须写入 `~/.dsh/memory/memories.jsonl`。
- 每次查看 README / AI_AGENTS / 检查流程后，执行：
  ```powershell
  pwsh -File scripts/remember-doc.ps1 -DocPath README.md
  pwsh -File scripts/remember-doc.ps1 -DocPath AI_AGENTS.md
  pwsh -File scripts/remember-doc.ps1 -DocPath scripts/check-before-upload.ps1
  ```
