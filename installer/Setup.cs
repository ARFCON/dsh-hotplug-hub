using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

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

                progress.Value = 100;
                DialogResult r = MessageBox.Show(
                    "安装完成！\n\n安装目录：\n" + target + "\n\n是否立即启动？",
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