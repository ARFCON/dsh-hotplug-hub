DSH-Hotplug-Hub 测试分发包
============================

这是一个自包含的开发/测试目录，包含：

  installer\         安装程序（Setup.exe + 源码）
  release\           EXE 运行文件 + WebView2 DLL + 说明文档
  launcher\          独立启动器（assemble / check / launch / heal）
  assembly\          组合示例
  sandbox\           临时 profile 工作区
  开发文档\           开发文档（MD / TXT / DOCX）

安装方法
--------
1. 进入 installer 目录
2. 双击 Setup.exe
3. 默认安装到 C:\DSH-Hotplug-Hub（可修改）
4. 安装完成后桌面/开始菜单会生成“DSH 热插拔中枢”快捷方式

启动器 CLI
----------
cd launcher
node index.js assemble example
node index.js check example
node index.js launch example
node index.js heal example

开发文档
--------
见 开发文档\DSH-Hotplug-Hub-开发文档.md