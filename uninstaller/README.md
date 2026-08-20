> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。
# DSH-Hotplug-Hub 卸载程序目录

本目录统一管理 DSH 生态的卸载程序，分工明确：

| 子目录 | 卸载对象 | 说明 | 构建脚本 |
|---|---|---|---|
| `hotplug-hub/` | DSH-Hotplug-Hub（插件中心） | 卸载插件中心桌面应用与共享缓存 | `hotplug-hub/build-uninstaller.ps1` |
| `dsh-desktop/` | DSH Desktop（官方 Harness） | 卸载 DSH / DeepSeek Harness 桌面端 | `dsh-desktop/build-uninstaller.ps1` |

## 目录结构

```
uninstaller/
├── README.md                 # 本说明
├── hotplug-hub/              # 卸载插件中心
│   ├── Uninstall_Hotplug_Hub.cs
│   ├── Uninstall_Hotplug_Hub.exe
│   ├── Uninstall_Hotplug_Hub_说明.txt
│   ├── build-uninstaller.ps1
│   └── embed-icon-in-exe.ps1
└── dsh-desktop/              # 卸载 DSH / DeepSeek Harness 桌面端
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

## 构建方法

```powershell
# 插件中心卸载器
pwsh -File uninstaller/hotplug-hub/build-uninstaller.ps1

# DSH 卸载器（自动编译全部 .cs 并嵌入图标）
pwsh -File uninstaller/dsh-desktop/build-uninstaller.ps1
```
