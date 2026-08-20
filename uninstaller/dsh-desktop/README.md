> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。
# dsh-Uninstall

DSH / DeepSeek Harness 桌面端独立卸载器。单个 exe 即可运行，支持官方版、第三方集合版/集成版、极简版/简洁版以及其他未知变体的通用卸载。

## 特点

- **多桌面端兼容**：自动扫描 HKLM/HKCU、32/64 位注册表视图、常见安装位置、运行中进程和已知变体目录。
- **变体识别**：窗口最上方显示当前识别的桌面端类型：
  - `官方 deepseek-ai/deepseek-harness`
  - `第三方 <仓库路径>`
  - `未知`
- **变体专属清理**：识别到具体仓库后，删除逻辑自动收窄到该变体的 exe/进程/快捷方式/注册表项，避免误删其他 DSH 变体。
- **通用卸载兜底**：找不到已知变体时，按注册表卸载项、常见安装路径、进程名、快捷方式名自动清理。
- **可选保留**：默认删除全部用户数据；可在弹窗中按类别保留：
  - 预设（按实际显示名称勾选）
  - 插件（按 package.json 识别，列表可滚动）
  - skills（按 `.dsh\skills` 目录识别）
  - 聊天数据（`.dsh\sessions`）
  - 应用设置（`settings.yaml`）
  - 模型配置与凭据（`.credentials.yaml` + `settings.yaml` 模型部分，共用文件自动合并）
  - 其他 `.dsh` 数据
  - `.dsh-runtime`
- **静默卸载**：`/S` 支持不弹窗执行，并可用命令行参数指定保留项。
- **日志**：运行后生成 `Log.log`（默认在卸载器 exe 所在目录；可用 `/Log=<完整文件路径>` 指定）。安装目录内运行时，删除前自动把日志副本保存到上一级目录。
- **单文件发布**：最终产物只有一个 `Uninstall_DSH_Desktop.exe`，仅依赖 Windows 自带的 .NET Framework 4.x，不调用任何外部脚本/辅助 exe。

## 使用

双击 `Uninstall_DSH_Desktop.exe` 打开卸载确认窗口，勾选需要保留的内容后点击“卸载”。

静默示例：

```bat
Uninstall_DSH_Desktop.exe /S
Uninstall_DSH_Desktop.exe /S /KeepPresets=agent-sc /KeepChatData /KeepAppSettings /KeepModelConfig
Uninstall_DSH_Desktop.exe /S /KeepPlugins=@dsh-external/dsh-vision /DetectRunning
```

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `/S` | 静默模式，不弹窗 |
| `/KeepPresets` | 保留全部 `.agent-presets` 预设 |
| `/KeepPresets=名称1,名称2` | 仅保留指定预设 |
| `/KeepPlugins` | 保留全部检测到的插件（自动附带保留 `.dsh-runtime`） |
| `/KeepPlugins=包名1,包名2` | 仅保留指定插件包 |
| `/KeepSkills` | 保留全部 `.dsh\skills` |
| `/KeepSkills=名称1,名称2` | 仅保留指定 skills |
| `/KeepRuntime` | 保留 `.dsh-runtime` |
| `/KeepVision` | 兼容旧参数：只保留识图插件 `@dsh-external/dsh-vision` |
| `/KeepAppSettings` | 保留应用设置 `settings.yaml` |
| `/KeepModelConfig` | 保留模型配置与凭据（`.credentials.yaml` + `settings.yaml` 模型部分） |
| `/KeepOtherUserData` | 保留预设/聊天/skills/插件/设置之外的其他 `.dsh` 数据，别名 `/KeepOtherData` |
| `/KeepChatData` | 保留聊天数据 `.dsh\sessions`，别名 `/KeepChat` |
| `/KeepAll` | 保留全部可选项目 |
| `/DetectRunning` | 识别当前正在运行的 DSH 并卸载其目录，别名 `/DetectDSH` |
| `/Default` | 默认卸载模式（注册表/常见安装位置检测） |
| `/InstallDir=<路径>` | 手动指定安装目录（必须通过安全校验） |
| `/DryRun` | 预演：只打印将要删除的内容，不执行任何删除 |
| `/help` | 显示帮助 |
| `/Log=<完整文件路径>` | 指定日志文件路径 |

## 构建

需要 Windows + .NET Framework 4.x 自带编译器 `csc.exe`，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-uninstaller.ps1
```

产物输出到：

```
build\Uninstall_DSH_Desktop.exe
```

构建脚本自动编译当前目录全部 `.cs` 文件，并引用 `System.Windows.Forms.dll`、`System.Drawing.dll`、`System.Management.dll`。

## 目录结构

```
uninstaller/dsh-desktop/
├── DSH_Desktop_Uninstaller.cs           # 主程序：入口、CLI、卸载流水线、日志
├── DSH_Desktop_Uninstaller.Core.cs      # 变体档案、名称匹配、保留项模型、日志服务、纯函数
├── DSH_Desktop_Uninstaller.Detection.cs # 安装目录/进程/注册表/变体识别
├── DSH_Desktop_Uninstaller.Cleanup.cs   # 进程终止、文件/快捷方式/注册表/PATH/Run 清理
├── DSH_Desktop_Uninstaller.Retention.cs # 预设/插件/skills 检测与保留、用户数据清理
├── DSH_Desktop_Uninstaller.Gui.cs       # 确认弹窗、可滚动保留项列表、进度窗口
├── DSH_Desktop_卸载说明.txt               # 详细使用/卸载说明
├── embed-icon-in-exe.ps1                # 构建时把图标写入 exe
├── Uninstall_DSH_Desktop.exe            # 预编译的单文件卸载器
├── Uninstall_DSH_Desktop_icon.ico       # 卸载器图标
├── build-uninstaller.ps1                # 一键构建脚本
└── README.md
```

## 注意

- 卸载会删除 DSH / DeepSeek Harness 桌面端产生的用户数据及会话记录，请提前备份需要的内容。
- 运行时只依赖 Windows 自带 .NET Framework 4.x，不需要额外安装或附带 DLL。
