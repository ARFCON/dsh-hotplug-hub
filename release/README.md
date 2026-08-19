# release — 桌面端发布文件

- `DSH-Hotplug-Hub.exe`：Windows 桌面 GUI（WebView2）
- `Microsoft.Web.WebView2.*.dll` + `WebView2Loader.dll`：运行依赖
- `src/Main.cs`：桌面端源码
- `build-exe.ps1`：重新编译脚本

## 重新编译
```powershell
pwsh -File release/build-exe.ps1
```

> WebView2 DLL 优先读取环境变量 `WEBVIEW2_CORE_DLL` / `WEBVIEW2_WINFORMS_DLL` / `WEBVIEW2_LOADER_DLL`，CI 会自动注入。