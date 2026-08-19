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
└── dsh-desktop/              # 卸载 DSH
    ├── DSH_Desktop_Uninstaller.cs
    ├── DshRetentionContract.cs
    ├── Uninstall_DSH_Desktop.exe
    ├── DSH_Desktop_卸载说明.txt
    ├── build-uninstaller.ps1
    ├── embed-icon-in-exe.ps1
    ├── make-uninstaller-icon.ps1
    └── Uninstall_DSH_Desktop_icon.ico
```

## 构建方法

```powershell
# 插件中心卸载器
pwsh -File uninstaller/hotplug-hub/build-uninstaller.ps1

# DSH 卸载器
pwsh -File uninstaller/dsh-desktop/build-uninstaller.ps1
```