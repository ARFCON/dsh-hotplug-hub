> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。
# installer — 安装程序

Windows 安装程序，把整个项目安装到 `C:\DSH-Hotplug-Hub`（可改）。

## 使用
```text
双击 installer/Setup.exe
```

## 重新编译
```powershell
pwsh -File installer/build-installer.ps1
```

## 说明
- 安装内容：release / launcher / assembly / sandbox / 开发文档
- 自动创建桌面和开始菜单快捷方式
- Setup.exe 必须放在本仓库的 installer 目录中运行