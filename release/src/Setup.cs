using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DseamWorldSetup
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            bool silent = false;
            string dir = null;
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--silent" || arg == "/S") silent = true;
                else if (arg == "--dir" && i + 1 < args.Length) { dir = args[++i]; }
                else if (arg.StartsWith("--dir=")) dir = arg.Substring("--dir=".Length);
                else if (arg.StartsWith("/D=")) dir = arg.Substring("/D=".Length);
            }

            if (silent)
            {
                Environment.Exit(SetupForm.SilentInstall(dir));
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }

    public sealed class SetupForm : Form
    {
        private const string AppFileName = "DSH-Hotplug-Hub.exe";
        private const string CoreDllFileName = "Microsoft.Web.WebView2.Core.dll";
        private const string WinFormsDllFileName = "Microsoft.Web.WebView2.WinForms.dll";
        private const string LoaderDllFileName = "WebView2Loader.dll";

        private TextBox _pathBox;
        private CheckBox _desktopCheck;
        private CheckBox _startMenuCheck;
        private CheckBox _runCheck;
        private Button _installButton;
        private Label _statusLabel;

        public SetupForm()
        {
            BuildUi();
        }

        private void BuildUi()
        {
            Text = "Dseam世界 DSH-Hotplug-Hub v1.0.1 安装程序";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(600, 330);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            Label title = new Label();
            title.Text = "Dseam世界 DSH-Hotplug-Hub v1.0.1";
            title.Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold, GraphicsUnit.Point);
            title.Location = new Point(24, 18);
            title.AutoSize = true;

            Label subtitle = new Label();
            subtitle.Text = "把软件安装到本机后，双击桌面 / 开始菜单图标即可直接使用。";
            subtitle.Location = new Point(26, 52);
            subtitle.AutoSize = true;
            subtitle.ForeColor = Color.FromArgb(90, 90, 90);

            Label pathLabel = new Label();
            pathLabel.Text = "安装位置：";
            pathLabel.Location = new Point(26, 90);
            pathLabel.AutoSize = true;

            _pathBox = new TextBox();
            _pathBox.Text = DefaultInstallDir();
            _pathBox.Location = new Point(110, 87);
            _pathBox.Width = 360;

            Button browse = new Button();
            browse.Text = "浏览…";
            browse.Location = new Point(480, 85);
            browse.Width = 80;
            browse.Click += delegate { BrowsePath(); };

            _desktopCheck = new CheckBox();
            _desktopCheck.Text = "创建桌面快捷方式";
            _desktopCheck.Checked = true;
            _desktopCheck.Location = new Point(110, 126);
            _desktopCheck.AutoSize = true;

            _startMenuCheck = new CheckBox();
            _startMenuCheck.Text = "创建开始菜单快捷方式";
            _startMenuCheck.Checked = true;
            _startMenuCheck.Location = new Point(110, 154);
            _startMenuCheck.AutoSize = true;

            _runCheck = new CheckBox();
            _runCheck.Text = "安装完成后立即运行";
            _runCheck.Checked = true;
            _runCheck.Location = new Point(110, 182);
            _runCheck.AutoSize = true;

            _installButton = new Button();
            _installButton.Text = "立即安装";
            _installButton.Location = new Point(110, 220);
            _installButton.Width = 120;
            _installButton.Height = 34;
            _installButton.Click += delegate { Install(); };

            _statusLabel = new Label();
            _statusLabel.Text = "准备就绪。";
            _statusLabel.Location = new Point(26, 280);
            _statusLabel.AutoSize = true;
            _statusLabel.ForeColor = Color.FromArgb(0, 124, 107);

            Controls.Add(title);
            Controls.Add(subtitle);
            Controls.Add(pathLabel);
            Controls.Add(_pathBox);
            Controls.Add(browse);
            Controls.Add(_desktopCheck);
            Controls.Add(_startMenuCheck);
            Controls.Add(_runCheck);
            Controls.Add(_installButton);
            Controls.Add(_statusLabel);
        }

        private static string DefaultInstallDir()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(local)) local = Path.Combine(Path.GetPathRoot(Environment.SystemDirectory), "Users", Environment.UserName, "AppData", "Local");
            return Path.Combine(local, "Programs", "DseamWorld");
        }

        private void BrowsePath()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 DSH-Hotplug-Hub 的安装位置";
                dialog.SelectedPath = _pathBox.Text.Trim();
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    _pathBox.Text = dialog.SelectedPath;
                }
            }
        }

        private void Install()
        {
            string dir = _pathBox.Text.Trim();
            if (dir.Length == 0)
            {
                MessageBox.Show(this, "请选择安装位置。", "Dseam世界", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            _installButton.Enabled = false;
            _statusLabel.Text = "正在安装…";
            Refresh();
            try
            {
                string appPath = InstallTo(dir, _desktopCheck.Checked, _startMenuCheck.Checked, _runCheck.Checked);
                _statusLabel.Text = "安装完成：" + appPath;
                MessageBox.Show(this, "安装完成。\n\n" + appPath, "Dseam世界", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "安装失败：" + ex.Message;
                MessageBox.Show(this, "安装失败：\n" + ex.Message, "Dseam世界", MessageBoxButtons.OK, MessageBoxIcon.Error);
                _installButton.Enabled = true;
            }
        }

        internal static int SilentInstall(string requestedDir)
        {
            string dir = string.IsNullOrEmpty(requestedDir) ? DefaultInstallDir() : requestedDir;
            try
            {
                InstallTo(dir, true, true, false);
                return 0;
            }
            catch (Exception ex)
            {
                try
                {
                    File.WriteAllText(Path.Combine(Path.GetTempPath(), "DSH-Hotplug-Hub-Setup.log"), ex.ToString());
                }
                catch
                {
                    // 日志写入失败不影响错误返回
                }
                return 1;
            }
        }

        private static string InstallTo(string dir, bool desktopShortcut, bool startMenuShortcut, bool runAfter)
        {
            Directory.CreateDirectory(dir);
            WriteInstallRegistry(dir);
            string appPath = Path.Combine(dir, AppFileName);
            WriteResource("DSHHotplugHub.Setup.app.exe", appPath);
            WriteResource("DSHHotplugHub.Setup.core.dll", Path.Combine(dir, CoreDllFileName));
            WriteResource("DSHHotplugHub.Setup.winforms.dll", Path.Combine(dir, WinFormsDllFileName));
            WriteResource("DSHHotplugHub.Setup.loader.dll", Path.Combine(dir, LoaderDllFileName));

            if (desktopShortcut)
            {
                try
                {
                    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    if (!string.IsNullOrEmpty(desktop)) CreateShortcut(Path.Combine(desktop, "DSH-Hotplug-Hub.lnk"), appPath, dir);
                }
                catch { /* 快捷方式创建失败不阻塞安装（文件已就位） */ }
            }
            if (startMenuShortcut)
            {
                try
                {
                    string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.StartMenu);
                    string programs = Path.Combine(startMenu, "Programs", "Dseam世界");
                    Directory.CreateDirectory(programs);
                    CreateShortcut(Path.Combine(programs, "DSH-Hotplug-Hub.lnk"), appPath, dir);
                }
                catch { /* 快捷方式创建失败不阻塞安装 */ }
            }

            if (runAfter)
            {
                try
                {
                    System.Diagnostics.Process.Start(appPath);
                }
                catch
                {
                    // 运行失败不阻塞安装结果
                }
            }
            return appPath;
        }

        // 记录安装目录到 HKCU\Software\DSH-Hotplug-Hub，供卸载器定位自定义安装路径
        private static void WriteInstallRegistry(string dir)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\DSH-Hotplug-Hub"))
                {
                    k.SetValue("InstallDir", dir, RegistryValueKind.String);
                }
            }
            catch
            {
                // 注册表写入失败不阻塞安装
            }
        }

        private static void WriteResource(string resourceName, string targetPath)        {
            Assembly assembly = typeof(SetupForm).Assembly;
            using (Stream stream = assembly.GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new InvalidOperationException("安装包缺少资源：" + resourceName);
                using (FileStream output = new FileStream(targetPath, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[81920];
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                    }
                }
            }
        }

        private static void CreateShortcut(string lnkPath, string targetPath, string workingDir)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { lnkPath });
            if (shortcut == null) return;
            Type shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
            shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath + ",0" });
            shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Dseam世界 DSH-Hotplug-Hub" });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
    }
}
