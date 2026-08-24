// DSH-Hotplug-Hub 卸载程序
// 基于 DSH Desktop 卸载器经验（P0-P8 改进）：优雅关进程、安全目录删除（不吞异常）、
// 二次确认弹窗、日志记录、静默模式、CLI 保留参数。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Management;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Win32;
using DSHHotplugHub;

class HotplugHubUninstaller
{
    #region Fields & Paths
    static bool silent = false;
    static List<string> messages = new List<string>();

    // 保留标志
    static bool keepAppData = false;      // %LOCALAPPDATA%\DSH-Hotplug-Hub
    static bool keepSharedData = false;   // .dsh\hotplug-store + .dsh\hotplug-hub
    static bool keepTempData = false;     // %TEMP%\dsh-hotplug-hub-webview2

    // 检测模式
    static bool useDetectedRunning = false;
    static string DetectedRunningDir = FindRunningInstallDir();
    static string InstallDir = ResolveInstallDir();
    static string LogFilePath = Path.Combine(Directory.GetCurrentDirectory(), "Log.log");
    // 静默模式删除失败计数：非零退出码供脚本检测部分卸载失败（对齐 dsh-desktop 卸载器）
    static int failureCount = 0;

    // 用户数据路径
    static string LocalAppDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DSH-Hotplug-Hub");
    static string TempDataDir = Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-webview2");
    static string DshHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    static string HotplugStoreDir = Path.Combine(DshHome, "hotplug-store");
    static string HotplugHubStateDir = Path.Combine(DshHome, "hotplug-hub");

