using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using DSHHotplugHub;

namespace DSHHotplugHubInstaller
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallForm());
        }
    }

    internal sealed class InstallForm : Form
    {
        private readonly TextBox txtPath = new TextBox();
        private readonly Button btnBrowse = new Button();
        private readonly Button btnInstall = new Button();
        private readonly ProgressBar progress = new ProgressBar();

        public InstallForm()
        {
            Text = "DSH-Hotplug-Hub 安装程序";
            Width = 560;
            Height = 260;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Palette.Panel; // --panel
            ForeColor = Palette.Ink;   // --ink
            Font = Palette.UiFont;

            Label title = new Label();
            title.Text = "DSH 热插拔中枢 / DSH-Hotplug-Hub\n独立启动器 + 桌面 GUI 安装程序";
            title.SetBounds(20, 14, 500, 44);
            title.Font = Palette.TitleFont;
            title.ForeColor = Palette.Teal; // --teal

            Label lbl = new Label();
            lbl.Text = "安装目录（C 盘，可更改）：";
            lbl.SetBounds(20, 74, 180, 24);

            txtPath.Text = @"C:\DSH-Hotplug-Hub";
            txtPath.SetBounds(20, 100, 360, 26);

            btnBrowse.Text = "浏览...";
            btnBrowse.SetBounds(390, 99, 80, 28);
            btnBrowse.Click += delegate
            {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选择安装目录";
                    dlg.SelectedPath = Directory.Exists(txtPath.Text) ? txtPath.Text : @"C:\";
                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        txtPath.Text = dlg.SelectedPath;
                    }
                }
            };

            progress.SetBounds(20, 140, 450, 18);
            progress.Minimum = 0;
            progress.Maximum = 100;

            btnInstall.Text = "开始安装";
            btnInstall.BackColor = Palette.Teal; // --teal
            btnInstall.ForeColor = Color.White;
            btnInstall.FlatStyle = FlatStyle.Flat;
            btnInstall.SetBounds(390, 160, 120, 34);
            btnInstall.Click += delegate { Install(); };

            Controls.AddRange(new Control[] { title, lbl, txtPath, btnBrowse, progress, btnInstall });
        }

        private void Install()
        {
            string target = txtPath.Text.Trim();
            if (target.Length == 0)
            {
                MessageBox.Show("请选择安装目录。", "DSH-Hotplug-Hub 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                string sourceRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
                if (!File.Exists(Path.Combine(sourceRoot, "release", "DSH-Hotplug-Hub.exe")))
                {
                    MessageBox.Show("找不到安装源（release\\DSH-Hotplug-Hub.exe）。\n请把 Setup.exe 放在 dsh-hotplug-hub 仓库的 installer 目录中运行。",
                        "DSH-Hotplug-Hub 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                btnInstall.Enabled = false;
                progress.Value = 5;

                Directory.CreateDirectory(target);
                WriteInstallRegistry(target);

                string[] folders = new string[]
                {
                    "release",
                    "launcher",
                    "assembly",
                    "sandbox",
                    "开发文档"
                };
                int total = folders.Length + 1;
                int step = 0;
                foreach (string folder in folders)
                {
                    string src = Path.Combine(sourceRoot, folder);
                    if (Directory.Exists(src))
                    {
                        CopyDirectory(src, Path.Combine(target, folder));
                    }
                    step++;
                    progress.Value = 10 + (int)((double)step / total * 70);
                    Application.DoEvents();
                }

                // release 里的 EXE/DLL 直接放在目标根目录，方便双击
                string releaseDir = Path.Combine(target, "release");
                if (Directory.Exists(releaseDir))
                {
                    foreach (string file in Directory.GetFiles(releaseDir))
                    {
                        string dest = Path.Combine(target, Path.GetFileName(file));
                        File.Copy(file, dest, true);
                    }
                }

                progress.Value = 85;
                Application.DoEvents();

                string exePath = Path.Combine(target, "DSH-Hotplug-Hub.exe");
                CreateShortcuts(exePath);

                // 内置全局运行时自动部署（node + pnpm）：软件自带负载，装完即全局可用；失败不阻塞安装
                string runtimeMsg = "";
                try
                {
                    progress.Value = 88;
                    Application.DoEvents();
                    runtimeMsg = DeployRuntime(target);
                }
                catch (Exception dex)
                {
                    runtimeMsg = "⚠ 全局运行时部署失败：" + dex.Message;
                }

                progress.Value = 100;
                DialogResult r = MessageBox.Show(
                    "安装完成！\n\n安装目录：\n" + target + "\n\n" + runtimeMsg + "\n\n是否立即启动？",
                    "DSH-Hotplug-Hub 安装程序",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information);
                if (r == DialogResult.Yes)
                {
                    System.Diagnostics.Process.Start(exePath);
                }
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装失败：\n" + ex.Message, "DSH-Hotplug-Hub 安装程序",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                btnInstall.Enabled = true;
                progress.Value = 0;
            }
        }

        // ---- 内置全局运行时自动部署（node + pnpm）----
        // 软件自带 node + pnpm 负载（installer/runtime/*.zip），安装时自动部署到全局：
        // 解压到 <安装目录>\runtime\<node|pnpm>，注册 User PATH（免管理员）并设置 PNPM_HOME。
        private static string DeployRuntime(string target)
        {
            string nodeVer = RunCli("node", "--version");
            // pnpm 在 Windows 上常为 pnpm.cmd / pnpm.ps1，UseShellExecute=false 直接 spawn "pnpm"
            // 只会解析原生 .exe → 误判「未安装」并重复部署内置 pnpm、抢占 PATH。经 cmd.exe /c 解析
            // 才能识别 npm 全局安装的 pnpm.cmd（与 Main.cs GetPnpmVersion 语义一致）。
            string pnpmVer = RunCli("cmd.exe", "/c pnpm --version");
            if (!string.IsNullOrEmpty(nodeVer) && !string.IsNullOrEmpty(pnpmVer))
            {
                return "✔ 检测到已存在全局 node " + nodeVer.Trim() + " / pnpm " + pnpmVer.Trim() + "，跳过部署";
            }

            string payloadDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runtime");
            var notes = new List<string>();

            // Node.js（自带 npm/npx）
            if (string.IsNullOrEmpty(nodeVer))
            {
                string nodeZip = Path.Combine(payloadDir, "node.zip");
                if (!File.Exists(nodeZip)) throw new Exception("缺少内置负载 " + nodeZip + "，请先用 installer\\download-runtime.ps1 准备");
                string nodeDir = Path.Combine(target, "runtime", "node");
                ExtractRuntimeZip(nodeZip, nodeDir, "node.exe");
                AddToUserPath(nodeDir);
                notes.Add("Node " + (RunCli(Path.Combine(nodeDir, "node.exe"), "--version") ?? "?").Trim());
            }

            // pnpm（standalone 原生 pnpm.exe，应用自检 Process.Start 可直接解析）
            if (string.IsNullOrEmpty(pnpmVer))
            {
                string pnpmZip = Path.Combine(payloadDir, "pnpm.zip");
                if (!File.Exists(pnpmZip)) throw new Exception("缺少内置负载 " + pnpmZip + "，请先用 installer\\download-runtime.ps1 准备");
                string pnpmDir = Path.Combine(target, "runtime", "pnpm");
                ExtractRuntimeZip(pnpmZip, pnpmDir, "pnpm.exe");
                AddToUserPath(pnpmDir);
                SetUserEnv("PNPM_HOME", pnpmDir);
                notes.Add("pnpm " + (RunCli(Path.Combine(pnpmDir, "pnpm.exe"), "--version") ?? "?").Trim());
            }

            return "✔ 已自动部署全局运行时：" + string.Join(" / ", notes) +
                   "\n已加入用户 PATH（新开的终端即全局可用）。";
        }

        private static void ExtractRuntimeZip(string zipPath, string destDir, string marker)
        {
            string staging = destDir + "_staging" + Guid.NewGuid().ToString("N").Substring(0, 8);
            string backup = destDir + "_old" + Guid.NewGuid().ToString("N").Substring(0, 8);
            bool destMoved = false;
            try
            {
                Directory.CreateDirectory(staging);
                ZipFile.ExtractToDirectory(zipPath, staging);
                // zip 顶层若带版本目录（如 node-v22.x-win-x64/），把内容上移
                var inner = new DirectoryInfo(staging).GetDirectories();
                if (inner.Length == 1 && File.Exists(Path.Combine(inner[0].FullName, marker)))
                {
                    foreach (var f in inner[0].GetFiles()) f.MoveTo(Path.Combine(staging, f.Name));
                    foreach (var d in inner[0].GetDirectories()) d.MoveTo(Path.Combine(staging, d.Name));
                    Directory.Delete(inner[0].FullName);
                }
                if (!File.Exists(Path.Combine(staging, marker)))
                {
                    throw new Exception("负载解压后未找到 " + marker + "（" + Path.GetFileName(zipPath) + "）");
                }
                // 原子替换：旧目录先改名腾位（同卷 rename 原子），staging 就位后再清理旧目录。
                // 修复旧「DeleteDirectoryQuiet 吞异常 + Directory.Move」：旧运行时被占用时
                // 半删半留 → 旧负载损坏、新负载被丢弃。
                if (Directory.Exists(destDir)) { Directory.Move(destDir, backup); destMoved = true; }
                Directory.Move(staging, destDir);
            }
            catch
            {
                // 替换失败：恢复被改名腾位的旧目录，避免留下空/损坏的运行时
                if (destMoved && !Directory.Exists(destDir))
                {
                    try { Directory.Move(backup, destDir); } catch { /* 旧负载留在 backup，不丢失 */ }
                }
                throw;
            }
            finally
            {
                if (Directory.Exists(staging)) DeleteDirectoryQuiet(staging);
            }
            // 成功：清理旧目录（尽力而为，新负载已就位）
            if (Directory.Exists(backup)) DeleteDirectoryQuiet(backup);
        }

        private static void DeleteDirectoryQuiet(string dir)
        {
            try { System.IO.Directory.Delete(dir, true); } catch { }
        }

        // 与 Main.cs RunCli 同一语义：UseShellExecute=false → 只解析原生 .exe；找不到返回 null。
        // 先异步接管 stdout/stderr 再等退出：ReadToEnd() 无限阻塞且 stderr 不读会写满缓冲区死锁，
        // 超时后 Kill 脱身（与 Main.cs RunCli 对齐，修复此处旧的「ReadToEnd 先于 WaitForExit」死锁）。
        private static string RunCli(string fileName, string arguments)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(fileName, arguments);
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    Task<string> stdout = p.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(5000))
                    {
                        try { p.Kill(); } catch { /* 尽力而为 */ }
                        try { p.WaitForExit(2000); } catch { /* 尽力而为 */ }
                    }
                    return stdout.Status == TaskStatus.RanToCompletion ? stdout.Result.Trim() : "";
                }
            }
            catch
            {
                return null;
            }
        }

        // 把目录加入用户 PATH（HKCU\Environment，REG_EXPAND_SZ，保留 %VAR% 原值）
        private static void AddToUserPath(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return;
            const string envKey = @"Environment";
            string userPath = "";
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(envKey, false))
            {
                if (k != null)
                {
                    object v = k.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames);
                    if (v != null) userPath = v.ToString();
                }
            }
            // 去重 + 前置插入收敛到 InstallUninstallContract.MergePathEntry（单一真源：
            // 忽略大小写 + 归一尾随反斜杠；旧 `parts.Contains(p)` 区分大小写 → 重装注入重复条目）
            userPath = InstallUninstallContract.MergePathEntry(userPath, dir);
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(envKey))
            {
                k.SetValue("Path", userPath, RegistryValueKind.ExpandString);
            }
        }

        private static void SetUserEnv(string name, string value)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Environment"))
            {
                k.SetValue(name, value, RegistryValueKind.ExpandString);
            }
        }

        // 记录安装目录到 HKCU\Software\DSH-Hotplug-Hub，供卸载器定位自定义安装路径
        // （修复「非默认目录 + 程序未运行」时卸载器检测失败、残留主程序与 PATH 悬空条目）
        private static void WriteInstallRegistry(string target)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\DSH-Hotplug-Hub"))
                {
                    k.SetValue("InstallDir", target, RegistryValueKind.String);
                }
            }
            catch { /* 注册表写入失败不阻塞安装 */ }
            // v1.1（PC21）：补齐 ARP 契约创建端——卸载器清理管线会删除
            // HKCU\...\Uninstall\DSH-Hotplug-Hub，但此前没有安装器创建它（程序不出现在
            // 「应用和功能」）。随装复制卸载器（源在仓库 uninstaller/hotplug-hub），UninstallString 指向它。
            try
            {
                string uninstallerSrc = Path.Combine(
                    Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..")),
                    "uninstaller", "hotplug-hub", "Uninstall_Hotplug_Hub.exe");
                string uninstallerDest = Path.Combine(target, "Uninstall_Hotplug_Hub.exe");
                if (File.Exists(uninstallerSrc) && !File.Exists(uninstallerDest))
                {
                    File.Copy(uninstallerSrc, uninstallerDest, true);
                }
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH-Hotplug-Hub"))
                {
                    k.SetValue("DisplayName", "Dseam世界 DSH-Hotplug-Hub", RegistryValueKind.String);
                    k.SetValue("DisplayVersion", "1.0.3", RegistryValueKind.String);
                    k.SetValue("DisplayIcon", Path.Combine(target, "DSH-Hotplug-Hub.exe") + ",0", RegistryValueKind.String);
                    k.SetValue("InstallLocation", target, RegistryValueKind.String);
                    k.SetValue("Publisher", "ARFCON", RegistryValueKind.String);
                    if (File.Exists(uninstallerDest))
                    {
                        k.SetValue("UninstallString", "\"" + uninstallerDest + "\"", RegistryValueKind.String);
                    }
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch { /* ARP 写入失败不阻塞安装 */ }
        }

        private static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (string file in Directory.GetFiles(source))
            {
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
            }
            foreach (string dir in Directory.GetDirectories(source))
            {
                CopyDirectory(dir, Path.Combine(target, Path.GetFileName(dir)));
            }
        }

        private static void CreateShortcuts(string exePath)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);

                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string startMenu = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    "DSH-Hotplug-Hub");

                Directory.CreateDirectory(startMenu);
                CreateShortcut(shell, Path.Combine(desktop, "DSH 热插拔中枢.lnk"), exePath, Path.GetDirectoryName(exePath));
                CreateShortcut(shell, Path.Combine(startMenu, "DSH 热插拔中枢.lnk"), exePath, Path.GetDirectoryName(exePath));
            }
            catch
            {
                // 快捷方式创建失败不阻塞安装
            }
        }

        private static void CreateShortcut(dynamic shell, string linkPath, string targetPath, string workDir)
        {
            dynamic sc = shell.CreateShortcut(linkPath);
            sc.TargetPath = targetPath;
            sc.WorkingDirectory = workDir;
            sc.Description = "DSH 热插拔中枢（独立启动器）";
            sc.Save();
        }
    }

    // ---- 设计令牌（与 dsh-pack-hub/prototype.html :root 同值；禁止另发明色值）----
    // 唯一权威色表见 开发文档/DSH-统一UI开发标准.md §2.1
    internal static class Palette
    {
        public static readonly Color Teal = Color.FromArgb(14, 124, 107);       // --teal
        public static readonly Color TealHover = Color.FromArgb(10, 106, 92);   // --teal-hover
        public static readonly Color Ink = Color.FromArgb(23, 32, 29);          // --ink
        public static readonly Color Panel = Color.FromArgb(255, 254, 249);     // --panel
        public static readonly Font UiFont = new Font("Microsoft YaHei UI", 9F);
        public static readonly Font TitleFont = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold);
    }
}