    // 快捷方式
    static string DesktopShortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "DSH 热插拔中枢.lnk");
    static string CommonDesktopShortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), "DSH 热插拔中枢.lnk");
    static string StartMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DSH-Hotplug-Hub");
    static string CommonStartMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), "DSH-Hotplug-Hub");
    #endregion

    #region Entry Point & CLI
    [STAThread]
    static void Main(string[] args)
    {
        ParseArgs(args);
        InitializeLog();
        Log("===== DSH-Hotplug-Hub 卸载程序 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====");
        Log("InstallDir: " + (string.IsNullOrEmpty(InstallDir) ? "(未检测到)" : InstallDir));
        if (!string.IsNullOrEmpty(DetectedRunningDir))
            Log("DetectedRunningDir: " + DetectedRunningDir);

        if (!silent)
        {
            if (!ConfirmAndSelectRetention())
            {
                Log("用户取消卸载。");
                Log("===== 卸载程序退出 =====");
                Environment.ExitCode = 0;
                return;
            }
        }

        try
        {
            Run();
            Log("===== 卸载完成 =====");
            // 静默模式：删除失败以非零退出码回报（脚本/包管理器可检测部分卸载；旧实现恒 0）
            Environment.ExitCode = (silent && failureCount > 0) ? 1 : 0;
            if (!silent)
                MessageBox.Show("卸载完成。\n\n详见 Log.log。", "DSH-Hotplug-Hub 卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            Log("===== 卸载出错 =====");
            Environment.ExitCode = 1;
            if (!silent)
                MessageBox.Show("卸载出错：\n" + ex.Message + "\n\n详见 Log.log。", "DSH-Hotplug-Hub 卸载程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        if (!silent) Pause();
    }

    static void ParseArgs(string[] args)
    {
        foreach (string arg in args)
        {
            string a = arg.Trim();
            if (a.Equals("/S", StringComparison.OrdinalIgnoreCase) || a.Equals("/silent", StringComparison.OrdinalIgnoreCase))
                silent = true;
            else if (a.Equals("/KeepAppData", StringComparison.OrdinalIgnoreCase))
                keepAppData = true;
            else if (a.Equals("/KeepSharedData", StringComparison.OrdinalIgnoreCase))
                keepSharedData = true;
            else if (a.Equals("/KeepTempData", StringComparison.OrdinalIgnoreCase))
                keepTempData = true;
            else if (a.Equals("/KeepAll", StringComparison.OrdinalIgnoreCase))
            { keepAppData = true; keepSharedData = true; keepTempData = true; }
            else if (a.Equals("/DetectRunning", StringComparison.OrdinalIgnoreCase) || a.Equals("/Detect", StringComparison.OrdinalIgnoreCase))
                useDetectedRunning = true;
            else if (a.Equals("/Default", StringComparison.OrdinalIgnoreCase))
                useDetectedRunning = false;
        }
    }
    #endregion

    #region Install Detection
    static string ResolveInstallDir()
    {
        // 0. 安装时写入的注册表记录（修复自定义安装目录在程序未运行时检测失败）
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\DSH-Hotplug-Hub", false))
            {
                if (k != null)
                {
                    string v = k.GetValue("InstallDir") as string;
                    if (!string.IsNullOrEmpty(v) && Directory.Exists(v) && File.Exists(Path.Combine(v, "DSH-Hotplug-Hub.exe")))
                        return v;
                }
            }
        }
        catch { }

        // 1. 卸载器自身所在目录若含主程序，直接用。
        try
        {
            string currentDir = Path.GetDirectoryName(Assembly.GetEntryAssembly().Location);
            if (!string.IsNullOrEmpty(currentDir) && File.Exists(Path.Combine(currentDir, "DSH-Hotplug-Hub.exe")))
                return currentDir;
        }
        catch { }

        // 2. 常见安装路径（含 release/src/Setup.cs 的默认 DseamWorld 目录）。
        string[] candidates = new string[]
        {
            @"C:\DSH-Hotplug-Hub",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DSH-Hotplug-Hub"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DseamWorld"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DSH-Hotplug-Hub"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "DSH-Hotplug-Hub"),
        };
        foreach (string dir in candidates)
        {
            if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir) && File.Exists(Path.Combine(dir, "DSH-Hotplug-Hub.exe")))
                return dir;
        }

        return string.Empty;
    }

    static string FindRunningInstallDir()
    {
        // 整体 try/catch：GetProcesses() 枚举失败时不再于静态初始化阶段崩溃（返回空，走默认定位）
        try
        {
            foreach (Process p in Process.GetProcesses())
            {
                try
                {
                    string path = GetProcessExecutablePath(p);
                    if (string.IsNullOrEmpty(path)) continue;
                    if (Path.GetFileName(path).Equals("DSH-Hotplug-Hub.exe", StringComparison.OrdinalIgnoreCase))
                    {
                        string dir = Path.GetDirectoryName(path);
                        if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                            return dir;
                    }
                }
                catch { }
            }
        }
        catch { }
        return string.Empty;
    }

    // MainModule.FileName 对提权/他会话进程抛异常；WMI Win32_Process 兜底（对齐 dsh-desktop 卸载器）
    static string GetProcessExecutablePath(Process p)
    {
        try
        {
            string path = p.MainModule.FileName;
            if (!string.IsNullOrEmpty(path)) return path;
        }
        catch { }
        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ExecutablePath FROM Win32_Process WHERE ProcessId = " + p.Id))
            {
                foreach (ManagementObject mo in searcher.Get())
                {
                    string path = mo["ExecutablePath"] as string;
                    if (!string.IsNullOrEmpty(path)) return path;
                }
            }
        }
        catch { }
        return string.Empty;
    }

    static string GetEffectiveInstallDir()
    {
        if (useDetectedRunning)
        {
            // 重新探测运行实例（而非静态初始化时捕获的旧快照）
            string running = FindRunningInstallDir();
            if (!string.IsNullOrEmpty(running)) return running;
        }
        return InstallDir;
    }
    #endregion

    #region Uninstall Pipeline
    static void Run()
    {
        string dir = GetEffectiveInstallDir();

        KillProcesses();          // [1/6]
        DeleteShortcuts();        // [2/6]

        if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
        {
            Log("[3/6] Deleting install directory: " + dir);
            DeleteDirectoryWithRetry(dir);
        }
        else
        {
            Log("[3/6] Install directory not detected, skipping.");
        }

        CleanUserData();          // [4/6]
        CleanTemp();              // [5/6]
        CleanRegistry();          // [6/6]
    }
    #endregion

    #region Process & File Cleanup
    static void KillProcesses()
    {
        Log("[1/6] Stopping DSH-Hotplug-Hub processes...");

        // 第一轮：优雅关闭
        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                if (IsHotplugProcess(p))
                {
                    if (p.MainWindowHandle != IntPtr.Zero)
                    {
                        p.CloseMainWindow();
                        Log("  Sent close to: " + p.ProcessName + " (PID " + p.Id + ")");
                    }
                    else
                    {
                        p.Kill();
                        Log("  Killed: " + p.ProcessName + " (PID " + p.Id + ")");
                    }
                }
            }
            catch { }
        }

        // 等待最多 3 秒
        for (int i = 0; i < 10; i++)
        {
            bool anyAlive = false;
            foreach (Process p in Process.GetProcesses())
            {
                try { if (IsHotplugProcess(p)) { anyAlive = true; break; } } catch { }
            }
            if (!anyAlive) break;
            Thread.Sleep(300);
        }

        // 第二轮：强制清理残留
        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                if (IsHotplugProcess(p))
                {
                    p.Kill();
                    Log("  Force killed: " + p.ProcessName + " (PID " + p.Id + ")");
                }
            }
            catch { }
        }

        // 第三轮：taskkill /T 整树清理（主进程退出后 node/WebView2 子进程可能残留并占用文件锁）
        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                if (IsHotplugProcess(p))
                {
                    RunTaskKill("/F /T /PID " + p.Id);
                }
            }
            catch { }
        }

        Thread.Sleep(500);
    }

    static void RunTaskKill(string arguments)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe", arguments);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit(10000);
            }
        }
        catch (Exception ex)
        {
            Log("  Failed to run taskkill " + arguments + ": " + ex.Message);
        }
    }

    static bool IsHotplugProcess(Process p)
    {
        try
        {
            // 不杀自己
            try
            {
                if (p.MainModule.FileName.Equals(Assembly.GetEntryAssembly().Location, StringComparison.OrdinalIgnoreCase))
                    return false;
            }
            catch { }
            return p.ProcessName.Equals("DSH-Hotplug-Hub", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    static void DeleteDirectoryWithRetry(string dir)
    {
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;

        for (int i = 0; i < 8; i++)
        {
            try
            {
                DeleteDirectorySafe(dir);
                Log("  Deleted directory: " + dir);
                return;
            }
            catch (Exception ex)
            {
                if (i == 7)
                {
                    Log("  Failed to delete (may be in use): " + dir + " -> " + ex.Message);
                    failureCount++;
                }
                else
                    Thread.Sleep(800);
            }
        }
    }

    static void DeleteDirectorySafe(string path)
    {
        if (!Directory.Exists(path)) return;

        FileAttributes attr = File.GetAttributes(path);
        if ((attr & FileAttributes.ReparsePoint) != 0)
        {
            // 重解析点只删链接本身，不进入目标。
            Directory.Delete(path, false);
            return;
        }

        // 先清只读属性并删除所有文件：记录具体被占用文件后重新抛出，交给外层重试
        //（修复旧实现对单文件删除静默吞异常，隐藏真正的占用者）。
        foreach (string file in Directory.GetFiles(path))
        {
            try
            {
                File.SetAttributes(file, FileAttributes.Normal);
                File.Delete(file);
            }
            catch (Exception ex)
            {
                Log("  Cannot delete file (locked?): " + file + " -> " + ex.Message);
                throw;
            }
        }

        // 递归删除子目录。
        foreach (string sub in Directory.GetDirectories(path))
        {
            DeleteDirectorySafe(sub);
        }

        // 最终目录删除失败不吞异常，交给外层重试。
        Directory.Delete(path, false);
    }

    static void DeleteFileIfExists(string file)
    {
        if (string.IsNullOrEmpty(file) || !File.Exists(file)) return;
        try
        {
            File.Delete(file);
            Log("  Deleted file: " + file);
        }
        catch (Exception ex)
        {
            Log("  Failed to delete file: " + file + " -> " + ex.Message);
            failureCount++;
        }
    }
    #endregion

    #region Shortcut & Registry Cleanup
    static void DeleteShortcuts()
    {
        Log("[2/6] Cleaning shortcuts...");
        DeleteFileIfExists(DesktopShortcut);
        DeleteFileIfExists(CommonDesktopShortcut);
        DeleteDirectoryWithRetry(StartMenuDir);
        DeleteDirectoryWithRetry(CommonStartMenuDir);
    }

    static void CleanRegistry()
    {
        Log("[6/6] Cleaning registry...");
        // 删除应用键（安装器写入的 InstallDir 记录）与可能的卸载键
        DeleteRegSubKey(Registry.CurrentUser, @"Software\DSH-Hotplug-Hub", "HKCU app key");
        DeleteRegSubKey(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH-Hotplug-Hub", "HKCU uninstall key");
        // 清理安装器注入的 PATH（runtime\node、runtime\pnpm）与 PNPM_HOME（旧实现完全漏掉）
        CleanupEnvironment();
    }

    static void CleanupEnvironment()
    {
        Log("  Cleaning user PATH + PNPM_HOME...");
        try
        {
            string dir = GetEffectiveInstallDir();
            using (RegistryKey envKey = Registry.CurrentUser.OpenSubKey("Environment", true))
            {
                if (envKey == null) return;

                object pathVal = envKey.GetValue("Path", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                if (pathVal != null)
                {
                    string path = pathVal.ToString();
                    string[] parts = path.Split(';');
                    List<string> kept = new List<string>();
                    foreach (string p in parts)
                    {
                        if (string.IsNullOrEmpty(p)) { kept.Add(p); continue; }
                        if (IsDshHotplugPathEntry(p, dir))
                            Log("  Removed from PATH: " + p);
                        else
                            kept.Add(p);
                    }
                    try { envKey.SetValue("Path", string.Join(";", kept.ToArray()), envKey.GetValueKind("Path")); }
                    catch { /* 保留原值类型失败时按原样跳过 */ }
                }

                object pnpmHome = envKey.GetValue("PNPM_HOME");
                if (pnpmHome != null)
                {
                    string ph = pnpmHome.ToString();
                    if (string.IsNullOrEmpty(ph) || IsDshHotplugPathEntry(ph, dir))
                    {
                        envKey.DeleteValue("PNPM_HOME");
                        Log("  Deleted PNPM_HOME: " + ph);
                    }
                }
            }
            BroadcastEnvironmentChange();
        }
        catch (Exception ex)
        {
            Log("  Failed to clean user PATH/PNPM_HOME: " + ex.Message);
        }
    }

    static bool IsDshHotplugPathEntry(string p, string installDir)
    {
        if (string.IsNullOrEmpty(p)) return false;
        // 位于已检测安装目录下（大小写/尾斜杠不敏感，兄弟目录不误判）
        if (!string.IsNullOrEmpty(installDir) && InstallUninstallContract.IsPathEntryUnderDir(p, installDir)) return true;
        // 检测失败兜底：按已知安装目录名匹配（覆盖默认安装位置）
        string lower = p.ToLowerInvariant();
        return lower.Contains("dsh-hotplug-hub") || lower.Contains("dseamworld");
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    static void BroadcastEnvironmentChange()
    {
        try
        {
            UIntPtr result;
            SendMessageTimeout((IntPtr)0xffff, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 5000, out result);
        }
        catch { }
    }

    static void DeleteRegSubKey(RegistryKey root, string subKey, string label)
    {
        try
        {
            using (RegistryKey key = root.OpenSubKey(subKey))
            {
                if (key != null)
                {
                    key.Close();
                    root.DeleteSubKeyTree(subKey, false);
                    Log("  Deleted " + label + ": " + subKey);
                }
            }
        }
        catch (Exception ex)
        {
            Log("  Failed to delete " + label + ": " + ex.Message);
        }
    }
    #endregion

    #region User Data Retention & Cleanup
    static void CleanUserData()
    {
        Log("[4/6] Cleaning user data...");

        if (!keepAppData && Directory.Exists(LocalAppDataDir))
        {
            Log("  Deleting app data: " + LocalAppDataDir);
            DeleteDirectoryWithRetry(LocalAppDataDir);
        }
        else if (keepAppData)
        {
            Log("  Keeping app data: " + LocalAppDataDir);
        }

        if (!keepSharedData)
        {
            if (Directory.Exists(HotplugStoreDir))
            {
                Log("  Deleting hotplug-store: " + HotplugStoreDir);
                DeleteDirectoryWithRetry(HotplugStoreDir);
            }
            if (Directory.Exists(HotplugHubStateDir))
            {
                Log("  Deleting hotplug-hub state: " + HotplugHubStateDir);
                DeleteDirectoryWithRetry(HotplugHubStateDir);
            }
        }
        else
        {
            Log("  Keeping DSH shared data (hotplug-store + hotplug-hub).");
        }
    }

    static void CleanTemp()
    {
        Log("[5/6] Cleaning temp data...");
        if (!keepTempData && Directory.Exists(TempDataDir))
        {
            Log("  Deleting temp data: " + TempDataDir);
            DeleteDirectoryWithRetry(TempDataDir);
        }
        else if (keepTempData)
        {
            Log("  Keeping temp data: " + TempDataDir);
        }
    }

    static string RetentionSummary()
    {
        List<string> kept = new List<string>();
        if (keepAppData) kept.Add("应用配置与数据");
        if (keepSharedData) kept.Add("DSH 共享缓存");
        if (keepTempData) kept.Add("临时缓存");
        return kept.Count == 0 ? "(none)" : string.Join(", ", kept.ToArray());
    }
    #endregion

    #region Logging & Helpers
    static void InitializeLog()
    {
        try
        {
            string dir = Path.GetDirectoryName(LogFilePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllText(LogFilePath, "===== DSH-Hotplug-Hub Uninstaller Log " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====" + Environment.NewLine);
        }
        catch { }
    }

    static void Log(string message)
    {
        messages.Add(message);
        try { File.AppendAllText(LogFilePath, message + Environment.NewLine); } catch { }
        Console.WriteLine(message);
    }

    static void Pause()
    {
        if (!silent)
        {
            Console.WriteLine();
            Console.WriteLine("按任意键退出...");
            try { Console.ReadKey(true); } catch { }
        }
    }
    #endregion

    #region GUI
    static bool ConfirmAndSelectRetention()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        RetentionForm form = new RetentionForm();
        form.SetRetentionOptions(keepAppData, keepSharedData, keepTempData);

        if (form.ShowDialog() != DialogResult.OK)
            return false;

        keepAppData = form.KeepAppData;
        keepSharedData = form.KeepSharedData;
        keepTempData = form.KeepTempData;
        useDetectedRunning = form.UseDetectedRunning;

        // 二次确认
        string summary = RetentionSummary();
        string text = summary == "(none)"
            ? "确定卸载 DSH-Hotplug-Hub 并删除所有用户数据吗？"
            : "确定卸载 DSH-Hotplug-Hub 并保留以下内容吗？\r\n\r\n" + summary;
        DialogResult r = MessageBox.Show(text, "确认卸载", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
        if (r != DialogResult.OK)
        {
            Log("用户在二次确认中取消。");
            return false;
        }

        return true;
    }

    class RetentionForm : Form
    {
        RadioButton rbDetectRunning;
        RadioButton rbDefault;
        CheckBox chkAppData;
        CheckBox chkSharedData;
        CheckBox chkTempData;
        Button btnUninstall;
        Button btnCancel;

        public bool KeepAppData { get { return chkAppData.Checked; } }
        public bool KeepSharedData { get { return chkSharedData.Checked; } }
        public bool KeepTempData { get { return chkTempData.Checked; } }
        public bool UseDetectedRunning { get { return rbDetectRunning.Checked; } }

        public RetentionForm()
        {
            Text = "DSH-Hotplug-Hub 卸载确认";
            ClientSize = new Size(520, 340);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            Font = new Font("Microsoft YaHei UI", 9F);

            // 卸载模式
            GroupBox grpMode = new GroupBox();
            grpMode.Text = "卸载模式";
            grpMode.SetBounds(22, 16, 476, 72);

            rbDetectRunning = new RadioButton();
            rbDetectRunning.Text = "程序识别卸载（检测运行中的 DSH-Hotplug-Hub）";
            rbDetectRunning.SetBounds(16, 24, 440, 24);
            rbDetectRunning.Checked = !string.IsNullOrEmpty(DetectedRunningDir);
            rbDetectRunning.Enabled = !string.IsNullOrEmpty(DetectedRunningDir);

            rbDefault = new RadioButton();
            rbDefault.Text = "默认卸载（按安装路径检测）";
            rbDefault.SetBounds(16, 48, 440, 24);
            if (!rbDetectRunning.Checked) rbDefault.Checked = true;

            grpMode.Controls.AddRange(new Control[] { rbDetectRunning, rbDefault });

            // 可选保留项
            GroupBox grpRetention = new GroupBox();
            grpRetention.Text = "可选保留项";
            grpRetention.SetBounds(22, 98, 476, 170);

            chkAppData = new CheckBox();
            chkAppData.Text = "保留应用配置与数据（%LOCALAPPDATA%\\DSH-Hotplug-Hub）";
            chkAppData.SetBounds(16, 28, 440, 24);

            chkSharedData = new CheckBox();
            chkSharedData.Text = "保留 DSH 共享缓存（.dsh\\hotplug-store + .dsh\\hotplug-hub）";
            chkSharedData.SetBounds(16, 58, 440, 24);

            chkTempData = new CheckBox();
            chkTempData.Text = "保留临时缓存（%TEMP%\\dsh-hotplug-hub-webview2）";
            chkTempData.SetBounds(16, 88, 440, 24);

            Label hint = new Label();
            hint.Text = "不勾选任何项 = 全部删除";
            hint.SetBounds(16, 120, 440, 20);
            hint.ForeColor = Color.Gray;

            grpRetention.Controls.AddRange(new Control[] { chkAppData, chkSharedData, chkTempData, hint });

            // 按钮
            btnUninstall = new Button();
            btnUninstall.Text = "卸载";
            btnUninstall.SetBounds(300, 286, 90, 32);
            btnUninstall.BackColor = Color.FromArgb(14, 124, 107);
            btnUninstall.ForeColor = Color.White;
            btnUninstall.FlatStyle = FlatStyle.Flat;
            btnUninstall.DialogResult = DialogResult.OK;

            btnCancel = new Button();
            btnCancel.Text = "取消";
            btnCancel.SetBounds(400, 286, 90, 32);
            btnCancel.DialogResult = DialogResult.Cancel;

            Controls.AddRange(new Control[] { grpMode, grpRetention, btnUninstall, btnCancel });
            AcceptButton = btnUninstall;
            CancelButton = btnCancel;
        }

        public void SetRetentionOptions(bool appData, bool sharedData, bool tempData)
        {
            chkAppData.Checked = appData;
            chkSharedData.Checked = sharedData;
            chkTempData.Checked = tempData;
        }
    }
    #endregion
}
