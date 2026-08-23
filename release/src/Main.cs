using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DSHHotplugHub
{
    internal static class Program
    {
        // ===== 进程模型契约（v1.1）=====
        // 主程序  ：正常入口（单实例 LocalDseamWorld-DSH-Hotplug-Hub），承载管理 UI。
        // DSH 程序："--harness-window" 参数入口（单实例 LocalDseamWorld-DSH-Harness-Window），
        //           由主程序 Process.Start 拉起 —— 与主程序【完全分离的进程】，仅通过
        //           %LOCALAPPDATA%\DSH-Hotplug-Hub\harness-port.txt 共享 dsh web 端口。
        //           重复拉起时通过注册窗口消息 WM_DSH_HARNESS_FOCUS 让已开窗口置前。
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegisterWindowMessage(string name);
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        private const int HWND_BROADCAST = 0xFFFF;
        internal static readonly int WM_DSH_HARNESS_FOCUS = RegisterWindowMessage("LocalDseamWorld-DSH-Harness-Focus");
        internal static readonly int WM_DSH_MAIN_FOCUS = RegisterWindowMessage("LocalDseamWorld-DSH-Main-Focus");

        [STAThread]
        private static void Main()
        {
            // DSH 独立程序模式：与主程序分进程运行，不受主程序单实例互斥限制
            string[] cmdline = Environment.GetCommandLineArgs();
            for (int i = 1; i < cmdline.Length; i++)
            {
                if (string.Equals(cmdline[i], "--harness-window", StringComparison.OrdinalIgnoreCase))
                {
                    RunHarnessWindow();
                    return;
                }
            }

            Mutex mutex;
            if (!ShellContract.TryAcquireSingleInstance(@"LocalDseamWorld-DSH-Hotplug-Hub", out mutex))
            {
                // 已有存活实例：广播聚焦消息，唤起已隐藏到托盘的窗口（README「重复打开只唤起已有窗口」）。
                try { PostMessage((IntPtr)HWND_BROADCAST, WM_DSH_MAIN_FOCUS, IntPtr.Zero, IntPtr.Zero); } catch { /* 有意吞掉：聚焦失败不影响主流程 */ }
                return;
            }
            try
            {
                SetProcessDPIAware();
                try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { /* 有意吞掉：进程已退出，尽力释放 */ }
                try { mutex.Dispose(); } catch { /* 有意吞掉 */ }
            }
        }

        /// <summary>DSH 独立程序入口：只承载官方 harness web UI 的窗口（独立进程、独立任务栏项）。</summary>
        private static void RunHarnessWindow()
        {
            // 互斥获取带重试：修复配置后的重启是「先起新进程、旧进程再退出」，新进程需等旧实例释放互斥
            for (int attempt = 0; ; attempt++)
            {
                Mutex harnessMutex;
                if (ShellContract.TryAcquireSingleInstance(@"LocalDseamWorld-DSH-Harness-Window", out harnessMutex))
                {
                    try
                    {
                        SetProcessDPIAware();
                        try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { /* 有意吞掉 */ }
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        Application.Run(new HarnessHostForm());
                        return;
                    }
                    finally
                    {
                        try { harnessMutex.ReleaseMutex(); } catch { /* 有意吞掉：进程已退出，尽力释放 */ }
                        try { harnessMutex.Dispose(); } catch { /* 有意吞掉 */ }
                    }
                }
                if (attempt == 0)
                {
                    // 已有一个 DSH 独立窗口：先广播聚焦消息让已开窗口置前
                    BroadcastHarnessFocus();
                }
                // 若那是正在退出的旧实例（重启场景），最多再等 ~3.6s 争用互斥；否则本进程静默退出
                if (attempt >= 12) return;
                Thread.Sleep(300);
            }
        }

        /// <summary>广播聚焦消息，唤起已打开的 DSH 独立窗口（重复拉起/退出聚焦语义单一真源）。</summary>
        internal static void BroadcastHarnessFocus()
        {
            try { PostMessage((IntPtr)HWND_BROADCAST, WM_DSH_HARNESS_FOCUS, IntPtr.Zero, IntPtr.Zero); } catch { /* 有意吞掉：聚焦失败不影响主流程 */ }
        }

        /// <summary>读取窗口状态 {w,h,max}，w/h 已按当前主屏工作区钳制（防换屏/拔显示器后越界）；无记录时返回钳制后的默认尺寸。</summary>
        internal static int[] LoadWindowStateClamped(string file, int minW, int minH, int defW, int defH)
        {
            int w = defW, h = defH, max = 0;
            try
            {
                int[] parsed = ShellContract.ParseWindowState(File.ReadAllText(file), minW, minH);
                if (parsed != null) { w = parsed[0]; h = parsed[1]; max = parsed[2]; }
            }
            catch { /* 无记录/损坏：用默认尺寸 */ }
            int maxW = Screen.PrimaryScreen.WorkingArea.Width;
            int maxH = Screen.PrimaryScreen.WorkingArea.Height;
            int[] c = ShellContract.ClampWindowSize(w, h, minW, minH, maxW, maxH);
            return new int[] { c[0], c[1], max };
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }

    // =====================================================================================
    // DSH 独立程序窗口（v1.1 · --harness-window 进程的唯一窗体）
    //
    // 契约：
    // · 与主程序完全分离的进程，仅共享 harness-port.txt（dsh web 端口）；
    // · 标题栏控制按钮自右向左：×关闭 / □最大化 / —最小化（功能保留）/ ⚙设置（最小化左侧）；
    // · 「⚙ 设置」点击从按钮位置缓出分层设置面板；
    // · 设置面板为独立顶层无边框窗（CS_DROPSHADOW 阴影 + easeOutCubic 滑出 + 透明度渐入），
    //   覆盖在 WebView2 上方（规避 WebView2 airspace 限制），不与页面内任何面板冲突；
    // · 面板项：作者（项目）仓库 / 官网插件市场 / 修复配置（二次确认→修复→重启）/
    //           重新加载 / 关闭。
    // =====================================================================================
    internal sealed class HarnessHostForm : Form
    {
        private readonly WebView2 webView = new WebView2();
        private readonly Panel titleBar;
        private readonly Label titleLabel;
        private readonly Label statusLabel;
        private readonly Button btnSettings;
        private readonly Button btnMin;
        private readonly Button btnMax;
        private readonly Button btnClose;
        private const int TITLE_H = 36;
        private const int resizeBorder = 6;
        private Process dshProc = null;     // 本进程自行启动的 dsh web（关闭时负责回收）
        private int dshPort = 0;
        private HarnessSettingsPopup settingsPopup = null;

        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
        [DllImport("user32.dll")] private static extern bool SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h);
        private const int WM_NCLBUTTONDOWN = 0xA1, HTCAPTION = 0x2, WM_NCHITTEST = 0x84;

        public HarnessHostForm()
        {
            Text = "DSH";
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.FromArgb(30, 41, 59);
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            int[] saved = LoadState();
            Size = new Size(saved[0], saved[1]);
            MinimumSize = new Size(640, 480);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* 图标失败不影响使用 */ }

            // 标题栏：标题 + ⚙设置（最小化左侧）—最小化 □最大化 ×关闭（最小化功能保留）
            titleBar = new Panel { Dock = DockStyle.Top, Height = TITLE_H, BackColor = Color.FromArgb(30, 41, 59) };
            titleLabel = new Label
            {
                Text = "DSH 对话 · DeepSeek Harness",
                ForeColor = Color.FromArgb(229, 231, 235),
                Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Regular),
                AutoSize = false, TextAlign = ContentAlignment.MiddleLeft,
                Left = 12, Top = 0, Height = TITLE_H, Width = 360, Cursor = Cursors.SizeAll
            };
            btnSettings = MakeTitleButton("⚙", delegate { ToggleSettingsPopup(); }, false, "设置");
            btnMin = MakeTitleButton("—", delegate { WindowState = FormWindowState.Minimized; }, false, "最小化");
            btnMax = MakeTitleButton("□", delegate { ToggleMaximize(); }, false, "最大化 / 还原");
            btnClose = MakeTitleButton("×", delegate { Close(); }, true, "关闭");
            titleBar.Controls.Add(titleLabel);
            titleBar.Controls.Add(btnSettings);
            titleBar.Controls.Add(btnMin);
            titleBar.Controls.Add(btnMax);
            titleBar.Controls.Add(btnClose);
            titleBar.SizeChanged += delegate { LayoutTitleButtons(); };
            LayoutTitleButtons();
            titleBar.MouseDown += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) BeginDrag(); };
            titleLabel.MouseDown += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) BeginDrag(); };

            // 引导状态覆盖层（连接 dsh / 启动中 / 失败提示），导航成功后隐藏
            statusLabel = new Label
            {
                Text = "正在连接 DSH 服务…",
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(148, 163, 184),
                BackColor = Color.FromArgb(30, 41, 59),
                Font = new Font("Microsoft YaHei UI", 10.5F, FontStyle.Regular)
            };

            webView.DefaultBackgroundColor = Color.FromArgb(30, 41, 59);
            Controls.Add(webView);
            Controls.Add(titleBar);
            Controls.Add(statusLabel);
            statusLabel.BringToFront();
            titleBar.BringToFront();

            // 窗口移动/缩放时设置面板立即收起（面板锚定按钮位置，避免错位重叠）
            LocationChanged += delegate { CloseSettingsPopup(); };
            // 圆角随 Resize 重设（程序化最大化/还原也触发 Resize，ResizeEnd 仅用户拖动结束触发；
            // 仅用 ResizeEnd 会让程序化最大化不清除圆角区域 → 窗口被旧尺寸圆角裁剪）
            Resize += delegate { CloseSettingsPopup(); LayoutWebView(); ReapplyRound(); };

            Load += async delegate (object s, EventArgs e)
            {
                LayoutWebView();
                ReapplyRound();
                if (saved[2] == 1)
                {
                    MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                    WindowState = FormWindowState.Maximized;
                    btnMax.Text = "❐";
                }
                await BootstrapAsync();
            };
            FormClosing += delegate
            {
                SaveState();
                StopOwnDsh();
            };
        }

        // ---- dsh web 引导：端口文件 → 本机探测 → 自行启动（与主程序同一优先级契约） ----
        private async Task BootstrapAsync()
        {
            int port = MainForm.ReadHarnessPortFile();
            if (port <= 0 || !MainForm.WaitForPortReady(port, 1200))
            {
                port = MainForm.ScanLocalHttpPort();
                if (port > 0 && !MainForm.WaitForPortReady(port, 400)) port = 0; // 探测结果需核实监听
            }
            if (port <= 0)
            {
                SetStatus("正在启动 dsh web 服务…");
                dshProc = MainForm.StartDshWebProcess(out port);
                if (dshProc != null)
                {
                    dshPort = port;
                    MainForm.WriteHarnessPortFile(port);
                    await Task.Run(delegate { MainForm.WaitForPortReady(port, 20000); });
                }
            }
            if (port <= 0)
            {
                SetStatus("未找到 dsh 服务：请先在 Dseam世界 主程序点击「启动 DSH」或到自检页安装环境");
                return;
            }
            dshPort = port;
            try
            {
                // 独立进程用独立 WebView2 用户数据目录（与主程序环境互不干扰）
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DSH-Hotplug-Hub", "WebView2-Harness");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
                await webView.EnsureCoreWebView2Async(env);
                webView.CoreWebView2.NavigationCompleted += delegate (object s, CoreWebView2NavigationCompletedEventArgs e)
                {
                    try { statusLabel.Visible = false; } catch { /* 有意吞掉 */ }
                };
                webView.CoreWebView2.Navigate("http://127.0.0.1:" + port + "/");
                titleLabel.Text = "DSH 对话 · 127.0.0.1:" + port;
            }
            catch (Exception ex)
            {
                SetStatus("WebView 初始化失败：" + ex.Message);
                return;
            }
            titleBar.BringToFront();
        }

        private void SetStatus(string text)
        {
            try
            {
                statusLabel.Text = text;
                statusLabel.Visible = true;
                statusLabel.BringToFront();
            }
            catch { /* 有意吞掉 */ }
        }

        private void StopOwnDsh()
        {
            try
            {
                if (dshProc != null && !dshProc.HasExited)
                {
                    Process.Start(new ProcessStartInfo("taskkill", "/F /T /PID " + dshProc.Id)
                    { UseShellExecute = false, CreateNoWindow = true });
                }
            }
            catch { /* 有意吞掉 */ }
            // 端口文件若由本窗写入（自行启动 dsh web 时），随服务一起清掉，避免残留过期端口
            if (dshProc != null)
            {
                try { File.Delete(MainForm.HarnessPortFile()); } catch { /* 有意吞掉 */ }
            }
            dshProc = null;
            dshPort = 0;
        }

        // ---- 设置面板：从设置按钮位置缓出（分层 · 不与页面内面板冲突） ----
        private void ToggleSettingsPopup()
        {
            if (settingsPopup != null && !settingsPopup.IsDisposed)
            {
                settingsPopup.Close();
                return;
            }
            // 锚点 = 设置按钮的右下角（面板右缘与按钮对齐，向下缓出）
            Point anchor = titleBar.PointToScreen(new Point(btnSettings.Right, btnSettings.Bottom));
            settingsPopup = new HarnessSettingsPopup(
                anchor,
                OpenRepo,
                OpenMarket,
                RunRepairWithRestart,
                ReloadPage,
                delegate { Close(); });
            settingsPopup.Owner = this;
            settingsPopup.FormClosed += delegate { settingsPopup = null; };
            settingsPopup.Show(this);
        }

        private void CloseSettingsPopup()
        {
            try { if (settingsPopup != null && !settingsPopup.IsDisposed) settingsPopup.Close(); } catch { /* 有意吞掉 */ }
            settingsPopup = null;
        }

        private static void OpenUrl(string url)
        {
            try { Process.Start(url); } catch { /* 有意吞掉：浏览器打不开不影响主流程 */ }
        }

        private void OpenRepo()
        {
            OpenUrl(MainForm.ProjectRepoUrl());
        }

        private void OpenMarket()
        {
            // 官网插件市场 = 插件市场页的真实数据源（GitHub topic:dsh-plugin 仓库检索）
            OpenUrl("https://github.com/search?q=topic%3Adsh-plugin&type=repositories");
        }

        private void ReloadPage()
        {
            try { if (webView.CoreWebView2 != null) webView.CoreWebView2.Reload(); } catch { /* 有意吞掉 */ }
        }

        /// <summary>修复配置：二次确认 → RepairDshConfig → 重启本独立程序（相同启动参数）。</summary>
        private void RunRepairWithRestart()
        {
            DialogResult first = MessageBox.Show(this,
                "确定要修复 dsh 配置文件吗？\n\n将检查并修复 ~/.dsh 下已知的损坏：\n· settings.yaml 重复键\n· .credentials.yaml 格式错误\n\n修复会直接改写这些文件。",
                "DSH · 修复配置", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (first != DialogResult.Yes) return;
            DialogResult second = MessageBox.Show(this,
                "二次确认：修复完成后 DSH 程序将自动重启，当前会话会被中断。\n确定继续吗？",
                "DSH · 修复配置 · 二次确认", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (second != DialogResult.Yes) return;
            string result = MainForm.RepairDshConfig();
            MessageBox.Show(this, result + "\n\nDSH 程序即将重启…", "DSH · 修复配置",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            CloseSettingsPopup();
            // 先起新进程再退出本进程（不用 Application.Restart：旧互斥未释放时新实例会竞态失败；
            //   新进程入口带互斥重试等待，本进程 Close 释放互斥后它立即接管）
            try { Process.Start(Application.ExecutablePath, "--harness-window"); } catch { /* 有意吞掉 */ }
            Close();
        }

        // ---- 标题栏与窗口形状（沿用主窗设计语言） ----
        private void LayoutTitleButtons()
        {
            btnClose.Left = titleBar.Width - 46;
            btnMax.Left = titleBar.Width - 92;
            btnMin.Left = titleBar.Width - 138;
            btnSettings.Left = titleBar.Width - 184; // 设置位于最小化左侧
        }

        private void LayoutWebView()
        {
            webView.SetBounds(
                resizeBorder,
                TITLE_H + resizeBorder,
                Math.Max(1, ClientSize.Width - resizeBorder * 2),
                Math.Max(1, ClientSize.Height - TITLE_H - resizeBorder * 2));
            try { statusLabel.SetBounds(webView.Bounds.X, webView.Bounds.Y, webView.Bounds.Width, webView.Bounds.Height); } catch { /* 有意吞掉 */ }
        }

        private void ToggleMaximize()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                MaximizedBounds = Rectangle.Empty;
                WindowState = FormWindowState.Normal;
                btnMax.Text = "□";
            }
            else
            {
                MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                WindowState = FormWindowState.Maximized;
                btnMax.Text = "❐";
            }
        }

        private Button MakeTitleButton(string text, EventHandler onClick, bool danger, string tooltip)
        {
            Button b = new Button();
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = danger ? Color.FromArgb(220, 38, 38) : Color.FromArgb(55, 65, 81);
            b.BackColor = Color.FromArgb(30, 41, 59);
            b.ForeColor = danger ? Color.FromArgb(248, 113, 113) : Color.FromArgb(229, 231, 235);
            b.Font = new Font("Segoe UI Symbol", 10F, FontStyle.Regular);
            b.Size = new Size(40, TITLE_H);
            b.Top = 0;
            b.Cursor = Cursors.Hand;
            b.TabIndex = 0;
            b.TabStop = false;
            b.Click += onClick;
            try { b.AccessibleName = tooltip; } catch { /* 有意吞掉 */ }
            return b;
        }

        private void BeginDrag()
        {
            try { BeginInvoke((Action)(() => DragWindow())); } catch { /* 有意吞掉 */ }
        }

        private void DragWindow()
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }

        private void ReapplyRound()
        {
            try
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    SetWindowRgn(Handle, IntPtr.Zero, true);
                }
                else
                {
                    IntPtr rgn = CreateRoundRectRgn(0, 0, Width, Height, 16, 16);
                    SetWindowRgn(Handle, rgn, true);
                }
            }
            catch { /* 圆角失败不影响使用 */ }
        }

        // ---- 窗口尺寸持久化（与主程序/harness 内嵌窗各自独立，互不覆盖） ----
        private static string StatePath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSH-Hotplug-Hub", "harness-standalone-window-state.txt");
        }

        private static int[] LoadState()
        {
            return Program.LoadWindowStateClamped(StatePath(), 640, 480, 1280, 800);
        }

        private void SaveState()
        {
            try
            {
                int[] s = ShellContract.ResolveWindowState(
                    WindowState == FormWindowState.Normal,
                    WindowState == FormWindowState.Maximized,
                    Bounds.Width, Bounds.Height, RestoreBounds.Width, RestoreBounds.Height);
                if (s[0] < 640 || s[1] < 480) return;
                string file = StatePath();
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, ShellContract.SerializeWindowState(s[0], s[1], s[2] == 1));
            }
            catch { /* 有意吞掉 */ }
        }

        protected override void WndProc(ref Message m)
        {
            // 主程序重复拉起 DSH 独立程序时，广播聚焦消息 → 本窗口置前
            if (m.Msg == Program.WM_DSH_HARNESS_FOCUS)
            {
                try
                {
                    // 聚焦/唤起目标状态决议（契约）：最小化→Normal；最大化保持（与主窗 ShowMainForm 统一）。
                    WindowState = (FormWindowState)ShellContract.ResolveShowWindowState((int)WindowState);
                    SetForegroundWindow(Handle); // 与主窗 ShowMainForm 一致：显式抢占前台，Activate 可能被前台锁拦截
                    Activate();
                }
                catch { /* 有意吞掉 */ }
                return;
            }
            if (m.Msg == WM_NCHITTEST)
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    base.WndProc(ref m);
                    return;
                }
                // 无边框边缘命中：顶部可调边位于标题栏下缘（titleBarH=TITLE_H），收敛到 ShellContract.HitTestResizeEdge
                long lp = m.LParam.ToInt64();
                int sx = (short)(lp & 0xFFFF);
                int sy = (short)((lp >> 16) & 0xFFFF);
                Point pt = PointToClient(new Point(sx, sy));
                int hit = ShellContract.HitTestResizeEdge(pt.X, pt.Y, ClientSize.Width, ClientSize.Height, resizeBorder, TITLE_H);
                if (hit != 0)
                {
                    m.Result = (IntPtr)hit;
                }
                else
                {
                    base.WndProc(ref m);
                }
                return;
            }
            base.WndProc(ref m);
        }

        // =================================================================================
        // 设置面板（v1.1）：独立顶层无边框窗 —— 从锚点位置 easeOutCubic 缓出 + 透明度渐入，
        // CS_DROPSHADOW 提供层次感；位于 WebView2 上方的独立层，不与页面内面板冲突/重叠。
        // =================================================================================
        private sealed class HarnessSettingsPopup : Form
        {
            private const int CS_DROPSHADOW = 0x00020000;
            private const int FRAMES = 12;      // ~190ms @16ms/帧
            private readonly System.Windows.Forms.Timer anim = new System.Windows.Forms.Timer();
            private readonly int startY, targetY;
            private int frame = 0;

            public HarnessSettingsPopup(Point anchor, Action onRepo, Action onMarket, Action onRepair, Action onReload, Action onClose)
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                BackColor = Color.FromArgb(23, 31, 44);
                Size = new Size(252, 312);
                DoubleBuffered = true;
                // 右缘与设置按钮对齐，起点略高于锚点（从按钮位置"缓出"）
                targetY = anchor.Y + 6;
                startY = anchor.Y - 12;
                Left = anchor.X - Width;
                Top = startY;

                BuildUi(onRepo, onMarket, onRepair, onReload, onClose);
                Deactivate += delegate { Close(); }; // 点击面板外任意处收起
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ClassStyle |= CS_DROPSHADOW;
                    return cp;
                }
            }

            private void BuildUi(Action onRepo, Action onMarket, Action onRepair, Action onReload, Action onClose)
            {
                var head = new Label
                {
                    Text = "⚙  DSH 设置",
                    ForeColor = Color.FromArgb(148, 163, 184),
                    Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
                    AutoSize = false,
                    Left = 14, Top = 10, Width = 210, Height = 26,
                    TextAlign = ContentAlignment.MiddleLeft
                };
                Controls.Add(head);
                int y = 40;
                y = AddItem("🏠  作者（项目）仓库", onRepo, y, Color.FromArgb(226, 232, 240));
                y = AddItem("🛍  官网插件市场", onMarket, y, Color.FromArgb(226, 232, 240));
                y = AddSeparator(y);
                y = AddItem("🛠  修复配置…", onRepair, y, Color.FromArgb(245, 158, 11));
                y = AddItem("↻  重新加载", onReload, y, Color.FromArgb(226, 232, 240));
                y = AddSeparator(y);
                y = AddItem("✕  关闭", onClose, y, Color.FromArgb(248, 113, 113));
            }

            private int AddItem(string text, Action onClick, int y, Color fore)
            {
                Button b = new Button();
                b.Text = text;
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderSize = 0;
                b.FlatAppearance.MouseOverBackColor = Color.FromArgb(38, 50, 70);
                b.BackColor = Color.FromArgb(23, 31, 44);
                b.ForeColor = fore;
                b.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Regular);
                b.TextAlign = ContentAlignment.MiddleLeft;
                b.SetBounds(8, y, 236, 40);
                b.Cursor = Cursors.Hand;
                b.TabIndex = 0;
                b.TabStop = false;
                b.Click += delegate { onClick(); };
                Controls.Add(b);
                return y + 44;
            }

            private int AddSeparator(int y)
            {
                var sep = new Panel { BackColor = Color.FromArgb(38, 50, 70), Bounds = new Rectangle(14, y + 2, 224, 1) };
                Controls.Add(sep);
                return y + 10;
            }

            protected override void OnLoad(EventArgs e)
            {
                base.OnLoad(e);
                Opacity = 0; // 缓出动画：起点即按钮位置（透明），向下 18px + 渐显
                anim.Interval = 16;
                anim.Tick += AnimStep;
                anim.Start();
            }

            private void AnimStep(object sender, EventArgs e)
            {
                frame++;
                double t = Math.Min(1.0, (double)frame / FRAMES);
                double ease = 1 - Math.Pow(1 - t, 3); // easeOutCubic（缓出）
                Top = (int)Math.Round(startY + (targetY - startY) * ease);
                Opacity = ease;
                if (frame >= FRAMES)
                {
                    anim.Stop();
                    Opacity = 1;
                    Top = targetY;
                }
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing)
                {
                    anim.Stop();
                    anim.Dispose();
                }
                base.Dispose(disposing);
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 webView = new WebView2();

        // 无边框拖拽 / 圆角相关 Win32
        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        private static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
        [DllImport("user32.dll")]
        private static extern bool SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect, int nWidthEllipse, int nHeightEllipse);
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;
        // 无边框窗口边缘拖拽调整大小：WM_NCHITTEST 命中区（命中判定见 ShellContract.HitTestResizeEdge）
        private const int WM_NCHITTEST = 0x84;
        private const int resizeBorder = 6; // 边缘 6px 视为调整大小区

        private const string APP_VERSION = "1.0.1";
        private const string PROJECT_REPO = "ARFCON/dsh-hotplug-hub";
        private const string PANEL_VERSION = "0.8.1-pre"; // 内置 Skill/MCP 管理器（dseam-skillmcp）当前版本
        private const string MEMORY_HUB_VERSION = "0.8.0-pre"; // 内置全局记忆插件（dsh-memory-hub）当前版本
        private const string DSH_HUB_VERSION = "1.1.8"; // 内置插件中枢（dsh-hub）当前版本

        // GitHub API 结果的会话级缓存：避免每次插件列表刷新都同步打 API、离线时反复等 15s 超时
        private static readonly Dictionary<string, KeyValuePair<DateTime, Dictionary<string, object>>> _githubCache =
            new Dictionary<string, KeyValuePair<DateTime, Dictionary<string, object>>>();
        // GitHub Token 不再硬编码进源码（仓库会触发 secret scanning）。
        // 有速率限制时可设置环境变量 DSH_HUB_GITHUB_TOKEN，或写入 ~/.dsh/github-token.txt。
        private static string GetGithubToken()
        {
            try
            {
                string env = Environment.GetEnvironmentVariable("DSH_HUB_GITHUB_TOKEN");
                if (!string.IsNullOrEmpty(env)) return env.Trim();
                string file = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".dsh", "github-token.txt");
                if (File.Exists(file))
                {
                    string t = File.ReadAllText(file).Trim();
                    if (t.Length > 0) return t;
                }
            }
            catch
            {
            }
            return null;
        }
        private static bool _updateNotified = false;
        private NotifyIcon _trayIcon = null;
        private bool _allowExit = false;
        private bool _trayReady = false; // 托盘图标创建成功才为 true（失败时关闭应退出，而非藏入不可恢复的托盘）
        private Process _harnessProc = null;   // 官方 harness 主进程引用（用于停止）
        private int _harnessPort = 0;          // 探测到的 harness web 端口
        private Form _harnessEmbedForm = null; // 内嵌弹窗
        private Form _harnessPopoutForm = null;// 跳出独立窗口
        private CoreWebView2Environment _env = null; // 共享 WebView2 环境（内嵌/跳出窗口复用）
        private Process _standaloneHarnessProc = null; // v1.1：DSH 独立程序进程（--harness-window）

        // ===== v1.1 跨进程共享契约（主程序 ↔ DSH 独立程序）=====
        // 端口文件是两个进程间唯一的握手媒介：启动 dsh web 的一方写入，DSH 独立程序读取连接。
        internal static string HarnessPortFile()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSH-Hotplug-Hub", "harness-port.txt");
        }
        internal static void WriteHarnessPortFile(int port)
        {
            try
            {
                string file = HarnessPortFile();
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, port.ToString());
            }
            catch { /* 有意吞掉：写失败时 DSH 独立程序走端口探测兜底 */ }
        }
        internal static int ReadHarnessPortFile()
        {
            try
            {
                int port;
                if (int.TryParse(File.ReadAllText(HarnessPortFile()).Trim(), out port) && port > 0) return port;
            }
            catch { /* 有意吞掉 */ }
            return 0;
        }
        internal static string ProjectRepoUrl()
        {
            return "https://github.com/" + PROJECT_REPO;
        }

        /// <summary>兜底端口探测：取本机监听 127.0.0.1/0.0.0.0 的最大端口号（最新启动的服务）。</summary>
        internal static int ScanLocalHttpPort()
        {
            List<int> candidates = new List<int>();
            try
            {
                foreach (var l in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                {
                    if (l.Address.Equals(IPAddress.Loopback) || l.Address.Equals(IPAddress.Any))
                    {
                        candidates.Add(l.Port);
                    }
                }
            }
            catch { /* 探测失败返回 0 */ }
            candidates.Sort();
            return candidates.Count > 0 ? candidates[candidates.Count - 1] : 0;
        }

        /// <summary>启动 dsh web 子进程（主程序与 DSH 独立程序共用的唯一启动契约）；失败返回 null。</summary>
        internal static Process StartDshWebProcess(out int port)
        {
            port = 0;
            string[] dshCmd = FindDshCommand();
            if (dshCmd == null || dshCmd.Length < 2) return null;
            int free = GetFreeTcpPort();
            if (free <= 0) free = 61890;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(dshCmd[0], dshCmd[1] + " web --host 127.0.0.1 --port " + free + " --no-open");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process p = Process.Start(psi);
                port = free;
                return p;
            }
            catch
            {
                return null;
            }
        }

        public MainForm()
        {
            Text = "Dseam世界";
            // 默认舒适尺寸 1240x820；若上次有关闭前记录的尺寸则恢复（已按当前主屏工作区钳制，防换屏越界）
            int[] saved = LoadWindowState();
            Width = saved[0];
            Height = saved[1];
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            // 无边框设计：去掉系统标题栏/边框，自绘窗口控制（最小化/关闭按钮在 UI 顶部）
            FormBorderStyle = FormBorderStyle.None;
            // 圆角窗口（与 UI 卡片圆角呼应）；窗口尺寸变化时重设圆角
            Load += (s, e) =>
            {
                ReapplyRoundRegion();
                // 上次是最大化关闭的，则本次恢复最大化（留出任务栏，与 winMax/harness 窗一致）
                if (saved[2] == 1)
                {
                    MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                    WindowState = FormWindowState.Maximized;
                }
            };
            // 圆角随 Resize 重设：程序化最大化/还原也触发 Resize，而 ResizeEnd 仅在用户拖动结束时触发。
            // 若仅用 ResizeEnd，程序化最大化不会清除圆角区域 → 窗口被旧尺寸圆角裁剪（与 harness 窗统一修复）。
            Resize += (s, e) => ReapplyRoundRegion();
            // 浅色主题背景（与页面 --bg 一致）：避免无边框后加载/关闭瞬间露出系统默认底色（也作为四周 6px 调整大小边框的颜色）
            BackColor = Color.FromArgb(246, 247, 249);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { Icon = SystemIcons.Application; }

            // 关键：WebView2 不能 Dock.Fill 铺满窗口，否则鼠标在边缘命中的是 WebView2 子窗口，
            // 窗体的 WM_NCHITTEST 收不到、边缘无法拖拽调整大小。
            // 这里让 WebView2 四周各留 resizeBorder(=6px) 空隙，露出窗体自身作为可拖拽边框。
            webView.DefaultBackgroundColor = Color.FromArgb(246, 247, 249);
            webView.SetBounds(resizeBorder, resizeBorder, ClientSize.Width - resizeBorder * 2, ClientSize.Height - resizeBorder * 2);
            webView.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;

            Controls.Add(webView);
            Load += async delegate { await InitializeAsync(); };
            FormClosing += (sender, e) =>
            {
                // 统一关闭语义（单一真源 ShellContract.ShouldHideToTray）：
                if (ShellContract.ShouldHideToTray(_trayReady, _allowExit))
                {
                    // 托盘可用且非显式退出 → 记录尺寸 + 关闭 harness 子窗 + 隐藏到托盘常驻。
                    SaveWindowState();  // 记录本次窗口尺寸（含最大化标志，RestoreBounds）
                    CloseHarnessChildForms();
                    e.Cancel = true;
                    HideMainSafely();
                    return;
                }
                // 不藏托盘：显式退出（ExitApplication 已整体回收资源）或托盘不可用。
                // 托盘不可用时在此整体回收资源并放行关闭，避免窗口藏入无恢复途径的托盘、
                // 也避免直接退出时遗留 dsh web / DSH 独立程序孤儿进程。
                if (!_allowExit)
                {
                    _allowExit = true;
                    SaveWindowState();
                    CleanupAndExit();
                }
            };
            SetupTray();
        }

        // 无边框拖拽：从 WebView 收到 winDrag 消息时，让窗口跟随鼠标拖动
        private void BeginWindowDrag()
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }

        // 解析 CSS 颜色字符串（#rrggbb / #rgb）为 Color；失败返回 null
        private static Color? ParseCssColor(string css)
        {
            if (string.IsNullOrEmpty(css)) return null;
            string s = css.Trim().TrimStart('#');
            try
            {
                if (s.Length == 6)
                {
                    int r = Convert.ToInt32(s.Substring(0, 2), 16);
                    int g = Convert.ToInt32(s.Substring(2, 2), 16);
                    int b = Convert.ToInt32(s.Substring(4, 2), 16);
                    return Color.FromArgb(r, g, b);
                }
                if (s.Length == 3)
                {
                    int r = Convert.ToInt32(new string(s[0], 2), 16);
                    int g = Convert.ToInt32(new string(s[1], 2), 16);
                    int b = Convert.ToInt32(new string(s[2], 2), 16);
                    return Color.FromArgb(r, g, b);
                }
            }
            catch { /* 解析失败返回 null */ }
            return null;
        }

        // 同步窗体/WebView2 背景到页面主题色（消除四周 6px 空隙的白边框）
        private void ApplyThemeBackground(string cssColor)
        {
            Color? c = ParseCssColor(cssColor);
            if (c == null) return;
            try
            {
                BackColor = c.Value;
                webView.DefaultBackgroundColor = c.Value;
            }
            catch { /* 有意吞掉 */ }
        }

        // 无边框窗口：手动处理 WM_NCHITTEST 让边缘可拖拽调整大小；窗口尺寸变化时重设圆角
        protected override void WndProc(ref Message m)
        {
            // 重复启动主程序时广播聚焦消息 → 唤起已隐藏到托盘的窗口
            if (m.Msg == Program.WM_DSH_MAIN_FOCUS)
            {
                try { ShowMainForm(); } catch { /* 有意吞掉 */ }
                return;
            }
            if (m.Msg == WM_NCHITTEST)
            {
                // 最大化状态不允许边缘 resize，直接走 base（也避免对最大化窗口拖边缘出错）
                if (WindowState == FormWindowState.Maximized)
                {
                    base.WndProc(ref m);
                    return;
                }
                // 无边框窗口整个都是客户区，base 不返回 HTCAPTION，直接按鼠标屏幕坐标判断边缘。
                // 边缘命中判定收敛到 ShellContract.HitTestResizeEdge（单一真源，主窗无标题栏 titleBarH=0）。
                long lp = m.LParam.ToInt64();
                int sx = (short)(lp & 0xFFFF);
                int sy = (short)((lp >> 16) & 0xFFFF);
                Point pt = PointToClient(new Point(sx, sy));
                int hit = ShellContract.HitTestResizeEdge(pt.X, pt.Y, ClientSize.Width, ClientSize.Height, resizeBorder, 0);
                if (hit != 0)
                {
                    m.Result = (IntPtr)hit;
                }
                else
                {
                    base.WndProc(ref m);
                }
                return;
            }
            base.WndProc(ref m);
        }

        private void ReapplyRoundRegion()
        {
            try
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    // 最大化时去掉圆角（避免透明缺口）
                    SetWindowRgn(Handle, IntPtr.Zero, true);
                }
                else
                {
                    IntPtr rgn = CreateRoundRectRgn(0, 0, Width, Height, 16, 16);
                    SetWindowRgn(Handle, rgn, true);
                }
            }
            catch { /* 圆角失败不影响使用 */ }
        }

        // 托盘右键菜单美化：深色主题渲染器（呼应 UI 顶部导航深色 + 蓝色强调）
        // 托盘右键菜单配色：与应用浅色主题一致（白面板 / 发丝线边框 #E5E7EB / 中性悬停 #F3F4F6）
        private sealed class TrayMenuColors : ProfessionalColorTable
        {
            private static readonly Color Panel = Color.White;
            private static readonly Color Line = Color.FromArgb(229, 231, 235);        // = 页面 var(--line)
            private static readonly Color Hover = Color.FromArgb(243, 244, 246);       // = 页面 var(--neutral-soft)
            public override Color ToolStripDropDownBackground { get { return Panel; } }
            public override Color MenuBorder { get { return Line; } }
            public override Color MenuItemBorder { get { return Panel; } }
            public override Color MenuItemSelected { get { return Hover; } }
            public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
            public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
            public override Color ImageMarginGradientBegin { get { return Panel; } }
            public override Color ImageMarginGradientMiddle { get { return Panel; } }
            public override Color ImageMarginGradientEnd { get { return Panel; } }
            public override Color SeparatorDark { get { return Line; } }
            public override Color SeparatorLight { get { return Line; } }
        }

        // 托盘菜单渲染：圆角中性悬停（与页面菜单项同款手感），不叠加 base 方形底色
        private sealed class TrayMenuRenderer : ToolStripProfessionalRenderer
        {
            public TrayMenuRenderer() : base(new TrayMenuColors()) { }
            protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
            {
                var rect = new Rectangle(3, 2, e.Item.Width - 6, e.Item.Height - 4);
                using (var path = RoundedRect(rect, 4))
                using (var b = new SolidBrush(e.Item.Selected && e.Item.Enabled
                    ? ((TrayMenuColors)ColorTable).MenuItemSelected
                    : ((TrayMenuColors)ColorTable).ToolStripDropDownBackground))
                    e.Graphics.FillPath(b, path);
            }
            private static System.Drawing.Drawing2D.GraphicsPath RoundedRect(Rectangle r, int d)
            {
                var p = new System.Drawing.Drawing2D.GraphicsPath();
                p.AddArc(r.X, r.Y, d, d, 180, 90);
                p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                p.CloseFigure();
                return p;
            }
        }

        // 托盘常驻：关闭窗口不退出，从托盘恢复或退出。
        private void SetupTray()
        {
            try
            {
                _trayIcon = new NotifyIcon();
                _trayIcon.Text = "Dseam世界（DSH 插座中枢）";
                try { _trayIcon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
                catch { _trayIcon.Icon = SystemIcons.Application; }
                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Renderer = new TrayMenuRenderer();
                menu.BackColor = Color.White;
                menu.ForeColor = Color.FromArgb(31, 41, 55);          // = 页面 var(--ink)
                menu.Font = new Font("Microsoft YaHei UI", 9.5F);     // 与标题栏同款字体规范
                menu.ShowImageMargin = false;
                menu.Padding = new Padding(4);

                var openItem = new ToolStripMenuItem("打开 Dseam世界");
                openItem.Font = new Font(menu.Font, FontStyle.Bold);  // 主操作加粗（默认项惯例）
                openItem.Padding = new Padding(10, 6, 14, 6);
                openItem.Click += delegate { ShowMainForm(); };

                var exitItem = new ToolStripMenuItem("退出");
                exitItem.ForeColor = Color.FromArgb(220, 38, 38);     // = 页面 var(--red)
                exitItem.Padding = new Padding(10, 6, 14, 6);
                exitItem.Click += delegate { ExitApplication(); };

                menu.Items.Add(openItem);
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(exitItem);

                _trayIcon.ContextMenuStrip = menu;
                _trayIcon.DoubleClick += delegate { ShowMainForm(); };
                _trayIcon.Visible = true;
                _trayReady = true; // 托盘图标完整就绪后才置位
            }
            catch { /* 有意吞掉：托盘不可用时 _trayReady=false，关闭将退出而非藏入不可恢复的托盘 */ }
        }

        private void ShowMainForm()
        {
            Show();
            ShowInTaskbar = true;
            // 聚焦/唤起目标状态决议（契约）：最小化→Normal；最大化保持。绝不把「已最大化」降级为普通窗
            // （旧实现无条件 Normal，重复启动已最大化的主窗会误降级；与 harness 窗聚焦语义统一）。
            // FormWindowState 与 ShellContract.WS_* 数值一致（Normal=0/Minimized=1/Maximized=2）。
            WindowState = (FormWindowState)ShellContract.ResolveShowWindowState((int)WindowState);
            // 显式抢占前台：仅 Activate() 在托盘双击/跨进程聚焦场景可能被系统前台锁拦截
            try { SetForegroundWindow(Handle); } catch { /* 有意吞掉 */ }
            Activate();
        }

        // 安全隐藏主窗：最大化/最小化状态直接 Hide 会残留全屏纯色窗口，先还原到 Normal 再隐藏
        private void HideMainSafely()
        {
            try
            {
                if (WindowState != FormWindowState.Normal)
                {
                    MaximizedBounds = Rectangle.Empty;
                    WindowState = FormWindowState.Normal;
                }
            }
            catch { /* 有意吞掉 */ }
            try { Hide(); ShowInTaskbar = false; } catch { /* 有意吞掉 */ }
        }

        private void ExitApplication()
        {
            _allowExit = true;
            SaveWindowState();  // 退出前记录窗口状态（含最大化标志），下次启动恢复——与 harness 子窗「关闭即保存」一致
            // v1.2：真正退出 = 整体回收本程序拉起的资源（dsh web 进程树 + DSH 独立程序 + 端口握手文件）。
            // 仅藏入托盘（窗口关闭/自绘 ×）不走此路径，后台常驻语义不变。
            CleanupAndExit();
            Application.Exit();
        }

        // 关闭 harness 子窗体（内嵌/跳出）：主窗 Hide 前先关，否则它们会被顶到前台显示成纯色空窗
        private void CloseHarnessChildForms()
        {
            try { if (_harnessEmbedForm != null && !_harnessEmbedForm.IsDisposed) _harnessEmbedForm.Close(); } catch { /* 有意吞掉 */ }
            try { if (_harnessPopoutForm != null && !_harnessPopoutForm.IsDisposed) _harnessPopoutForm.Close(); } catch { /* 有意吞掉 */ }
        }

        // 退出路径的资源整体回收：关子窗体 + 藏主窗 + 释放托盘图标 + 回收 dsh web 进程树 + DSH 独立程序 + 端口握手文件。
        private void CleanupAndExit()
        {
            CloseHarnessChildForms();
            HideMainSafely();
            try { if (_trayIcon != null) { _trayIcon.Visible = false; _trayIcon.Dispose(); } } catch { /* 有意吞掉 */ }
            CloseStandaloneHarness();
            StopOfficialHarness();
        }

        private async Task InitializeAsync()
        {
            try
            {
                var installTask = Task.Run(() => InstallPluginsToHarness());
                string html = ReadEmbeddedHtml();
                html = InjectSidebarLaunchButton(html);

                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DSH-Hotplug-Hub", "WebView2");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                _env = env;
                await webView.EnsureCoreWebView2Async(env);

                webView.CoreWebView2.WebMessageReceived += async delegate (object sender, CoreWebView2WebMessageReceivedEventArgs e)
                {
                    try
                    {
                        string message = e.TryGetWebMessageAsString();
                        if (message != null && message.StartsWith("themeBg:"))
                        {
                            // 页面主题背景色回传：同步窗体/WebView2 背景，消除四周 6px 白边框
                            string bg = message.Substring("themeBg:".Length).Trim();
                            ApplyThemeBackground(bg);
                        }
                        else if (message == "winDrag")
                        {
                            // 延后到消息循环稳定后执行拖拽，避免 WebView2 仍持有鼠标状态导致拖拽失效
                            BeginInvoke((Action)(() => BeginWindowDrag()));
                        }
                        else if (message == "winMin")
                        {
                            WindowState = FormWindowState.Minimized;
                        }
                        else if (message == "winClose")
                        {
                            // 无边框自绘关闭按钮 → 与系统关闭走同一条路径：Close() 触发 FormClosing
                            // （统一：保存窗口状态 + 关闭 harness 子窗 + 隐藏到托盘）。
                            // 修复旧实现直接 HideMainSafely 而跳过 SaveWindowState 的不一致。
                            Close();
                        }
                        else if (message == "winMax")
                        {
                            // 无边框自绘最大化/还原按钮
                            if (WindowState == FormWindowState.Maximized)
                            {
                                MaximizedBounds = Rectangle.Empty;
                                WindowState = FormWindowState.Normal;
                            }
                            else
                            {
                                // 最大化时只占屏幕工作区（留出底部任务栏）
                                MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                                WindowState = FormWindowState.Maximized;
                            }
                        }
                        else if (message == "launch")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在启动 dsh 服务…');");
                            int port = await Task.Run(() => {
                                bool ok = LaunchOfficialHarness();
                                return ok ? _harnessPort : 0;
                            });
                            if (port > 0)
                            {
                                // 等待端口就绪（dsh web 启动需数秒）
                                bool ready = await Task.Run(() => WaitForPortReady(port, 20000));
                                if (ready)
                                {
                                    // v1.1：以独立进程拉起 DSH 程序（--harness-window），与主程序完全分进程
                                    LaunchStandaloneHarnessWindow();
                                }
                                else
                                {
                                    await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('dsh 服务启动超时，请到自检页点「一键修复环境」排查');");
                                }
                            }
                            else
                            {
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('未启动 dsh（未找到 dsh CLI 或已取消）');");
                            }
                        }
                        else if (message == "restartHarness")
                        {
                            // v1.1：插件更改后的重启流（前端已做二次确认）——
                            // 停 dsh web + 关 DSH 独立程序 → 重新启动 dsh web → 重新拉起独立程序
                            bool running = (_harnessProc != null && !_harnessProc.HasExited) || _harnessPort > 0;
                            if (!running)
                            {
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('DSH 未在运行，无需重启；下次启动自动生效');");
                            }
                            else
                            {
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在重启 DSH…');");
                                CloseStandaloneHarness();
                                int port = await Task.Run(() =>
                                {
                                    StopOfficialHarness();
                                    bool ok = LaunchOfficialHarness();
                                    return ok ? _harnessPort : 0;
                                });
                                if (port > 0)
                                {
                                    bool ready = await Task.Run(() => WaitForPortReady(port, 20000));
                                    if (ready)
                                    {
                                        LaunchStandaloneHarnessWindow();
                                        await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('DSH 已重启，插件更改已生效');");
                                    }
                                    else
                                    {
                                        await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('dsh 服务重启超时，可稍后在主页重新启动');");
                                    }
                                }
                                else
                                {
                                    await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('dsh 服务重启失败，请到自检页排查环境');");
                                }
                            }
                        }
                        else if (message == "harnessEmbed")
                        {
                            await OpenHarnessEmbed();
                        }
                        else if (message == "harnessPopout")
                        {
                            // v1.1：「跳出窗口」同样以独立进程打开 DSH 程序（不再共用主程序进程）
                            int port = DetectHarnessPort();
                            if (port == 0)
                            {
                                MessageBox.Show("dsh 服务尚未运行或未检测到其 Web 服务端口。", "Dseam世界",
                                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                            }
                            else
                            {
                                _harnessPort = port;
                                LaunchStandaloneHarnessWindow();
                            }
                        }
                        else if (message == "harnessStop")
                        {
                            StopOfficialHarness();
                            CloseStandaloneHarness();
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('官方 DSH 已停止');");
                        }
                        else if (message == "harnessEnv")
                        {
                            string envResult = await Task.Run(() => EnsureEnvironmentAuto());
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(envResult) + ");");
                        }
                        else if (message == "recheck")
                        {
                            ClearGitHubCache();
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                        }
                        else if (message == "openApiConfig")
                        {
                            ShowApiConfigDialog();
                        }
                        else if (message == "chooseHarness")
                        {
                            string chosen = ChooseHarnessManually();
                            if (chosen != null)
                            {
                                await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                            }
                        }
                        else if (message == "installHarness")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在更新官方 dsh CLI 到最新版（@deepseek-ai/dsh），请稍候…');");
                            string harnessResult = await Task.Run(() => UpdateDshCli());
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(harnessResult) + ");");
                            ClearGitHubCache();
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                        }
                        else if (message == "repairConfig")
                        {
                            DialogResult confirm = MessageBox.Show(
                                "确定要修复 dsh 配置文件吗？\n\n将检查并修复 ~/.dsh 下已知的损坏：\n· settings.yaml 重复键\n· .credentials.yaml 格式错误\n\n修复会直接改写这些文件。",
                                "Dseam世界 · 修复配置", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                            if (confirm == DialogResult.Yes)
                            {
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在修复 dsh 配置文件…');");
                                string repairResult = await Task.Run(() => RepairDshConfig());
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(repairResult) + ");");
                                await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                            }
                        }
                        else if (message == "setEnvMode")
                        {
                            // 前端会发 setEnvMode:windows 或 setEnvMode:wsl
                            string newMode = message.Length > "setEnvMode:".Length ? message.Substring("setEnvMode:".Length) : "";
                            SetEnvMode(newMode == "wsl" ? "wsl" : "windows");
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('dsh 环境已切换为：" + (newMode == "wsl" ? "WSL 子系统" : "Windows 本机") + "');");
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                        }
                        else if (message == "autoInstallEnv")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在检查并修复 Node/pnpm/dsh 环境，可能需要几分钟…');");
                            string envResult = await Task.Run(() => EnsureHarnessEnvironment());
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(envResult) + ");");
                            ClearGitHubCache();
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                        }
                        else if (message == "checkUpdate")
                        {
                            ClearGitHubCache();
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                        }
                        else if (message == "downloadProject")
                        {
                            OpenProjectDownloadPage();
                        }
                        else if (message == "installPanel" || message == "updatePanel")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在安装/更新官方 Skill/MCP 面板插件，请稍候…');");
                            string panelResult = await Task.Run(() => InstallOrUpdatePanel());
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(panelResult) + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                        }
                        else if (message == "openPanelPage")
                        {
                            try
                            {
                                Process.Start("https://github.com/ARFCON/dsh-hotplug-hub/releases/tag/v" + APP_VERSION);
                            }
                            catch
                            {
                            }
                        }
                        else if (message == "listMemory")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMemory(" + GetMemoryJson() + ");");
                        }
                        else if (message != null && message.StartsWith("deleteMemory:"))
                        {
                            DeleteMemoryFile(message.Substring("deleteMemory:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMemory(" + GetMemoryJson() + ");");
                        }
                        else if (message != null && message.StartsWith("saveMemory:"))
                        {
                            SaveMemoryFile(message.Substring("saveMemory:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMemory(" + GetMemoryJson() + ");");
                        }
                        else if (message == "listSkills")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("addSkill:"))
                        {
                            SaveSkillFile(message.Substring("addSkill:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("deleteSkill:"))
                        {
                            DeleteSkillFile(message.Substring("deleteSkill:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message == "listSkillSource")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkillSource(" + GetSkillSourceJson() + ");");
                        }
                        else if (message != null && message.StartsWith("addSkillSource:"))
                        {
                            await Task.Run(() => AddSkillsFromSource(message.Substring("addSkillSource:".Length)));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkillSource(" + GetSkillSourceJson() + ");");
                        }
                        else if (message != null && message.StartsWith("enableSkill:"))
                        {
                            await Task.Run(() => RunDshPanelCli("skill enable \"" + SanitizeServerName(message.Substring("enableSkill:".Length)) + "\""));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("disableSkill:"))
                        {
                            await Task.Run(() => RunDshPanelCli("skill disable \"" + SanitizeServerName(message.Substring("disableSkill:".Length)) + "\""));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message == "checkPlugins")
                        {
                            string checkJson = await Task.Run(() => CheckPluginUpdates());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + checkJson + ");");
                        }
                        else if (message == "listPlugins")
                        {
                            string listJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + listJson + ");");
                        }
                        else if (message != null && message.StartsWith("addPlugin:"))
                        {
                            string pluginPayload = message.Substring("addPlugin:".Length);
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在安装插件，可能需要一分钟…');");
                            string addResult = await Task.Run(() => AddPlugin(pluginPayload));
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(addResult) + ");");
                            string addJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + addJson + ");");
                        }
                        else if (message != null && message.StartsWith("deletePlugin:"))
                        {
                            string delResult = await Task.Run(() => DeletePlugin(message.Substring("deletePlugin:".Length)));
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(delResult) + ");");
                            string delJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + delJson + ");");
                        }
                        else if (message != null && message.StartsWith("enablePlugin:"))
                        {
                            string enResult = await Task.Run(() => SetPluginEnabled(message.Substring("enablePlugin:".Length), true));
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(enResult) + ");");
                            string enJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + enJson + ");");
                        }
                        else if (message != null && message.StartsWith("disablePlugin:"))
                        {
                            string disResult = await Task.Run(() => SetPluginEnabled(message.Substring("disablePlugin:".Length), false));
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(disResult) + ");");
                            string disJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + disJson + ");");
                        }
                        else if (message != null && message.StartsWith("updatePlugin:"))
                        {
                            string upId = message.Substring("updatePlugin:".Length);
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在更新插件 " + upId + " …');");
                            string upResult = await Task.Run(() => UpdatePlugin(upId));
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(upResult) + ");");
                            string upJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + upJson + ");");
                        }
                        else if (message == "updateAllPlugins")
                        {
                            // v1.1：一键更新 —— 服务端顺序执行（避免并发 pnpm 写同一 profile），结果一次性回推
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('正在依次更新所有可更新插件，可能需要几分钟…');");
                            string summary = await Task.Run(() => UpdateAllPlugins());
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(summary) + ");");
                            string upJson = await Task.Run(() => GetPluginsJson());
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setPlugins(" + upJson + ");");
                        }
                        else if (message == "listMcp")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("addMcp:"))
                        {
                            await Task.Run(() => SaveMcpFile(message.Substring("addMcp:".Length)));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("deleteMcp:"))
                        {
                            await Task.Run(() => DeleteMcpFile(message.Substring("deleteMcp:".Length)));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("startMcp:"))
                        {
                            string testResult = await Task.Run(() => StartMcpProcess(message.Substring("startMcp:".Length)));
                            await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast(" + JsString(testResult) + ");");
                        }
                        else if (message != null && message.StartsWith("enableMcp:"))
                        {
                            RunDshPanelCli("mcp enable \"" + SanitizeServerName(message.Substring("enableMcp:".Length)) + "\"");
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("disableMcp:"))
                        {
                            RunDshPanelCli("mcp disable \"" + SanitizeServerName(message.Substring("disableMcp:".Length)) + "\"");
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("ai:"))
                        {
                            await HandleAiRequestAsync(message.Substring(3));
                        }
                        else if (message != null && message.StartsWith("aiTest:"))
                        {
                            await HandleAiTestAsync(message.Substring("aiTest:".Length));
                        }
                    }
                    catch
                    {
                    }
                };

                webView.CoreWebView2.NavigationCompleted += async delegate (object sender, CoreWebView2NavigationCompletedEventArgs e)
                {
                    try
                    {
                        if (e.IsSuccess)
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync(await BuildNativeSelfCheckScriptAsync());
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildApiIntegrationScript());
                            // v1.1 契约：__setPlugins 回推数据后调用页面钩子 __onPluginsData（刷新主页更新面板/
                        // 菜单角标，并在插件变更流程 pending 时触发「重启 DSH」二次确认提示）
                        await webView.CoreWebView2.ExecuteScriptAsync("window.__setMemory=function(d){window.__memoryData=d||[];if(typeof renderMemory==='function')renderMemory();if(typeof renderShell==='function')renderShell();};window.__setSkills=function(d){window.__skillsData=d||[];if(typeof renderSkills==='function')renderSkills();};window.__setSkillSource=function(d){window.__skillSourceData=d||null;if(typeof renderSkills==='function')renderSkills();};window.__setMcps=function(d){window.__mcpsData=d||[];if(typeof renderMcp==='function')renderMcp();};window.__setPlugins=function(d){window.__pluginsData=d||[];if(typeof renderPlugins==='function')renderPlugins();if(typeof renderMarket==='function')renderMarket();if(typeof window.__onPluginsData==='function')window.__onPluginsData(window.__pluginsData);};window.chrome.webview.postMessage('listMemory');window.chrome.webview.postMessage('listSkills');window.chrome.webview.postMessage('listSkillSource');window.chrome.webview.postMessage('listMcp');window.chrome.webview.postMessage('listPlugins');");
                            // 同步窗体背景到页面主题色（消除四周 6px 空隙的白边框）
                            await webView.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage('themeBg:'+getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());");
                            string latestCheck = null;
                            await Task.Run(delegate
                            {
                                latestCheck = GetLatestReleaseVersion();
                            });
                            if (!_updateNotified && !string.IsNullOrEmpty(latestCheck) && IsNewerVersion(latestCheck, APP_VERSION))
                            {
                                _updateNotified = true;
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('发现新版本 v" + latestCheck + "，请到 自检更新 下载');");
                            }
                        }
                    }
                    catch
                    {
                    }
                };

                string dir = Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-webview2");
                Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "index.html");
                File.WriteAllText(file, html, new UTF8Encoding(true));
                webView.CoreWebView2.Navigate(file);
            }
            catch (Exception ex)
            {
                MessageBox.Show("WebView2 初始化失败：\n" + ex.Message, "Dseam世界",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static string ReadEmbeddedHtml()
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DSHHotplugHub.Resources.prototype.html"))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("内嵌资源 prototype.html 不存在。");
                }
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
        }

        // 仅补上原型缺失的 .hidden 规则（视图切换依赖）；不再注入折叠启动器（启动/选择/配置已并入主页）
        private static string InjectSidebarLaunchButton(string html)
        {
            string style = "<style>.hidden { display: none !important; }</style>";
            html = html.Replace("</head>", style + "</head>");
            return html;
        }

        // 生成注入到页面里的真实自检数据脚本（Node/pnpm/官方 Harness/WebView2/profile 探测）
        private static string BuildNativeSelfCheckScript()
        {
            string node = RunCli(GetNodeExe(), "--version");
            string pnpm = GetPnpmVersion();
            string dshDesktop = FindOfficialHarness();
            string dshVersion = GetDshCoreVersion();
            string dshCli = FindDshCommand() != null ? "ok" : null;
            string wv = null;
            try { wv = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            string profiles = DetectProfiles();
            string latest = GetLatestReleaseVersion();
            string dshLatest = GetLatestDshCliVersion();
            string panelInstalled = GetInstalledPanelVersion();
            string panelLatest = PANEL_VERSION;
            string envMode = GetEnvMode();
            string wslAvailable = WslAvailable() ? "ok" : null;
            string wslDsh = WslDshAvailable() ? "ok" : null;

            string js =
                "window.__nativeSelfCheck={" +
                "node:" + JsString(node) + "," +
                "pnpm:" + JsString(pnpm) + "," +
                "dshDesktop:" + JsString(dshDesktop) + "," +
                "dshVersion:" + JsString(dshVersion) + "," +
                "dshCli:" + JsString(dshCli) + "," +
                "webview2:" + JsString(wv) + "," +
                "profiles:" + JsString(profiles) + "," +
                "appVersion:" + JsString(APP_VERSION) + "," +
                "latestVersion:" + JsString(latest) + "," +
                "dshLatest:" + JsString(dshLatest) + "," +
                "panelInstalled:" + JsString(panelInstalled) + "," +
                "panelLatest:" + JsString(panelLatest) + "," +
                "envMode:" + JsString(envMode) + "," +
                "wslAvailable:" + JsString(wslAvailable) + "," +
                "wslDsh:" + JsString(wslDsh) +
                "};" +
                "if(window.__nativeSelfCheck.dshVersion){state.dshVersion=window.__nativeSelfCheck.dshVersion;if(window.__nativeSelfCheck.latestVersion){state.latestVersion=window.__nativeSelfCheck.latestVersion;}if(typeof renderShell==='function')renderShell();}" +
                "if(window.__nativeSelfCheck.panelInstalled||window.__nativeSelfCheck.panelLatest){state.panelInstalled=window.__nativeSelfCheck.panelInstalled||state.panelInstalled||null;state.panelLatest=window.__nativeSelfCheck.panelLatest||state.panelLatest||null;}" +
                "(function(){window.__baseGetChecks=window.__baseGetChecks||getChecks;getChecks=function(){var r=window.__baseGetChecks();" +
                // semver 比较（数值段，pre/build 后缀整版本剔除，与 PatchContract.CompareVersions 语义一致）：latest > app 才算「可更新」——本地领先（如 0.9.8 未发布）不误报
                "var nv=function(a,b){var A=String(a||'').replace(/^v/i,'').trim().split(/[-+]/)[0].split('.'),B=String(b||'').replace(/^v/i,'').trim().split(/[-+]/)[0].split('.');for(var i=0;i<Math.max(A.length,B.length);i++){var x=parseInt(A[i]||'0',10)||0,y=parseInt(B[i]||'0',10)||0;if(x!==y)return x-y;}return 0;};" +
                "for(var i=0;i<r.length;i++){" +
                "if(r[i].name==='Node.js'){r[i].val=window.__nativeSelfCheck.node||'未检测到';r[i].text=window.__nativeSelfCheck.node?'已检测':'未安装';r[i].status=window.__nativeSelfCheck.node?'ok':'err';}" +
                "if(r[i].name==='pnpm'){r[i].val=window.__nativeSelfCheck.pnpm||'未检测到';r[i].text=window.__nativeSelfCheck.pnpm?'已检测':'未安装';r[i].status=window.__nativeSelfCheck.pnpm?'ok':'err';}" +
                "if(r[i].name==='DSH 版本'){var dv=window.__nativeSelfCheck.dshVersion||'';var dl=window.__nativeSelfCheck.dshLatest||'';r[i].val=dv||r[i].val;if(dv){r[i].text='当前 v'+dv+(dl&&dl!==dv?' · 最新 v'+dl:'');r[i].status='ok';}else{r[i].text='未检测到 dsh CLI（可自动安装）';r[i].status='warn';}}" +
                "if(r[i].name==='官方 Skill/MCP 面板'){var pi=window.__nativeSelfCheck.panelInstalled;var pl=window.__nativeSelfCheck.panelLatest;r[i].val=pi||'未安装';if(!pi){r[i].status='warn';r[i].text='可安装 v'+(pl||'?');}else if(pl&&pi!==pl){r[i].status='update';r[i].text='可更新至 v'+pl;}else{r[i].status='ok';r[i].text='已最新';}}" +
                "}" +
                "if(window.__nativeSelfCheck.webview2){r.push({name:'WebView2',desc:'桌面渲染内核',val:window.__nativeSelfCheck.webview2,status:'ok',text:'可用'});}" +
                "if(window.__nativeSelfCheck.profiles){r.push({name:'本地 DSH Profile',desc:'~/.dsh/profiles 探测',val:window.__nativeSelfCheck.profiles,status:'ok',text:'已探测'});}" +
                "if(window.__nativeSelfCheck.dshCli){r.push({name:'dsh CLI',desc:'官方 DeepSeek Harness 命令行',val:window.__nativeSelfCheck.dshVersion||'已安装',status:'ok',text:'可用'});}" +
                "if(window.__nativeSelfCheck.appVersion){r.push({name:'本程序版本',desc:'当前安装版本',val:window.__nativeSelfCheck.appVersion,status:'ok',text:'v'+window.__nativeSelfCheck.appVersion});}" +
                "if(window.__nativeSelfCheck.latestVersion){var nCmp=nv(window.__nativeSelfCheck.latestVersion,window.__nativeSelfCheck.appVersion);r.push({name:'最新版本',desc:'GitHub 最新发布',val:window.__nativeSelfCheck.latestVersion,status:nCmp>0?'warn':'ok',text:nCmp>0?'可更新':'已最新'});}" +
                "return r;};" +
                "if(typeof renderCheck==='function'){renderCheck();}" +

                "})();";
            return js;
        }

        // 自检探测会 spawn 多个进程并访问 GitHub，放到后台线程执行，避免冻结 UI
        private static Task<string> BuildNativeSelfCheckScriptAsync()
        {
            return Task.Run(() => BuildNativeSelfCheckScript());
        }

        private static string JsString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "null";
            // 完整 JS 字符串字面量转义：换行/回车/制表/U+2028-2029/控制字符都必须转义，
            // 否则 LLM 原文（含换行）嵌入 ExecuteScriptAsync 会产生语法错误
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\u2028': sb.Append("\\u2028"); break;
                    case '\u2029': sb.Append("\\u2029"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        internal static string RunCli(string fileName, string arguments)
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
                    // 先异步接管输出再等退出：ReadToEnd() 是无限阻塞的，进程挂起时必须靠超时 + Kill 脱身
                    Task<string> stdout = p.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(5000))
                    {
                        try { p.Kill(); } catch { /* 有意吞掉：尽力而为的清理 */ }
                        try { p.WaitForExit(2000); } catch { /* 有意吞掉：尽力而为的清理 */ }
                    }
                    return stdout.Status == TaskStatus.RanToCompletion ? stdout.Result.Trim() : "";
                }
            }
            catch
            {
                return null;
            }
        }

        // pnpm 在 Windows 下通常是 pnpm.ps1 / pnpm.cmd，直接 spawn "pnpm" 会失败，这里做多路探测
        private static string GetPnpmVersion()
        {
            // 1) 通过 cmd.exe 解析 pnpm（能识别 PATH 里的 pnpm.cmd / pnpm.ps1）
            string v = RunCli("cmd.exe", "/c pnpm --version");
            if (!string.IsNullOrEmpty(v)) return v;

            // 2) 直接尝试 pnpm.cmd
            v = RunCli("pnpm.cmd", "--version");
            if (!string.IsNullOrEmpty(v)) return v;

            // 3) 常见 npm 全局目录
            string known = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "npm", "pnpm.cmd");
            if (File.Exists(known))
            {
                v = RunCli(known, "--version");
                if (!string.IsNullOrEmpty(v)) return v;
            }

            // 4) 便携版 Node 目录（自动安装 Node 后 pnpm 会安装到这里）
            string portablePnpm = Path.Combine(GetNodeInstallDir(), "pnpm.cmd");
            if (File.Exists(portablePnpm))
            {
                v = RunCli("cmd.exe", "/c \"" + portablePnpm + "\" --version");
                if (!string.IsNullOrEmpty(v)) return v;
            }

            return null;
        }

        private static string DetectProfiles()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string dsh = Path.Combine(home, ".dsh", "profiles");
                if (!Directory.Exists(dsh)) return "未找到 ~/.dsh/profiles";
                string[] names = Directory.GetDirectories(dsh);
                if (names.Length == 0) return "空";
                StringBuilder sb = new StringBuilder();
                foreach (string name in names)
                {
                    if (sb.Length > 0) sb.Append(", ");
                    sb.Append(Path.GetFileName(name));
                }
                return sb.ToString();
            }
            catch
            {
                return null;
            }
        }

        private bool LaunchOfficialHarness()
        {
            // 已在运行且端口已知：直接返回（聚焦交给 DSH 独立程序/内嵌窗口）
            if (_harnessProc != null && !_harnessProc.HasExited && _harnessPort > 0)
            {
                WriteHarnessPortFile(_harnessPort);
                return true;
            }

            int port;
            Process p = StartDshWebProcess(out port);
            if (p == null)
            {
                // 未找到 dsh CLI，尝试自动装环境（Node/pnpm/dsh），不再拉起第三方桌面壳
                DialogResult choose = MessageBox.Show(
                    "未找到 dsh（DeepSeek Harness CLI）。\n\n是否自动检查并安装 Node / pnpm / dsh 环境？",
                    "Dseam世界", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (choose != DialogResult.Yes) return false;
                string envResult = EnsureDshCliEnvironment();
                p = StartDshWebProcess(out port);
                if (p == null)
                {
                    MessageBox.Show("环境安装后仍未找到 dsh，请重启程序后重试。\n\n" + envResult,
                        "Dseam世界", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return false;
                }
            }

            _harnessProc = p;
            _harnessPort = port;
            WriteHarnessPortFile(port); // 与 DSH 独立程序握手
            return true;
        }

        // 轮询等待端口开始监听（dsh web 启动需要数秒）；超时返回 false
        internal static bool WaitForPortReady(int port, int timeoutMs)
        {
            if (port <= 0) return false;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    foreach (var l in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                    {
                        if (l.Port == port && (l.Address.Equals(IPAddress.Loopback) || l.Address.Equals(IPAddress.Any)))
                            return true;
                    }
                }
                catch { /* 继续轮询 */ }
                Thread.Sleep(500);
            }
            return false;
        }

        // 动态探测官方 harness 的 web 监听端口（官方最新版用 --port 0 随机端口，不能硬编码）
        // 策略：优先用我们启动时记录的端口（确认进程/监听仍在），否则全机扫描兜底。
        private int DetectHarnessPort()
        {
            // 1. 我们启动 dsh web 时已知端口（最可靠），优先返回
            if (_harnessPort > 0)
            {
                // 确认进程还在，端口仍被监听
                if (_harnessProc != null && !_harnessProc.HasExited) return _harnessPort;
                try
                {
                    foreach (var l in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                    {
                        if (l.Port == _harnessPort && (l.Address.Equals(IPAddress.Loopback) || l.Address.Equals(IPAddress.Any)))
                            return _harnessPort;
                    }
                }
                catch { /* 探测失败，继续走兜底 */ }
            }

            // 2. 兜底：全机扫描（共享实现，与 DSH 独立程序的探测契约一致）
            return ScanLocalHttpPort();
        }

        // 停止官方 harness（终止进程树）
        private void StopOfficialHarness()
        {
            try
            {
                // 杀掉我们启动的 dsh web 进程树（cmd/node 会 fork 子进程，用 taskkill /T 递归）
                if (_harnessProc != null)
                {
                    try
                    {
                        if (!_harnessProc.HasExited)
                        {
                            RunCli("taskkill", "/F /T /PID " + _harnessProc.Id);
                        }
                    }
                    catch { /* 有意吞掉 */ }
                }
            }
            catch { /* 有意吞掉 */ }
            _harnessProc = null;
            _harnessPort = 0;
            // 同步清掉端口握手文件：避免残留过期端口误导后续 DSH 独立程序（重启流会随即重写新端口）
            try { File.Delete(HarnessPortFile()); } catch { /* 有意吞掉：文件不存在/被占 */ }
        }

        // 内嵌弹窗：加载官方 harness web UI（async Task：异常沿 await 链抛给消息处理 try/catch，不再 async void 崩溃）
        private async Task OpenHarnessEmbed()
        {
            // 若已有内嵌窗，聚焦
            if (_harnessEmbedForm != null && !_harnessEmbedForm.IsDisposed)
            {
                _harnessEmbedForm.Activate();
                return;
            }
            int port = DetectHarnessPort();
            if (port == 0)
            {
                MessageBox.Show("官方 DSH 桌面端尚未运行或未检测到其 Web 服务端口。\n请先在主页点击「启动 DSH」。", "Dseam世界",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            _harnessPort = port;
            _harnessEmbedForm = BuildHarnessForm("官方 DSH · 内嵌", new Size(1080, 720), false);
            _harnessEmbedForm.Owner = this; // CenterParent 依赖 Owner；并随主窗最小化/还原
            _harnessEmbedForm.FormClosed += delegate { _harnessEmbedForm = null; };
            await ((BorderlessHarnessForm)_harnessEmbedForm).WebView.EnsureCoreWebView2Async(_env);
            ((BorderlessHarnessForm)_harnessEmbedForm).WebView.CoreWebView2.Navigate("http://127.0.0.1:" + port + "/");
            ((BorderlessHarnessForm)_harnessEmbedForm).BringTitleBarToFront();
            _harnessEmbedForm.Show();
        }

        // 跳出独立窗口：新窗口加载官方 harness web UI
        private async Task OpenHarnessPopout()
        {
            if (_harnessPopoutForm != null && !_harnessPopoutForm.IsDisposed)
            {
                _harnessPopoutForm.Activate();
                return;
            }
            int port = DetectHarnessPort();
            if (port == 0)
            {
                MessageBox.Show("dsh 服务尚未运行或未检测到其 Web 服务端口。", "Dseam世界",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            _harnessPort = port;
            _harnessPopoutForm = BuildHarnessForm("DSH 对话", new Size(1280, 800), true);
            _harnessPopoutForm.FormClosed += delegate { _harnessPopoutForm = null; };
            await ((BorderlessHarnessForm)_harnessPopoutForm).WebView.EnsureCoreWebView2Async(_env);
            ((BorderlessHarnessForm)_harnessPopoutForm).WebView.CoreWebView2.Navigate("http://127.0.0.1:" + port + "/");
            ((BorderlessHarnessForm)_harnessPopoutForm).BringTitleBarToFront();
            _harnessPopoutForm.Show();
        }

        // v1.1：以【独立进程】拉起 DSH 程序（--harness-window）——不再与主程序共用进程。
        // 调用前必须确保 dsh web 已就绪并已 WriteHarnessPortFile；重复拉起由独立程序自行聚焦。
        private void LaunchStandaloneHarnessWindow()
        {
            // 已在运行：只聚焦现有独立窗口，不重复拉起——
            // 否则会覆盖 _standaloneHarnessProc 指向一个「检测到互斥后即将退出的瞬态进程」，
            // 退出时 CloseStandaloneHarness 无法命中真正的独立窗口 → 孤儿进程。
            bool alive = false;
            try { alive = _standaloneHarnessProc != null && !_standaloneHarnessProc.HasExited; } catch { /* 句柄失效按已退出处理 */ }
            if (alive)
            {
                try { WriteHarnessPortFile(_harnessPort); } catch { /* 有意吞掉 */ }
                Program.BroadcastHarnessFocus();
                return;
            }
            try
            {
                WriteHarnessPortFile(_harnessPort);
                ProcessStartInfo psi = new ProcessStartInfo(Application.ExecutablePath, "--harness-window");
                _standaloneHarnessProc = Process.Start(psi);
            }
            catch (Exception ex)
            {
                // 独立进程启动失败（如 exe 被移动/占用）：回退到进程内跳出窗口，保证功能可用
                MessageBox.Show("启动 DSH 独立程序失败，将回退到内嵌窗口模式：\n" + ex.Message,
                    "Dseam世界", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                BeginInvoke((Action)(async delegate { await OpenHarnessPopout(); }));
            }
        }

        // 关闭 DSH 独立程序（先礼貌关闭，超时强杀）
        private void CloseStandaloneHarness()
        {
            try
            {
                if (_standaloneHarnessProc != null && !_standaloneHarnessProc.HasExited)
                {
                    _standaloneHarnessProc.CloseMainWindow();
                    try
                    {
                        if (!_standaloneHarnessProc.WaitForExit(1500)) _standaloneHarnessProc.Kill();
                    }
                    catch { /* 有意吞掉 */ }
                }
            }
            catch { /* 有意吞掉 */ }
            try { if (_standaloneHarnessProc != null) _standaloneHarnessProc.Dispose(); } catch { /* 有意吞掉 */ }
            _standaloneHarnessProc = null;
        }

        // 构建承载官方 web UI 的无边框窗体（圆角 + 标题栏拖动 + 边缘缩放 + 自绘窗口控制，沿用主窗设计）
        private BorderlessHarnessForm BuildHarnessForm(string title, Size size, bool independent)
        {
            var f = new BorderlessHarnessForm(title, this.Icon, size);
            f.StartPosition = independent ? FormStartPosition.CenterScreen : FormStartPosition.CenterParent;
            f.ShowInTaskbar = independent;
            return f;
        }

        // 无边框 harness 承载窗体：与主窗一致的设计语言（圆角、拖动、边缘缩放、自绘标题栏）
        private sealed class BorderlessHarnessForm : Form
        {
            public readonly WebView2 WebView = new WebView2();
            private const int TITLE_H = 36;
            private readonly Panel _titleBar;
            private readonly Button _btnMin;
            private readonly Button _btnMax;
            private readonly Button _btnClose;

            public BorderlessHarnessForm(string title, Icon icon, Size defaultSize)
            {
                Text = title;
                FormBorderStyle = FormBorderStyle.None;
                BackColor = Color.FromArgb(30, 41, 59);
                try { Icon = icon; } catch { /* 图标加载失败不影响使用 */ }

                // 恢复上次窗口尺寸（默认用传入的 defaultSize；已按当前主屏工作区钳制）
                int[] saved = LoadState(defaultSize);
                Size = new Size(saved[0], saved[1]);
                MinimumSize = new Size(640, 480);

                // 自绘标题栏：深色 + 标题 + 最小化/最大化/关闭按钮（沿用主窗顶部导航深色 + 强调色）
                _titleBar = new Panel();
                _titleBar.Dock = DockStyle.Top;
                _titleBar.Height = TITLE_H;
                _titleBar.BackColor = Color.FromArgb(30, 41, 59);

                var titleLabel = new Label();
                titleLabel.Text = title;
                titleLabel.ForeColor = Color.FromArgb(229, 231, 235);
                titleLabel.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Regular);
                titleLabel.AutoSize = false;
                titleLabel.TextAlign = ContentAlignment.MiddleLeft;
                titleLabel.Left = 12;
                titleLabel.Top = 0;
                titleLabel.Height = TITLE_H;
                titleLabel.Width = 300;
                titleLabel.Cursor = Cursors.SizeAll;

                // 按钮文字用 Windows 字体必显示的字符（— 最小化 / □ 最大化 / × 关闭）
                _btnMin = MakeTitleButton("—", (s, e) => { WindowState = FormWindowState.Minimized; });
                _btnMax = MakeTitleButton("□", (s, e) => ToggleMaximize());
                _btnClose = MakeTitleButton("×", (s, e) => { Close(); }, true);
                // 按钮定位统一走 LayoutTitleButtons（titleBar.SizeChanged 触发），与 HarnessHostForm 一致，
                // 不再叠加 Anchor=Right（双重定位会互相覆盖，见 HarnessHostForm 纯手动布局为单一真源）

                _titleBar.Controls.Add(titleLabel);
                _titleBar.Controls.Add(_btnMin);
                _titleBar.Controls.Add(_btnMax);
                _titleBar.Controls.Add(_btnClose);
                _titleBar.SizeChanged += (s, e) => LayoutTitleButtons();
                LayoutTitleButtons();

                // 标题栏空白处拖动窗口（按钮不冒泡，点击按钮不触发拖动）
                // 关键：与主窗一致，用 BeginInvoke 延后到消息循环稳定后再拖，否则 WebView2 仍持有鼠标状态会导致"松手才生效"
                _titleBar.MouseDown += (s, e) => { if (e.Button == MouseButtons.Left) BeginDrag(); };
                titleLabel.MouseDown += (s, e) => { if (e.Button == MouseButtons.Left) BeginDrag(); };

                WebView.DefaultBackgroundColor = Color.FromArgb(30, 41, 59);
                Controls.Add(WebView);
                Controls.Add(_titleBar);

                Load += (s, e) =>
                {
                    LayoutWebView();
                    ReapplyRound();
                    if (saved[2] == 1)
                    {
                        MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                        WindowState = FormWindowState.Maximized;
                        _btnMax.Text = "❐";
                    }
                };
                // WebView 布局须在 ClientSize 就绪后（Load/Resize）计算，构造时 ClientSize 未就绪会算错导致覆盖标题栏/边缘
                // 圆角随 Resize 重设（程序化最大化/还原也触发 Resize，ResizeEnd 仅用户拖动结束触发；
                // 仅用 ResizeEnd 会让程序化最大化不清除圆角区域 → 窗口被旧尺寸圆角裁剪）
                Resize += (s, e) => { LayoutWebView(); ReapplyRound(); };
                FormClosing += (s, e) => SaveState();
            }

            private void LayoutTitleButtons()
            {
                _btnClose.Left = _titleBar.Width - 46;
                _btnMax.Left = _titleBar.Width - 92;
                _btnMin.Left = _titleBar.Width - 138;
            }

            // WebView 四周留 6px 裸窗体边缘 + 顶部让位给标题栏，供 WM_NCHITTEST 识别边缘缩放
            private void LayoutWebView()
            {
                WebView.SetBounds(
                    resizeBorder,
                    TITLE_H + resizeBorder,
                    Math.Max(1, ClientSize.Width - resizeBorder * 2),
                    Math.Max(1, ClientSize.Height - TITLE_H - resizeBorder * 2));
            }

            // 最大化/还原：最大化时留出任务栏（WorkingArea），还原时清空边界
            private void ToggleMaximize()
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    MaximizedBounds = Rectangle.Empty;
                    WindowState = FormWindowState.Normal;
                    _btnMax.Text = "□";
                }
                else
                {
                    MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                    WindowState = FormWindowState.Maximized;
                    _btnMax.Text = "❐";
                }
            }

            private Button MakeTitleButton(string text, EventHandler onClick, bool danger = false)
            {
                var b = new Button();
                b.Text = text;
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderSize = 0;
                b.FlatAppearance.MouseOverBackColor = danger ? Color.FromArgb(220, 38, 38) : Color.FromArgb(55, 65, 81);
                b.BackColor = Color.FromArgb(30, 41, 59);
                b.ForeColor = danger ? Color.FromArgb(248, 113, 113) : Color.FromArgb(229, 231, 235);
                b.Font = new Font("Segoe UI", 10F, FontStyle.Regular);
                b.Size = new Size(40, TITLE_H);
                b.Top = 0;
                b.Cursor = Cursors.Hand;
                b.Click += onClick;
                return b;
            }

            private void BeginDrag()
            {
                // 延后到消息循环稳定后执行拖拽，避免 WebView2 仍持有鼠标状态导致拖拽失效
                try { BeginInvoke((Action)(() => DragWindow())); } catch { /* 有意吞掉 */ }
            }

            private void DragWindow()
            {
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
            }

            private void ReapplyRound()
            {
                try
                {
                    if (WindowState == FormWindowState.Maximized)
                    {
                        SetWindowRgn(Handle, IntPtr.Zero, true);
                    }
                    else
                    {
                        IntPtr rgn = CreateRoundRectRgn(0, 0, Width, Height, 16, 16);
                        SetWindowRgn(Handle, rgn, true);
                    }
                }
                catch { /* 圆角失败不影响使用 */ }
            }

            // ---- 窗口尺寸持久化（独立文件，不与主窗冲突） ----
            private static string StatePath()
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DSH-Hotplug-Hub", "harness-window-state.txt");
            }

            private static int[] LoadState(Size defaultSize)
            {
                return Program.LoadWindowStateClamped(StatePath(), 640, 480, defaultSize.Width, defaultSize.Height);
            }

            private void SaveState()
            {
                try
                {
                    // 记录还原尺寸（最大化/最小化时 RestoreBounds 才是用户拖到的大小）
                    int[] s = ShellContract.ResolveWindowState(
                        WindowState == FormWindowState.Normal,
                        WindowState == FormWindowState.Maximized,
                        Bounds.Width, Bounds.Height, RestoreBounds.Width, RestoreBounds.Height);
                    if (s[0] < 640 || s[1] < 480) return;
                    string file = StatePath();
                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    File.WriteAllText(file, ShellContract.SerializeWindowState(s[0], s[1], s[2] == 1));
                }
                catch { /* 有意吞掉 */ }
            }

            // WebView2 的 native 子窗口创建后可能覆盖标题栏，这里把标题栏重新置顶（确保按钮可见可点）
            public void BringTitleBarToFront()
            {
                try { _titleBar.BringToFront(); } catch { /* 有意吞掉 */ }
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_NCHITTEST)
                {
                    if (WindowState == FormWindowState.Maximized)
                    {
                        base.WndProc(ref m);
                        return;
                    }
                    // 无边框边缘命中：顶部可调边位于标题栏下缘（titleBarH=TITLE_H），收敛到 ShellContract.HitTestResizeEdge
                    long lp = m.LParam.ToInt64();
                    int sx = (short)(lp & 0xFFFF);
                    int sy = (short)((lp >> 16) & 0xFFFF);
                    Point pt = PointToClient(new Point(sx, sy));
                    int hit = ShellContract.HitTestResizeEdge(pt.X, pt.Y, ClientSize.Width, ClientSize.Height, resizeBorder, TITLE_H);
                    if (hit != 0)
                    {
                        m.Result = (IntPtr)hit;
                    }
                    else
                    {
                        base.WndProc(ref m);
                    }
                    return;
                }
                base.WndProc(ref m);
            }
        }

        // 环境自检并自动安装（Node/pnpm/官方客户端）：返回给前端的文案
        private string EnsureEnvironmentAuto()
        {
            try
            {
                string env = EnsureHarnessEnvironment();
                return string.IsNullOrEmpty(env) ? "环境已就绪" : env;
            }
            catch (Exception ex)
            {
                return "环境检查失败：" + ex.Message;
            }
        }

        private static string ChooseHarnessManually()
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择官方 DSH 桌面端（DSH Desktop.exe）";
                dlg.Filter = "可执行程序 (*.exe)|*.exe";
                dlg.CheckFileExists = true;
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    SaveHarnessPath(dlg.FileName);
                    return dlg.FileName;
                }
            }
            return null;
        }

        private static void OpenProjectDownloadPage()
        {
            try
            {
                Process.Start("https://github.com/" + PROJECT_REPO + "/releases/latest");
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开项目下载页失败：\n" + ex.Message, "Dseam世界",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        // 统一的 GitHub API GET（带 Token、UA、15s 超时）；失败返回 null，由调用方按离线处理
        private static Dictionary<string, object> GitHubGetJson(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Accept = "application/vnd.github+json";
                string githubToken = GetGithubToken();
                if (!string.IsNullOrEmpty(githubToken)) request.Headers.Add("Authorization", "Bearer " + githubToken);
                request.Timeout = 15000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                }
            }
            catch { /* 有意吞掉：网络失败返回 null，失败结果也进缓存，避免离线时反复超时 */ }
            return null;
        }

        private static Dictionary<string, object> GitHubGetJsonCached(string url, int ttlMinutes)
        {
            lock (_githubCache)
            {
                KeyValuePair<DateTime, Dictionary<string, object>> hit;
                if (_githubCache.TryGetValue(url, out hit) && DateTime.UtcNow.Subtract(hit.Key).TotalMinutes < ttlMinutes)
                {
                    return hit.Value;
                }
            }
            Dictionary<string, object> fresh = GitHubGetJson(url);
            lock (_githubCache)
            {
                _githubCache[url] = new KeyValuePair<DateTime, Dictionary<string, object>>(DateTime.UtcNow, fresh);
            }
            return fresh;
        }

        private static void ClearGitHubCache()
        {
            lock (_githubCache) { _githubCache.Clear(); }
        }

        // 版本号规范化：去掉空白与前导 v/V，"v0.8.0-pre" 与 "0.8.0-pre" 视为相同
        private static string NormalizeVersion(string v)
        {
            if (string.IsNullOrEmpty(v)) return null;
            string s = v.Trim();
            return s.Length > 0 && (s[0] == 'v' || s[0] == 'V') ? s.Substring(1) : s;
        }

        // semver 语义比较（数值段逐个比对，pre/build 后缀整版本剥离后比较）：
        // 仅当 candidate（远程/最新）严格大于 current（本地）时返回 true——
        // 修复「本地构建版本领先 GitHub 发布时（如 0.9.8 尚未发布）每次启动误报发现新版本」。
        // 审计修复：收敛到 PatchContract.CompareVersions（与注入页面 JS nv 语义一致；
        // 旧实现按「段」剥离 '-'，`1.0.0-alpha.1` 会把 `alpha` 当作第 4 段 1 误判 > `1.0.0`）。
        private static bool IsNewerVersion(string candidate, string current)
        {
            return PatchContract.IsNewerVersion(candidate, current);
        }

        // 必须请求 releases/latest：请求 releases/tags/v{当前版本} 拿到的永远是自身 tag，更新提示永远不会触发
        private static string GetLatestReleaseVersion()
        {
            Dictionary<string, object> root = GitHubGetJsonCached("https://api.github.com/repos/" + PROJECT_REPO + "/releases/latest", 10);
            if (root != null && root.ContainsKey("tag_name"))
            {
                return Convert.ToString(root["tag_name"]).TrimStart('v');
            }
            return null;
        }

        // dsh CLI（@deepseek-ai/dsh）最新版本：官方 deepseek-ai/deepseek-harness 仓库无 release，
        // 最新版本从 npm registry 查（与 dsh 实际分发渠道一致）。
        private static string GetLatestDshCliVersion()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://registry.npmjs.org/@deepseek-ai/dsh/latest");
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Timeout = 15000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    Dictionary<string, object> root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    if (root != null && root.ContainsKey("version"))
                    {
                        string v = Convert.ToString(root["version"]);
                        if (!string.IsNullOrEmpty(v)) return v.TrimStart('v');
                    }
                }
            }
            catch { /* 网络失败返回 null，UI 不显示"最新"即可 */ }
            return null;
        }


        // ---------- 官方 Skill/MCP 面板插件（dsh-skill-mcp-panel）安装（内置于 EXE，不做联网更新检查） ----------

        private static string GetInstalledPanelVersion()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                List<string> candidates = new List<string>();
                string profilesDir = Path.Combine(home, ".dsh", "profiles");
                if (Directory.Exists(profilesDir))
                {
                    foreach (string profileDir in Directory.GetDirectories(profilesDir))
                    {
                        candidates.Add(Path.Combine(profileDir, "node_modules", "dseam-skillmcp", "package.json"));
                        candidates.Add(Path.Combine(profileDir, "node_modules", "dsh-skill-mcp-panel", "package.json"));
                    }
                }
                candidates.Add(Path.Combine(home, ".dsh", "plugin-src", "dseam-skillmcp", "package.json"));
                candidates.Add(Path.Combine(home, ".dsh", "plugin-src", "dsh-skill-mcp-panel", "package.json"));
                foreach (string pkgFile in candidates)
                {
                    if (!File.Exists(pkgFile)) continue;
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(pkgFile));
                    if (root != null && root.ContainsKey("version"))
                    {
                        string v = Convert.ToString(root["version"]);
                        if (!string.IsNullOrEmpty(v)) return v;
                    }
                }
            }
            catch
            {
            }
            return null;
        }

        // 返回 dsh 命令启动方式：{可执行文件, 参数前缀}；找不到返回 null。
        internal static string[] FindDshCommand()
        {
            // 环境切换：WSL 模式下直接用 wsl.exe 在 Linux 子系统里跑 dsh
            if (GetEnvMode() == "wsl")
            {
                if (WslDshAvailable())
                {
                    return new string[] { "wsl.exe", "-e dsh" };
                }
                // WSL 模式下没装 dsh，仍回退到 Windows 侧探测（避免完全不可用）
            }

            // 启动方式优先级：直接跑 dsh CLI（绕开第三方桌面壳）——
            //   1) PATH 中全局 dsh（npm/pnpm 安装，最常见，实测 dsh web 可直接起官方浏览器 UI）
            //   2) ~/.dsh 下的 dsh（用户级安装）
            //   3) 官方 DSH Desktop 内置 dsh CLI（兜底）
            // 返回 {可执行文件, 参数前缀}；找不到返回 null。

            // 1. PATH 中直接有 dsh（npm/pnpm 全局安装）。
            //    注意：cmd.exe /c dsh --version 在找不到 dsh 时会打印 cmd 自身版本横幅，
            //    必须排除 "Microsoft"/"Windows" 字样，避免把 cmd 横幅误判成 dsh 版本。
            string probe = RunCli("cmd.exe", "/c dsh --version");
            if (!string.IsNullOrEmpty(probe) && probe.Contains(".")
                && !probe.Contains("Microsoft") && !probe.Contains("Windows"))
            {
                return new string[] { "cmd.exe", "/c dsh" };
            }

            // 2. ~/.dsh 下的 dsh（用户级安装）
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string altBin = Path.Combine(home, ".dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
            if (File.Exists(altBin))
            {
                return new string[] { GetNodeExe(), "\"" + altBin + "\"" };
            }

            // 3. 官方 DSH Desktop 内置 dsh CLI（兜底，仅在装了桌面壳时才用）
            string harness = FindOfficialHarness();
            if (harness != null)
            {
                string appDir = Path.GetDirectoryName(harness);
                if (appDir != null)
                {
                    string binJs = Path.Combine(appDir, "resources", "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                    if (File.Exists(binJs))
                    {
                        return new string[] { GetNodeExe(), "\"" + binJs + "\"" };
                    }
                }
            }

            return null;
        }

        // 获取本机一个空闲 TCP 端口（临时监听后释放，返回可复用的端口号）
        internal static int GetFreeTcpPort()
        {
            try
            {
                TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                int port = ((IPEndPoint)listener.LocalEndpoint).Port;
                listener.Stop();
                return port;
            }
            catch { /* 失败返回 0，由调用方兜底 */ }
            return 0;
        }


        // 部分 Windows 环境的 pnpm 访问 GitHub Release 会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE，
        // 需要给 web profile 写 .npmrc 关闭严格 SSL，否则 dsh plugin add 必然失败。
        // 上游适配（v5 审计）：profile 根优先 DSH_HOME 环境变量（缺省 ~/.dsh）——
        // 与 JS 侧 resolveDshRoot 语义对齐，隔离/自定义根环境可用。
        private static void EnsureProfileNpmrc()
        {
            try
            {
                string dshRoot = Environment.GetEnvironmentVariable("DSH_HOME");
                if (string.IsNullOrEmpty(dshRoot))
                {
                    string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    dshRoot = Path.Combine(home, ".dsh");
                }
                string profileDir = Path.Combine(dshRoot, "profiles", "web");
                Directory.CreateDirectory(profileDir);
                string npmrc = Path.Combine(profileDir, ".npmrc");
                const string line = "strict-ssl=false";
                if (File.Exists(npmrc))
                {
                    string text = File.ReadAllText(npmrc);
                    if (!text.Contains(line))
                    {
                        File.AppendAllText(npmrc, Environment.NewLine + line + Environment.NewLine);
                    }
                }
                else
                {
                    File.WriteAllText(npmrc, line + Environment.NewLine);
                }
            }
            catch
            {
            }
        }
        private static string RunDshPluginAdd(string tarballUrl, IDictionary<string, string> extraEnv)
        {
            string[] cmd = FindDshCommand();
            if (cmd == null) return null;
            // H-7 端口（v5 阶段 4，PatchContract）：URL 进 argv 前过 shell 安全契约——
            // 拒绝元字符/空白（曾仅剔除引号，& 等可拆坏参数）
            try
            {
                PatchContract.AssertShellSafeUrl(tarballUrl, "tarballUrl");
            }
            catch (ArgumentException ex)
            {
                return "tarballUrl 非法：" + ex.Message;
            }
            string args = cmd[1] + " plugin --profile web add \"" + (tarballUrl ?? "").Replace("\"", "") + "\"";
            return RunCliLong(cmd[0], args, 180000, extraEnv);
        }

        // 安装插件包：部分 Windows 环境访问 GitHub Release 报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
        // M-47（v5 阶段 4）：TLS 默认开且不可 env 绕过——删除进程级 npm_config_strict_ssl=false
        // 降级（blanket）；仅保留用户可见的 profile .npmrc 显式配置兜底（用户可自行移除）。
        private static string InstallPluginPackage(string tarballUrl)
        {
            string output = RunDshPluginAdd(tarballUrl, null);
            if (output != null && output.Contains("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))
            {
                EnsureProfileNpmrc();
                output = RunDshPluginAdd(tarballUrl, null);
            }
            return output;
        }

        private static string RunDshPanelInstall(string tarballUrl)
        {
            return InstallPluginPackage(tarballUrl);
        }

        private static string RunCliLong(string fileName, string arguments)
        {
            return RunCliLong(fileName, arguments, 180000, null);
        }

        // extraEnv 用于进程级注入 npm 配置（如证书降级重试），不污染全局 .npmrc
        private static string RunCliLong(string fileName, string arguments, int timeoutMs, IDictionary<string, string> extraEnv)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(fileName, arguments);
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
                if (extraEnv != null)
                {
                    foreach (KeyValuePair<string, string> kv in extraEnv)
                    {
                        psi.EnvironmentVariables[kv.Key] = kv.Value;
                    }
                }
                using (Process p = Process.Start(psi))
                {
                    Task<string> stdout = p.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(timeoutMs))
                    {
                        try { p.Kill(); } catch { /* 有意吞掉：尽力而为的清理 */ }
                        try { p.WaitForExit(2000); } catch { /* 有意吞掉：尽力而为的清理 */ }
                    }
                    string outText = stdout.Status == TaskStatus.RanToCompletion ? stdout.Result.Trim() : "";
                    // pnpm 的报错大多走 stderr，合并进来上层的错误关键字（ERR_PNPM 等）才能命中
                    string errText = stderr.Status == TaskStatus.RanToCompletion ? stderr.Result.Trim() : "";
                    return errText.Length > 0 ? outText + Environment.NewLine + errText : outText;
                }
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }

        private static string InstallOrUpdatePanel()
        {
            // 内置 Skill/MCP 管理器：不再请求 Fishquito7 上游 Release（GitHub 限流/网络失败会导致“更新不了”），
            // 一律从 EXE 内置 tgz 安装/升级到 PANEL_VERSION。
            return InstallEmbeddedSkillMcp();
        }
        // 读取 DSH 核心版本，按真实来源优先级（避免把「DSH Desktop.exe 文件版本」当 DSH 版本）：
        //   1) 官方 DSH Desktop 的 resources/app/package.json（dependencies["@deepseek-ai/dsh"]，缺省取其根 version）
        //   2) 官方 Desktop 内置 node_modules/@deepseek-ai/dsh/package.json
        //   3) 全局 Node 安装（node-v*/nodejs）下的 node_modules/@deepseek-ai/dsh/package.json
        //   4) PATH 中 dsh CLI（cmd /c dsh --version，排除 cmd 横幅误判）
        // 全部失败返回 null（UI 显示「未检测到 DSH」），不再回退 exe 文件版本号。
        private static string ReadPackageJsonVersion(string pkgPath)
        {
            try
            {
                if (!File.Exists(pkgPath)) return null;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(pkgPath));
                if (root != null && root.ContainsKey("version"))
                {
                    string v = Convert.ToString(root["version"]);
                    if (!string.IsNullOrEmpty(v)) return v.Trim();
                }
            }
            catch { /* 有意吞掉：尽力而为的探测，失败继续下一来源 */ }
            return null;
        }

        private static string GetDshCoreVersion()
        {
            try
            {
                // 架构改为直接用 dsh CLI 启动官方 web 服务，因此「DSH 版本」= 本机 dsh CLI 版本。
                // 1. 直接跑 dsh --version（最准确，和启动逻辑一致）
                string cliVer = RunCli("cmd.exe", "/c dsh --version");
                if (!string.IsNullOrEmpty(cliVer) && cliVer.Contains(".")
                    && !cliVer.Contains("Microsoft") && !cliVer.Contains("Windows"))
                {
                    return cliVer.Trim();
                }
                // 2. 兜底：读全局 npm 安装的 @deepseek-ai/dsh package.json
                string npmPkg = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "npm", "node_modules", "@deepseek-ai", "dsh", "package.json");
                string npmVer = ReadPackageJsonVersion(npmPkg);
                if (!string.IsNullOrEmpty(npmVer)) return npmVer;
                // 3. 兜底：官方 DSH Desktop 内置 dsh 包（仅装了桌面壳时）
                string appDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs", "DSH Desktop", "resources", "app");
                string binPkg = Path.Combine(appDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
                string binV = ReadPackageJsonVersion(binPkg);
                if (!string.IsNullOrEmpty(binV)) return binV;
                return null;
            }
            catch { /* 有意吞掉：尽力而为的探测，失败返回 null */ }
            return null;
        }

        // 官方 Harness 判据：同目录存在 resources/app 结构（package.json 或内置 @deepseek-ai/dsh）；
        // 无官方结构时至少拒绝 Node.js 壳（曾有 Programs\DSH Desktop 目录只放了 node.exe 改名壳，
        // 被误认成「官方 Harness 已安装」，其 FileVersion（如 24.18.0）还被误当 DSH 版本）。
        private static bool IsOfficialHarnessExe(string exe)
        {
            try
            {
                string dir = Path.GetDirectoryName(exe);
                if (string.IsNullOrEmpty(dir)) return false;
                string appPkg = Path.Combine(dir, "resources", "app", "package.json");
                string binJs = Path.Combine(dir, "resources", "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                if (File.Exists(appPkg) || File.Exists(binJs)) return true;
                string product = FileVersionInfo.GetVersionInfo(exe).ProductName ?? "";
                return product.Length > 0 && product.IndexOf("Node", StringComparison.OrdinalIgnoreCase) < 0;
            }
            catch
            {
                return false;
            }
        }

        private static string FindOfficialHarness()
        {
            // 1. 用户手动选择过的路径优先（同样须通过官方判据；残留的假路径清空重测）
            string saved = LoadHarnessPath();
            if (saved != null && File.Exists(saved))
            {
                if (IsOfficialHarnessExe(saved)) return saved;
                try { File.WriteAllText(HarnessSettingsPath(), ""); } catch { /* 有意吞掉：清理失败不影响主流程 */ }
            }

            // 2. 常见安装位置（命中须通过官方判据）
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DSH Desktop", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DeepSeek Harness", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DSH Desktop", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DeepSeek Harness", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "DSH Desktop", "DSH Desktop.exe")
            };
            foreach (string candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate) && IsOfficialHarnessExe(candidate)) return candidate;
                }
                catch
                {
                }
            }

            // 3. 自动扫描常见程序目录里的 DSH / DeepSeek 相关桌面端（命中须通过官方判据）
            string[] roots = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
            };
            foreach (string root in roots)
            {
                if (!Directory.Exists(root)) continue;
                string[] dirs;
                try { dirs = Directory.GetDirectories(root); }
                catch { continue; }
                foreach (string dir in dirs)
                {
                    string name = Path.GetFileName(dir).ToLowerInvariant();
                    if (!name.Contains("dsh") && !name.Contains("deepseek")) continue;
                    string[] exeNames = new string[] { "DSH Desktop.exe", "DeepSeek Harness.exe", "deepseek-harness.exe", "Dsh.exe" };
                    foreach (string exeName in exeNames)
                    {
                        string full = Path.Combine(dir, exeName);
                        if (File.Exists(full) && IsOfficialHarnessExe(full))
                        {
                            SaveHarnessPath(full);
                            return full;
                        }
                    }
                }
            }
            return null;
        }

        private static string HarnessSettingsPath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSH-Hotplug-Hub", "harness-path.txt");
        }

        // ---------- dsh 运行环境切换（Windows 本机 / WSL 子系统） ----------

        // 环境模式持久化文件：内容为 "windows" 或 "wsl"
        private static string EnvModePath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSH-Hotplug-Hub", "env-mode.txt");
        }

        // 读取当前环境模式，缺省 windows
        private static string GetEnvMode()
        {
            try
            {
                string text = File.ReadAllText(EnvModePath()).Trim().ToLowerInvariant();
                if (text == "wsl") return "wsl";
            }
            catch { /* 无文件则默认 windows */ }
            return "windows";
        }

        // 保存环境模式
        private static void SetEnvMode(string mode)
        {
            try
            {
                string dir = Path.GetDirectoryName(EnvModePath());
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(EnvModePath(), mode == "wsl" ? "wsl" : "windows");
            }
            catch { /* 有意吞掉：持久化失败不影响本次运行 */ }
        }

        // 探测 WSL 是否可用（wsl.exe 存在且至少有一个发行版）
        private static bool WslAvailable()
        {
            try
            {
                string outText = RunCli("wsl.exe", "-l -q");
                return !string.IsNullOrEmpty(outText) && !outText.Contains("未安装") && !outText.Contains("not installed");
            }
            catch { return false; }
        }

        // 探测 WSL 里是否装了 dsh
        private static bool WslDshAvailable()
        {
            string outText = RunCli("wsl.exe", "-e dsh --version");
            return !string.IsNullOrEmpty(outText) && outText.Contains(".") && !outText.Contains("command not found");
        }

        // 窗口状态（尺寸/位置/最大化）持久化文件
        private static string WindowStatePath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSH-Hotplug-Hub", "window-state.txt");
        }

        // 读取上次窗口状态：{w,h,maximized}（已按当前主屏工作区钳制）；无记录返回钳制后的默认尺寸
        private static int[] LoadWindowState()
        {
            return Program.LoadWindowStateClamped(WindowStatePath(), 900, 600, 1240, 820);
        }

        // 记录窗口状态（关闭/退出时调用）：正常态取 Bounds，最大化/最小化取 RestoreBounds，
        // 最大化另记 max=1。修复旧实现「最大化时跳过保存 + max 恒为 0」导致「恢复最大化」成为死代码。
        // 仅窗口可见时保存：已隐藏到托盘后，HideMainSafely 已把状态规范化为 Normal，再保存会
        // 用 Normal 尺寸覆盖掉隐藏前记录的 max=1 最大化标志——故隐藏态直接跳过（隐藏时已保存过）。
        private void SaveWindowState()
        {
            try
            {
                if (!Visible) return;
                int[] s = ShellContract.ResolveWindowState(
                    WindowState == FormWindowState.Normal,
                    WindowState == FormWindowState.Maximized,
                    Bounds.Width, Bounds.Height, RestoreBounds.Width, RestoreBounds.Height);
                string file = WindowStatePath();
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, ShellContract.SerializeWindowState(s[0], s[1], s[2] == 1));
            }
            catch { /* 有意吞掉 */ }
        }

        private static string LoadHarnessPath()
        {
            try
            {
                string text = File.ReadAllText(HarnessSettingsPath()).Trim();
                return text.Length > 0 ? text : null;
            }
            catch
            {
                return null;
            }
        }

        private static void SaveHarnessPath(string path)
        {
            try
            {
                string file = HarnessSettingsPath();
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, path);
            }
            catch
            {
            }
        }


        private static bool TryDownloadFile(string url, string local, string authToken, int timeoutMs)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Timeout = timeoutMs;
                request.ReadWriteTimeout = timeoutMs;
                if (!string.IsNullOrEmpty(authToken) && url.StartsWith("https://github.com/"))
                {
                    request.Headers.Add("Authorization", "Bearer " + authToken);
                }
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (Stream inStream = response.GetResponseStream())
                using (FileStream outStream = File.Create(local))
                {
                    byte[] buffer = new byte[81920];
                    int read;
                    while ((read = inStream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        outStream.Write(buffer, 0, read);
                    }
                }
                return File.Exists(local) && new FileInfo(local).Length > 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool DownloadNodeZip(string version, string local)
        {
            string[] urls = new string[]
            {
                "https://npmmirror.com/mirrors/node/" + version + "/node-" + version + "-win-x64.zip",
                "https://nodejs.org/dist/" + version + "/node-" + version + "-win-x64.zip"
            };
            foreach (string u in urls)
            {
                if (TryDownloadFile(u, local, null, 180000)) return true;
            }
            return false;
        }

        private static string FetchNodeLtsFrom(string url)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Timeout = 15000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    object[] arr = new JavaScriptSerializer().Deserialize<object[]>(reader.ReadToEnd());
                    string fallback = null;
                    foreach (object itemObj in arr)
                    {
                        Dictionary<string, object> item = itemObj as Dictionary<string, object>;
                        if (item == null) continue;
                        string v = Convert.ToString(item.ContainsKey("version") ? item["version"] : "");
                        if (string.IsNullOrEmpty(v)) continue;
                        if (fallback == null) fallback = v;
                        if (item.ContainsKey("lts") && item["lts"] != null
                            && !string.IsNullOrEmpty(Convert.ToString(item["lts"])))
                        {
                            return v;
                        }
                    }
                    return fallback;
                }
            }
            catch
            {
            }
            return null;
        }

        private static string GetNodeInstallDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "DseamWorld", "node");
        }

        private static string GetNodeExe()
        {
            string portable = Path.Combine(GetNodeInstallDir(), "node.exe");
            return File.Exists(portable) ? portable : "node";
        }

        private static string GetLatestNodeLtsVersion()
        {
            string[] urls = new string[]
            {
                "https://npmmirror.com/mirrors/node/index.json",
                "https://nodejs.org/dist/index.json"
            };
            foreach (string u in urls)
            {
                string v = FetchNodeLtsFrom(u);
                if (!string.IsNullOrEmpty(v)) return v;
            }
            return null;
        }

        private static string EnsureNodeEnvironment()
        {
            try
            {
                string nodeDir = GetNodeInstallDir();
                string nodeExe = Path.Combine(nodeDir, "node.exe");
                if (File.Exists(nodeExe))
                {
                    return "Node.js 便携版已就绪（" + nodeDir + "）";
                }
                string version = GetLatestNodeLtsVersion();
                if (string.IsNullOrEmpty(version)) return "无法获取 Node.js 版本列表，请检查网络";
                string zip = Path.Combine(Path.GetTempPath(), "node-" + version + "-win-x64.zip");
                if (!DownloadNodeZip(version, zip))
                {
                    return "Node.js " + version + " 下载失败（npmmirror 与 nodejs.org 均不可用），请检查网络";
                }
                string extractRoot = Path.Combine(Path.GetTempPath(), "dsh-node-extract");
                if (Directory.Exists(extractRoot))
                {
                    try { Directory.Delete(extractRoot, true); } catch { /* 有意吞掉：清理失败继续 */ }
                }
                Directory.CreateDirectory(extractRoot);
                string tarOut = RunCliLong("tar.exe", "-xf \"" + zip + "\" -C \"" + extractRoot + "\"", 600000, null);
                string inner = Path.Combine(extractRoot, "node-" + version + "-win-x64");
                if (!Directory.Exists(inner))
                {
                    if (tarOut != null && (tarOut.Contains("error") || tarOut.Contains("Cannot"))) return "Node.js 解压失败：" + tarOut;
                    return "Node.js 解压失败：未找到 " + inner;
                }
                Directory.CreateDirectory(nodeDir);
                foreach (string item in Directory.GetFileSystemEntries(inner))
                {
                    string dest = Path.Combine(nodeDir, Path.GetFileName(item));
                    if (Directory.Exists(item)) Directory.Move(item, dest);
                    else File.Move(item, dest);
                }
                try { Directory.Delete(extractRoot, true); } catch { /* 有意吞掉 */ }
                try { File.Delete(zip); } catch { /* 有意吞掉 */ }
                return "Node.js " + version + " 便携版已安装到 " + nodeDir;
            }
            catch (Exception ex)
            {
                return "自动安装 Node.js 失败：" + ex.Message;
            }
        }

        private static string EnsurePnpmEnvironment()
        {
            try
            {
                string existing = GetPnpmVersion();
                if (!string.IsNullOrEmpty(existing)) return "pnpm 已就绪 v" + existing;
                string nodeDir = GetNodeInstallDir();
                string nodeExe = Path.Combine(nodeDir, "node.exe");
                if (!File.Exists(nodeExe))
                {
                    string nodeResult = EnsureNodeEnvironment();
                    if (!File.Exists(nodeExe)) return nodeResult;
                }
                string npmCli = Path.Combine(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
                if (!File.Exists(npmCli)) return "便携版 Node 缺少 npm，请删除 " + nodeDir + " 后重试";
                RunCliLong(nodeExe, "\"" + npmCli + "\" install -g pnpm", 600000, null);
                string after = GetPnpmVersion();
                if (!string.IsNullOrEmpty(after)) return "pnpm v" + after + " 已安装到便携 Node";
                return "pnpm 安装已提交，请点击“重新自检”确认";
            }
            catch (Exception ex)
            {
                return "自动安装 pnpm 失败：" + ex.Message;
            }
        }

        private static string EnsureHarnessEnvironment()
        {
            string step1 = null, step2 = null, step3 = null;
            string node = RunCli(GetNodeExe(), "--version");
            if (string.IsNullOrEmpty(node)) step1 = EnsureNodeEnvironment();
            string pnpm = GetPnpmVersion();
            if (string.IsNullOrEmpty(pnpm)) step2 = EnsurePnpmEnvironment();
            // 绕开第三方桌面壳：直接检查/安装 dsh CLI（官方 DeepSeek Harness 核心）
            string dsh = RunCli("cmd.exe", "/c dsh --version");
            if (string.IsNullOrEmpty(dsh) || dsh.Contains("Microsoft") || dsh.Contains("Windows"))
                step3 = EnsureDshCli();
            List<string> steps = new List<string>();
            if (step1 != null) steps.Add(step1);
            if (step2 != null) steps.Add(step2);
            if (step3 != null) steps.Add(step3);
            if (steps.Count == 0) return "dsh 环境已就绪";
            return string.Join("；", steps.ToArray());
        }

        // 一键安装 dsh CLI（检查 Node/pnpm/dsh，缺啥装啥），供「启动 DSH」和「一键修复」共用
        private static string EnsureDshCliEnvironment()
        {
            string step1 = null, step2 = null, step3 = null;
            string node = RunCli(GetNodeExe(), "--version");
            if (string.IsNullOrEmpty(node)) step1 = EnsureNodeEnvironment();
            string pnpm = GetPnpmVersion();
            if (string.IsNullOrEmpty(pnpm)) step2 = EnsurePnpmEnvironment();
            string dsh = RunCli("cmd.exe", "/c dsh --version");
            if (string.IsNullOrEmpty(dsh) || dsh.Contains("Microsoft") || dsh.Contains("Windows"))
                step3 = EnsureDshCli();
            List<string> steps = new List<string>();
            if (step1 != null) steps.Add(step1);
            if (step2 != null) steps.Add(step2);
            if (step3 != null) steps.Add(step3);
            if (steps.Count == 0) return "dsh 环境已就绪";
            return string.Join("；", steps.ToArray());
        }

        // 全局安装 @deepseek-ai/dsh（官方 DeepSeek Harness CLI）
        private static string EnsureDshCli()
        {
            try
            {
                // npm 是 npm.cmd / npm.ps1，必须经 cmd.exe /c 调用，直接 spawn "npm" 会报「系统找不到文件」；
                // 带 --allow-scripts 允许 koffi/node-pty 等原生模块编译，否则运行时「Mismatched native Koffi modules」。
                RunCliLong("cmd.exe", "/c npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh", 600000, null);
                string after = RunCli("cmd.exe", "/c dsh --version");
                if (!string.IsNullOrEmpty(after) && !after.Contains("Microsoft") && !after.Contains("Windows"))
                    return "dsh v" + after.Trim() + " 已安装";
                return "dsh 安装已提交，请重启程序后重试";
            }
            catch (Exception ex)
            {
                return "自动安装 dsh 失败：" + ex.Message;
            }
        }

        // 强制更新 dsh 到 npm 最新版（installHarness 按钮用，区别于 EnsureDshCliEnvironment 的「缺啥装啥」）
        private static string UpdateDshCli()
        {
            try
            {
                string before = RunCli("cmd.exe", "/c dsh --version");
                string beforeVer = (before != null && before.Contains(".") && !before.Contains("Microsoft") && !before.Contains("Windows")) ? before.Trim() : null;
                string latest = GetLatestDshCliVersion();

                // npm 是 npm.cmd / npm.ps1，UseShellExecute=false 直接 spawn "npm" 会报「系统找不到文件」，
                // 必须经 cmd.exe /c 调用；否则更新静默失败又被下面的「已是最新」判断掩盖。
                // 必须带 --allow-scripts 允许 koffi/node-pty/dsh-subprocess-local 等原生模块编译，
                // 否则运行时「Mismatched native Koffi modules」导致 dsh web 起不来。
                string outText = RunCliLong("cmd.exe", "/c npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh@latest", 600000, null);

                string after = RunCli("cmd.exe", "/c dsh --version");
                string afterVer = (after != null && after.Contains(".") && !after.Contains("Microsoft") && !after.Contains("Windows")) ? after.Trim() : null;

                // 以 npm 最新版为准判断是否更新到位，而非「前后版本没变就说已是最新」
                if (afterVer != null && latest != null && afterVer == latest)
                {
                    if (beforeVer != null && beforeVer == afterVer)
                    {
                        return "dsh 已是最新 v" + afterVer;
                    }
                    return "dsh 已更新：v" + (beforeVer ?? "未安装") + " → v" + afterVer;
                }
                if (afterVer != null && beforeVer != null && beforeVer != afterVer)
                {
                    // 版本变了但还没到最新（可能 npm 源滞后），如实报告
                    return "dsh 已更新到 v" + afterVer + "（npm 最新为 v" + (latest ?? "?") + "）";
                }
                // 更新后版本未变：说明安装失败或已是最新但 latest 未取到
                if (beforeVer != null && afterVer != null && beforeVer == afterVer)
                {
                    string tail = "";
                    if (outText != null && outText.Length > 0)
                    {
                        string shortText = outText.Trim();
                        if (shortText.Length > 160) shortText = shortText.Substring(0, 160);
                        tail = "：\n" + shortText;
                    }
                    return "dsh 更新失败，版本未变化（仍为 v" + afterVer + "）" + tail;
                }
                return "dsh 更新已提交，请重启程序后重试";
            }
            catch (Exception ex)
            {
                return "dsh 更新失败：" + ex.Message;
            }
        }

        // ---------- 配置修复（修复 ~/.dsh 下已知的损坏模式，让 dsh 能正常启动） ----------

        // 修复 dsh 配置文件（settings.yaml 重复键 / .credentials.yaml 格式错误等）
        internal static string RepairDshConfig()
        {
            List<string> results = new List<string>();
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string dshDir = Path.Combine(home, ".dsh");
            if (!Directory.Exists(dshDir)) return "未找到 ~/.dsh 目录，跳过配置修复";

            // 1. settings.yaml：移除同一缩进层级下连续重复的键（保留第一个）
            string settingsPath = Path.Combine(dshDir, "settings.yaml");
            if (File.Exists(settingsPath))
            {
                try
                {
                    string[] lines = File.ReadAllLines(settingsPath);
                    List<string> kept = new List<string>();
                    int removed = 0;
                    for (int i = 0; i < lines.Length; i++)
                    {
                        string line = lines[i];
                        // 跳过空行与注释
                        string trimmed = line.TrimEnd();
                        if (string.IsNullOrWhiteSpace(trimmed) || trimmed.TrimStart().StartsWith("#"))
                        {
                            kept.Add(line);
                            continue;
                        }
                        int indent = line.Length - line.TrimStart().Length;
                        string key = trimmed.Split(':')[0].Trim();
                        // 检查前一行是否为「相同缩进 + 相同键」（重复键）
                        bool dup = false;
                        if (kept.Count > 0)
                        {
                            string prev = kept[kept.Count - 1];
                            if (!string.IsNullOrWhiteSpace(prev) && !prev.TrimStart().StartsWith("#"))
                            {
                                int prevIndent = prev.Length - prev.TrimStart().Length;
                                string prevKey = prev.TrimEnd().Split(':')[0].Trim();
                                if (prevIndent == indent && prevKey == key)
                                {
                                    dup = true;
                                }
                            }
                        }
                        if (dup) { removed++; continue; }
                        kept.Add(line);
                    }
                    if (removed > 0)
                    {
                        File.WriteAllLines(settingsPath, kept.ToArray(), new UTF8Encoding(false));
                        results.Add("settings.yaml 已移除 " + removed + " 处重复键");
                    }
                }
                catch (Exception ex) { results.Add("settings.yaml 修复失败：" + ex.Message); }
            }

            // 2. .credentials.yaml：必须是「凭证名 → 字符串」扁平映射；修复 version/refs 包裹层
            string credPath = Path.Combine(dshDir, ".credentials.yaml");
            if (File.Exists(credPath))
            {
                try
                {
                    string[] lines = File.ReadAllLines(credPath);
                    bool hasWrap = false;
                    foreach (string l in lines)
                    {
                        string t = l.TrimEnd();
                        if (t.TrimStart().StartsWith("version:") || t.TrimStart().StartsWith("refs:"))
                        {
                            hasWrap = true;
                            break;
                        }
                    }
                    if (hasWrap)
                    {
                        List<string> outLines = new List<string>();
                        foreach (string l in lines)
                        {
                            string t = l.TrimEnd();
                            string ts = t.TrimStart();
                            if (ts.StartsWith("version:") || ts.StartsWith("refs:")) continue;
                            // refs 下的缩进 key 提升到顶层
                            int indent = t.Length - ts.Length;
                            if (indent >= 2 && ts.Contains(":"))
                            {
                                outLines.Add(ts);
                            }
                            else if (!string.IsNullOrWhiteSpace(t) && !ts.StartsWith("#"))
                            {
                                outLines.Add(ts);
                            }
                            else if (string.IsNullOrWhiteSpace(t))
                            {
                                // 跳过空行
                            }
                        }
                        File.WriteAllLines(credPath, outLines.ToArray(), new UTF8Encoding(false));
                        results.Add(".credentials.yaml 已扁平化为凭证映射");
                    }
                }
                catch (Exception ex) { results.Add(".credentials.yaml 修复失败：" + ex.Message); }
            }

            if (results.Count == 0) return "配置文件未发现需要修复的损坏";
            return string.Join("；", results.ToArray());
        }

        // ---------- API 模型配置 ----------

        private sealed class ApiConfig
        {
            public string provider = "DeepSeek 官方";
            public string baseUrl = "https://api.deepseek.com/v1";
            public string apiKey = "";
            public string models = "deepseek-chat,deepseek-reasoner";
            public string defaultModel = "deepseek-chat";
            public double temperature = 0.8; // AI 对话温度：统一为 0.8，更自然、有人情味
        }

        private static string ApiConfigPath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSH-Hotplug-Hub", "api-config.json");
        }

        private static ApiConfig LoadApiConfig()
        {
            ApiConfig cfg = DefaultApiConfig();
            try
            {
                // 应用自身保存的配置（api-config.json）作为基底：修复“保存后重启即丢”
                string appCfgPath = ApiConfigPath();
                if (File.Exists(appCfgPath))
                {
                    try
                    {
                        JavaScriptSerializer ser = new JavaScriptSerializer();
                        ApiConfig saved = ser.Deserialize<ApiConfig>(File.ReadAllText(appCfgPath));
                        if (saved != null)
                        {
                            if (!string.IsNullOrEmpty(saved.provider)) cfg.provider = saved.provider;
                            if (!string.IsNullOrEmpty(saved.baseUrl)) cfg.baseUrl = saved.baseUrl;
                            if (!string.IsNullOrEmpty(saved.apiKey)) cfg.apiKey = saved.apiKey;
                            if (!string.IsNullOrEmpty(saved.models)) cfg.models = saved.models;
                            if (!string.IsNullOrEmpty(saved.defaultModel)) cfg.defaultModel = saved.defaultModel;
                            // 统一 AI 对话温度 0.8：旧保存值不再覆盖
                        }
                    }
                    catch { /* 配置损坏时回退官方配置 */ }
                }
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string dshDir = Path.Combine(home, ".dsh");
                string settingsPath = Path.Combine(dshDir, "settings.yaml");
                string credPath = Path.Combine(dshDir, ".credentials.yaml");

                if (File.Exists(settingsPath))
                {
                    string[] lines = File.ReadAllLines(settingsPath);
                    string section = "";
                    string provider = null;
                    string model = null;
                    string baseUrl = null;
                    List<string> deepseekModels = new List<string>();
                    bool inDeepseekModels = false;

                    foreach (string raw in lines)
                    {
                        string line = raw.TrimEnd();
                        string t = line.Trim();
                        if (t == "agent-default-model:")
                        {
                            section = "agent";
                            continue;
                        }
                        if (t == "llm-deepseek:")
                        {
                            section = "deepseek";
                            inDeepseekModels = false;
                            continue;
                        }
                        if (t == "llm-pi-ai:")
                        {
                            section = "pi";
                            continue;
                        }
                        if (t.Length > 0 && !t.StartsWith(" ") && t.EndsWith(":"))
                        {
                            section = "";
                            inDeepseekModels = false;
                            continue;
                        }

                        if (section == "agent")
                        {
                            if (t.StartsWith("provider:")) provider = t.Substring("provider:".Length).Trim();
                            if (t.StartsWith("model:")) model = t.Substring("model:".Length).Trim();
                        }
                        else if (section == "deepseek")
                        {
                            if (t == "models:") { inDeepseekModels = true; continue; }
                            if (inDeepseekModels && t.StartsWith("- id:"))
                            {
                                string id = t.Substring("- id:".Length).Trim();
                                if (id.Length > 0) deepseekModels.Add(id);
                            }
                        }
                        else if (section == "pi" && t.StartsWith("baseURL:"))
                        {
                            baseUrl = t.Substring("baseURL:".Length).Trim();
                        }
                    }

                    if (provider != null) cfg.provider = provider;
                    if (model != null) cfg.defaultModel = model;
                    if (!string.IsNullOrEmpty(baseUrl)) cfg.baseUrl = baseUrl;
                    if (deepseekModels.Count > 0) cfg.models = string.Join(",", deepseekModels.ToArray());
                }

                if (File.Exists(credPath))
                {
                    foreach (string line in File.ReadAllLines(credPath))
                    {
                        if (line.StartsWith("DEEPSEEK_API_KEY:"))
                        {
                            cfg.apiKey = line.Substring(line.IndexOf(':') + 1).Trim();
                            break;
                        }
                    }
                }
            }
            catch
            {
            }
            return cfg;
        }

        private static ApiConfig DefaultApiConfig()
        {
            ApiConfig cfg = new ApiConfig();
            // 直接使用官方 DSH 的配置目录
            try
            {
                string cred = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", ".credentials.yaml");
                if (File.Exists(cred))
                {
                    foreach (string line in File.ReadAllLines(cred))
                    {
                        if (line.StartsWith("DEEPSEEK_API_KEY:"))
                        {
                            cfg.apiKey = line.Substring(line.IndexOf(':') + 1).Trim();
                            break;
                        }
                    }
                }
            }
            catch
            {
            }
            return cfg;
        }

        private static void SaveApiConfig(ApiConfig cfg)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                string json = ser.Serialize(cfg);
                string file = ApiConfigPath();
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, json);
                // M-48（v5 阶段 4）：密钥文件 owner-only ACL（仅当前用户可读写）
                PatchContract.ApplyOwnerOnlyAcl(file);
            }
            catch
            {
            }
        }        private static void ShowApiConfigDialog()
        {
            ApiConfig cfg = LoadApiConfig();
            using (Form dlg = new Form())
            {
                dlg.Text = "模型";
                dlg.Width = 760;
                dlg.Height = 480;
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false;
                dlg.MinimizeBox = false;
                dlg.Font = new Font("Microsoft YaHei UI", 9F);

                Label lProviders = new Label(); lProviders.Text = "AI 服务提供方"; lProviders.SetBounds(16, 14, 140, 24);
                ListBox lstProviders = new ListBox();
                lstProviders.SetBounds(16, 42, 200, 320);
                lstProviders.Items.AddRange(LoadProviderIds());

                Label lName = new Label(); lName.Text = "名称"; lName.SetBounds(240, 42, 100, 24);
                TextBox txtName = new TextBox(); txtName.SetBounds(340, 40, 380, 26);

                Label lUrl = new Label(); lUrl.Text = "Base URL"; lUrl.SetBounds(240, 78, 100, 24);
                TextBox txtUrl = new TextBox(); txtUrl.Text = cfg.baseUrl; txtUrl.SetBounds(340, 76, 380, 26);

                Label lKey = new Label(); lKey.Text = "API Key"; lKey.SetBounds(240, 114, 100, 24);
                TextBox txtKey = new TextBox(); txtKey.Text = cfg.apiKey; txtKey.UseSystemPasswordChar = true; txtKey.SetBounds(340, 112, 380, 26);

                Label lModels = new Label(); lModels.Text = "模型列表"; lModels.SetBounds(240, 150, 100, 24);
                TextBox txtModels = new TextBox(); txtModels.Text = cfg.models; txtModels.SetBounds(340, 148, 380, 26);

                Label lDefault = new Label(); lDefault.Text = "默认模型"; lDefault.SetBounds(240, 186, 100, 24);
                ComboBox cboDefault = new ComboBox(); cboDefault.DropDownStyle = ComboBoxStyle.DropDown;
                cboDefault.Items.AddRange(cfg.models.Split(','));
                cboDefault.Text = cfg.defaultModel; cboDefault.SetBounds(340, 184, 380, 26);

                lstProviders.SelectedIndexChanged += delegate
                {
                    if (lstProviders.SelectedItem == null) return;
                    string id = lstProviders.SelectedItem.ToString();
                    ApiConfig p = LoadProviderConfig(id);
                    if (p == null) return;
                    txtName.Text = id;
                    txtUrl.Text = p.baseUrl;
                    txtKey.Text = p.apiKey;
                    txtModels.Text = p.models;
                    cboDefault.Items.Clear();
                    cboDefault.Items.AddRange(p.models.Split(','));
                    cboDefault.Text = p.defaultModel;
                };

                Button btnAdd = new Button(); btnAdd.Text = "＋ 添加提供方"; btnAdd.SetBounds(16, 372, 200, 30);
                btnAdd.Click += delegate
                {
                    string id = "provider-" + DateTime.Now.Ticks.ToString("x");
                    lstProviders.Items.Add(id);
                    lstProviders.SelectedItem = id;
                };

                Button btnDel = new Button(); btnDel.Text = "删除提供方"; btnDel.SetBounds(16, 408, 200, 30);
                btnDel.Click += delegate
                {
                    if (lstProviders.SelectedItem != null)
                    {
                        DeleteProviderFile(lstProviders.SelectedItem.ToString());
                        lstProviders.Items.Remove(lstProviders.SelectedItem);
                    }
                };

                Button btnTest = new Button(); btnTest.Text = "测试连接"; btnTest.SetBounds(340, 240, 110, 30);
                btnTest.Click += delegate
                {
                    ApiConfig t = new ApiConfig();
                    t.baseUrl = txtUrl.Text.Trim();
                    t.apiKey = txtKey.Text.Trim();
                    t.defaultModel = cboDefault.Text.Trim();
                    t.models = txtModels.Text.Trim();
                    string err;
                    bool ok = TestApiConnection(t, out err);
                    MessageBox.Show(ok ? "连接成功 ✅" : "连接失败 ❌\n" + err, "Dseam世界 模型测试",
                        MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                };

                Button btnSave = new Button(); btnSave.Text = "保存"; btnSave.BackColor = Color.FromArgb(14,124,107); btnSave.ForeColor = Color.White; btnSave.FlatStyle = FlatStyle.Flat; btnSave.SetBounds(340, 280, 120, 30);
                btnSave.Click += delegate
                {
                    cfg.provider = txtName.Text.Trim();
                    cfg.baseUrl = txtUrl.Text.Trim();
                    cfg.apiKey = txtKey.Text.Trim();
                    cfg.models = txtModels.Text.Trim();
                    cfg.defaultModel = cboDefault.Text.Trim();
                    if (cfg.defaultModel.Length == 0 && cfg.models.Length > 0) cfg.defaultModel = cfg.models.Split(',')[0].Trim();
                    SaveApiConfig(cfg);
                    SaveProviderToOfficial(cfg);
                    SyncApiConfigToOfficialDesktop(cfg);
                    MessageBox.Show("已保存并同步到官方 DSH。", "模型", MessageBoxButtons.OK, MessageBoxIcon.Information);
                };

                Button btnClose = new Button(); btnClose.Text = "关闭"; btnClose.SetBounds(470, 280, 80, 30);
                btnClose.Click += delegate { dlg.Close(); };

                dlg.Controls.AddRange(new Control[] { lProviders, lstProviders, lName, txtName, lUrl, txtUrl, lKey, txtKey, lModels, txtModels, lDefault, cboDefault, btnAdd, btnDel, btnTest, btnSave, btnClose });
                dlg.ShowDialog();
            }
        }

        private static string[] LoadProviderIds()
        {
            try
            {
                List<string> ids = new List<string>();
                ids.Add("DeepSeek 官方");
                string settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "settings.yaml");
                if (File.Exists(settings))
                {
                    string yaml = File.ReadAllText(settings);
                    int idx = yaml.IndexOf("llm-pi-ai:");
                    if (idx >= 0)
                    {
                        int prov = yaml.IndexOf("providers:", idx);
                        if (prov >= 0)
                        {
                            string block = yaml.Substring(prov);
                            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(block, @"^\s{4}([a-zA-Z0-9_-]+):", System.Text.RegularExpressions.RegexOptions.Multiline))
                            {
                                if (ids.Count >= 20) break;
                                if (!ids.Contains(m.Groups[1].Value)) ids.Add(m.Groups[1].Value);
                            }
                        }
                    }
                }
                return ids.ToArray();
            }
            catch { return new string[] { "DeepSeek 官方" }; }
        }

        private static ApiConfig LoadProviderConfig(string id)
        {
            ApiConfig cfg = new ApiConfig();
            cfg.provider = id;
            cfg.baseUrl = "https://api.deepseek.com/v1";
            cfg.models = "deepseek-chat,deepseek-reasoner";
            cfg.defaultModel = "deepseek-chat";
            try
            {
                string settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "settings.yaml");
                if (File.Exists(settings))
                {
                    string yaml = File.ReadAllText(settings);
                    bool isDeepSeek = id.Contains("DeepSeek") || id.Contains("deepseek");
                    if (isDeepSeek || yaml.Contains("llm-deepseek:"))
                    {
                        int di = yaml.IndexOf("llm-deepseek:");
                        if (di >= 0)
                        {
                            string block = yaml.Substring(di);
                            int end = block.IndexOf("\nllm-", 1);
                            if (end > 0) block = block.Substring(0, end);
                            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(block, @"^\s{4}-\s+id:\s*([^\s]+)", System.Text.RegularExpressions.RegexOptions.Multiline))
                            {
                                if (cfg.models.Length == 0) cfg.models = m.Groups[1].Value; else cfg.models += "," + m.Groups[1].Value;
                            }
                            if (cfg.models.Length == 0) { cfg.models = "deepseek-chat,deepseek-reasoner"; }
                            cfg.defaultModel = cfg.models.Split(',')[0].Trim();
                        }
                    }
                    else
                    {
                        string pattern = @"\n\s{4}" + System.Text.RegularExpressions.Regex.Escape(id) + @":([\s\S]*?)(?=\n\s{4}[a-zA-Z0-9_-]+:|\n\s{2}[a-zA-Z0-9_-]+:|\z)";
                        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(yaml, pattern, System.Text.RegularExpressions.RegexOptions.Multiline);
                        if (m.Success)
                        {
                            string block = m.Groups[1].Value;
                            System.Text.RegularExpressions.Match bm = System.Text.RegularExpressions.Regex.Match(block, @"baseURL:\s*([^\s]+)");
                            if (bm.Success) cfg.baseUrl = bm.Groups[1].Value.Trim();
                            System.Text.RegularExpressions.MatchCollection ms = System.Text.RegularExpressions.Regex.Matches(block, @"^\s{8}-\s+id:\s*([^\s]+)", System.Text.RegularExpressions.RegexOptions.Multiline);
                            if (ms.Count > 0)
                            {
                                cfg.models = "";
                                foreach (System.Text.RegularExpressions.Match mm in ms)
                                {
                                    if (cfg.models.Length == 0) cfg.models = mm.Groups[1].Value; else cfg.models += "," + mm.Groups[1].Value;
                                }
                                cfg.defaultModel = cfg.models.Split(',')[0].Trim();
                            }
                        }
                    }
                }

                string cred = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", ".credentials.yaml");
                if (File.Exists(cred))
                {
                    string keyName = ProviderKeyName(id);
                    foreach (string line in File.ReadAllLines(cred))
                    {
                        if (line.StartsWith(keyName + ":"))
                        {
                            cfg.apiKey = line.Substring(line.IndexOf(':') + 1).Trim();
                            break;
                        }
                    }
                }
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            return cfg;
        }

        private static string ProviderKeyName(string id)
        {
            if (id.Contains("DeepSeek") || id.Contains("deepseek")) return "DEEPSEEK_API_KEY";
            if (id.Contains("OpenAI") || id.Contains("openai")) return "OPENAI_API_KEY";
            if (id.Contains("通义") || id.Contains("dashscope")) return "DASHSCOPE_API_KEY";
            if (id.Contains("智谱") || id.Contains("zhipu")) return "ZHIPU_API_KEY";
            return id.ToUpperInvariant().Replace('-', '_') + "_API_KEY";
        }

        private static void DeleteProviderFile(string id)
        {
            try
            {
                string settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "settings.yaml");
                if (!File.Exists(settings)) return;
                string yaml = File.ReadAllText(settings);
                string pattern = @"\n\s{4}" + System.Text.RegularExpressions.Regex.Escape(id) + @":[\s\S]*?(?=\n\s{4}[a-zA-Z0-9_-]+:|\n\s{2}[a-zA-Z0-9_-]+:|\z)";
                yaml = System.Text.RegularExpressions.Regex.Replace(yaml, pattern, "");
                File.WriteAllText(settings, yaml);
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }

        private static void SaveProviderToOfficial(ApiConfig cfg)
        {
            try
            {
                string cred = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", ".credentials.yaml");
                string keyName = ProviderKeyName(cfg.provider);
                string keyLine = keyName + ": " + cfg.apiKey;
                string credText = File.Exists(cred) ? File.ReadAllText(cred) : "";
                if (credText.Contains(keyName + ":"))
                {
                    string[] lines = credText.Replace("\r\n", "\n").Split('\n');
                    for (int i = 0; i < lines.Length; i++) if (lines[i].StartsWith(keyName + ":")) lines[i] = keyLine;
                    File.WriteAllText(cred, string.Join(Environment.NewLine, lines));
                }
                else
                {
                    File.AppendAllText(cred, (credText.Length == 0 || credText.EndsWith("\n") ? "" : Environment.NewLine) + keyLine + Environment.NewLine);
                }
                // M-48（v5 阶段 4）：凭据文件 owner-only ACL
                PatchContract.ApplyOwnerOnlyAcl(cred);
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }
        private static void SyncApiConfigToOfficialDesktop(ApiConfig cfg)
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string dshDir = Path.Combine(home, ".dsh");
                if (!Directory.Exists(dshDir)) return;

                // 1. 同步 API Key 到 .credentials.yaml
                string credPath = Path.Combine(dshDir, ".credentials.yaml");
                string credText = File.Exists(credPath) ? File.ReadAllText(credPath) : "";
                string keyName = ProviderKeyName(cfg.provider);
                string keyLine = keyName + ": " + cfg.apiKey;
                if (credText.Contains(keyName + ":"))
                {
                    string[] credLines = credText.Replace("\r\n", "\n").Split('\n');
                    for (int i = 0; i < credLines.Length; i++)
                    {
                        if (credLines[i].StartsWith(keyName + ":"))
                        {
                            credLines[i] = keyLine;
                        }
                    }
                    File.WriteAllText(credPath, string.Join(Environment.NewLine, credLines));
                }
                else
                {
                    File.AppendAllText(credPath, (credText.EndsWith("\n") || credText.Length == 0 ? "" : Environment.NewLine) + keyLine + Environment.NewLine);
                }
                // M-48（v5 阶段 4）：凭据文件 owner-only ACL
                PatchContract.ApplyOwnerOnlyAcl(credPath);

                // 2. 同步默认模型到 settings.yaml 的 agent-default-model
                string settingsPath = Path.Combine(dshDir, "settings.yaml");
                if (File.Exists(settingsPath))
                {
                    string yaml = File.ReadAllText(settingsPath);
                    string providerId = cfg.provider == "DeepSeek 官方" ? "deepseek-official" : "dsh-hotplug-custom";
                    yaml = System.Text.RegularExpressions.Regex.Replace(
                        yaml,
                        @"(agent-default-model:\s*\r?\n\s+provider:\s*)\S+(\r?\n\s+model:\s*)\S+",
                        "$1" + providerId + "$2" + cfg.defaultModel);
                    File.WriteAllText(settingsPath, yaml);
                }
            }
            catch
            {
            }
        }

        // ---------- AI 组装接入 API ----------

        private static string BuildApiIntegrationScript()
        {
            ApiConfig cfg = LoadApiConfig();
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ApiConfig pageCfg = new ApiConfig();
            pageCfg.provider = cfg.provider;
            pageCfg.baseUrl = cfg.baseUrl;
            pageCfg.models = cfg.models;
            pageCfg.defaultModel = cfg.defaultModel;
            pageCfg.temperature = cfg.temperature;
            pageCfg.apiKey = ""; // 隐私：真实 API Key 绝不注入页面全局变量
            string configJson = ser.Serialize(pageCfg);
            string hasKeyJs = (!string.IsNullOrEmpty(cfg.apiKey)) ? "true" : "false";

            // 与原型同构：EXE 渠道复用页面的 beginTurn/processAiRaw/failAssistTurn/aiErrorText，
            // 保证按钮锁定、轮次徽标、欢迎卡移除、产物校验与话术与 standalone 完全一致。
            string js =
                "window.__apiConfig=" + configJson + ";var HAS_SHELL_KEY=" + hasKeyJs + ";" +
                "(function(){var cfg=window.__apiConfig||{};" +
                // 面板由页面统一渲染（模型/Key/端点直接填写）；外壳配置仅在留空时兜底填充，
                // 不再注入「外壳提供」UI（该功能后续再拓展）
                "var ensure=function(){" +
                "var mi=document.getElementById('aiModelInput');" +
                "var bi=document.getElementById('aiBaseUrlInput');" +
                "if(mi&&cfg&&cfg.defaultModel&&!mi.value){mi.value=cfg.defaultModel;}" +
                "if(bi&&cfg&&cfg.baseUrl&&!bi.value){bi.value=cfg.baseUrl;}" +
                "var note=document.getElementById('aiConnNote');" +
                "var ki2=document.getElementById('aiKeyInput');var kt=((ki2&&ki2.value&&ki2.value.trim())?true:HAS_SHELL_KEY);" +
                "if(note){var m0=(mi&&mi.value)||(cfg&&cfg.defaultModel)||'?';note.textContent='当前模型：'+m0+(kt?'（DSH API）':'（未配置 Key，点「⚙ 模型」填写）');}" +
                "};" +
                "var origRenderAi=renderAi;renderAi=function(){origRenderAi();ensure();};" +
                "var origRefresh=refreshConnNote;refreshConnNote=function(){var mi2=document.getElementById('aiModelInput');var ki3=document.getElementById('aiKeyInput');var kt2=((ki3&&ki3.value&&ki3.value.trim())?true:HAS_SHELL_KEY);var n2=document.getElementById('aiConnNote');if(n2){n2.textContent='当前模型：'+((mi2&&mi2.value)||(cfg&&cfg.defaultModel)||'?')+(kt2?'（DSH API）':'（未配置 Key，点「⚙ 模型」填写）');}};" +
                "if(document.readyState!=='loading'){ensure();}" +
                "var origCompose=compose;" +
                "compose=function(){" +
                "var input=document.getElementById('reqInput');if(!input)return;" +
                "var text=(input.value||'').trim();if(!text)return;" +
                "if(typeof aiRunning!=='undefined'&&aiRunning)return;" +
                "var personaSel=document.getElementById('aiPersona');var persona=personaSel?personaSel.value:'maid';" +
                "var mi3=document.getElementById('aiModelInput');var model=(mi3&&mi3.value&&mi3.value.trim())||(cfg&&cfg.defaultModel)||'deepseek-chat';" +
                "var ki3=document.getElementById('aiKeyInput');var key=(ki3&&ki3.value&&ki3.value.trim())||'';" +
                "var bi3=document.getElementById('aiBaseUrlInput');var bUrl=(bi3&&bi3.value&&bi3.value.trim())||(cfg&&cfg.baseUrl)||'';" +
                "var isFirst=(!aiSession||aiSession.messages.length===0||!aiSession.pack);" +
                "if(typeof beginTurn!=='function'){origCompose();return;}" +   // 页面组件未就绪：回退原路径
                "beginTurn(text,persona);" +
                "input.value='';input.style.height='auto';" +
                "if((!key&&!HAS_SHELL_KEY)||!bUrl){" +
                "if(typeof failAssistTurn==='function'){failAssistTurn('未配置 API Key：请点击「⚙ 模型」填写（仅本次会话内存，不持久化）',persona);}" +
                "return;}" +
                "var sys='';if(typeof buildAiSystem==='function'){sys=buildAiSystem(persona,isFirst?'assembly':'chat');}" +
                "var hist=[];if(aiSession&&aiSession.messages){hist=aiSession.messages.slice(0,-1);}" +
                "var pk=null;if(aiSession&&aiSession.pack){pk=aiSession.pack;}" +
                "if(window.chrome&&window.chrome.webview){" +
                "window.chrome.webview.postMessage('ai:'+JSON.stringify({text:text,model:model,persona:persona,system:sys,history:hist,pack:pk,apiKey:key,baseURL:bUrl}));" +
                "return;}" +
                "origCompose();" +
                "};" +
                // 结果/错误回调整合进聊天流：与原型同一套校验 + 人设化话术 + 状态恢复
                "window.__onAiResult=function(raw){" +
                "try{" +
                "var persona='maid';var ps=document.getElementById('aiPersona');if(ps)persona=ps.value;" +
                "var isFirst=(!aiSession||aiSession.messages.length===0||!aiSession.pack);" +
                "var inp='';if(aiMessages&&aiMessages.length){var last=aiMessages[aiMessages.length-1];if(last&&last.role==='user')inp=last.text||'';}" +
                "if(typeof processAiRaw==='function'){processAiRaw(String(raw),persona,isFirst,inp);}" +
                "else{var d=document.getElementById('aiTyping');if(d)d.remove();if(typeof toast==='function')toast('AI 结果解析失败：页面组件未就绪');}" +
                "}catch(e){if(typeof toast==='function')toast('AI 结果解析失败');}" +
                "};" +
                "window.__onAiError=function(msg){" +
                "var persona='maid';var ps=document.getElementById('aiPersona');if(ps)persona=ps.value;" +
                "if(typeof failAssistTurn==='function'){failAssistTurn((typeof aiErrorText==='function'?aiErrorText(persona,String(msg),false):String(msg)),persona);return;}" +
                "var d=document.getElementById('aiTyping');if(d)d.remove();" +
                "};" +
                "})();";
            return js;
        }

        private async Task HandleAiRequestAsync(string payload)
        {
            string errorMsg = null;
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> req = ser.Deserialize<Dictionary<string, object>>(payload);
                string text = req.ContainsKey("text") ? Convert.ToString(req["text"]) : "";
                string model = req.ContainsKey("model") ? Convert.ToString(req["model"]) : "";
                string persona = req.ContainsKey("persona") ? Convert.ToString(req["persona"]) : "maid";
                string system = req.ContainsKey("system") ? Convert.ToString(req["system"]) : "";
                // 页面直填优先（仅本次请求使用，不落盘）；未填时以外壳配置兜底
                string apiKeyOverride = req.ContainsKey("apiKey") ? Convert.ToString(req["apiKey"]) : null;
                string baseUrlOverride = req.ContainsKey("baseURL") ? Convert.ToString(req["baseURL"]) : null;
                ApiConfig cfg = LoadApiConfig();
                if (string.IsNullOrEmpty(model)) model = cfg.defaultModel;

                // 多轮上下文：由页面传入的历史（user/assistant）+ 当前产物 hotpack 清单
                List<Dictionary<string, string>> history = new List<Dictionary<string, string>>();
                object histObj = req.ContainsKey("history") ? req["history"] : null;
                object[] histArr = histObj as object[];
                if (histArr != null)
                {
                    foreach (object h in histArr)
                    {
                        Dictionary<string, object> hm = h as Dictionary<string, object>;
                        if (hm == null) continue;
                        string role = Convert.ToString(hm.ContainsKey("role") ? hm["role"] : "");
                        string content = Convert.ToString(hm.ContainsKey("content") ? hm["content"] : "");
                        if ((role != "user" && role != "assistant") || string.IsNullOrEmpty(content)) continue;
                        history.Add(new Dictionary<string, string> { { "role", role }, { "content", content } });
                    }
                }
                string packJson = null;
                if (req.ContainsKey("pack") && req["pack"] != null)
                {
                    try { packJson = ser.Serialize(req["pack"]); } catch { packJson = null; }
                }

                string result = await Task.Run(() => CallLlm(text, model, system, history, packJson, cfg, apiKeyOverride, baseUrlOverride));
                if (result == null)
                {
                    await ExecuteScriptSafe("window.__onAiError('API 调用失败，请检查 API 模型配置');");
                    return;
                }
                // 原样回传 LLM 文本：页面侧执行与 standalone 完全一致的权威校验/产物转换/人设话术
                await ExecuteScriptSafe("window.__onAiResult(" + JsString(result) + ");");
            }
            catch (Exception ex)
            {
                errorMsg = "AI 调用异常：" + ex.Message;
            }
            if (errorMsg != null)
            {
                await ExecuteScriptSafe("window.__onAiError(" + JsString(errorMsg) + ");");
            }
        }

        private async Task HandleAiTestAsync(string payload)
        {
            string model = "";
            string apiKeyOverride = null;
            string baseUrlOverride = null;
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> req = ser.Deserialize<Dictionary<string, object>>(payload);
                if (req != null)
                {
                    if (req.ContainsKey("model")) model = Convert.ToString(req["model"]);
                    if (req.ContainsKey("apiKey")) apiKeyOverride = Convert.ToString(req["apiKey"]);
                    if (req.ContainsKey("baseURL")) baseUrlOverride = Convert.ToString(req["baseURL"]);
                }
            }
            catch { /* 参数缺失时用外壳默认 */ }
            ApiConfig cfg = LoadApiConfig();
            if (string.IsNullOrEmpty(model)) model = cfg.defaultModel;
            string baseUrl = string.IsNullOrEmpty(baseUrlOverride) ? cfg.baseUrl : baseUrlOverride;
            string apiKey = string.IsNullOrEmpty(apiKeyOverride) ? cfg.apiKey : apiKeyOverride;
            string error;
            bool ok = false;
            if (string.IsNullOrEmpty(baseUrl)) { error = "未配置 Base URL"; }
            else if (string.IsNullOrEmpty(apiKey)) { error = "未配置 API Key（在「⚙ 模型」面板填写，仅本次会话内存）"; }
            else if (!baseUrl.StartsWith("https://")) { error = "Base URL 必须以 https:// 开头（TLS 铁律）"; }
            else { ok = TestApiConnection(cfg, model, apiKeyOverride, baseUrlOverride, out error); }
            await ExecuteScriptSafe("window.__aiTestResult(" + (ok ? "true" : "false") + "," + JsString(error) + ");");
        }

        private async Task ExecuteScriptSafe(string script)
        {
            try
            {
                if (webView != null && webView.CoreWebView2 != null)
                    await webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch { /* 页面可能已关闭：尽力而为 */ }
        }

        // ---------- Skill / MCP 真实文件管理 ----------

        private static string SkillsDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "skills");
        }

        private static string McpFilePath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "mcp.json");
        }

        // 启动时自动把 dsh-memory-hub 安装/注册到本地 DeepSeek Harness。
        // 使用官方 dsh plugin --profile web add <tgz> 安装（自动写 package.json dependencies 与 dsh.profile.bundles），
        // 不再手写 cordis.patch.yml 插入块，避免与插件自带 bundle patch 重复。
        private static void InstallPluginsToHarness()
        {
            try
            {
                // 三插件全部内置：优先从 EXE 资源释放安装（随应用版本一起更新），
                // 网络仅作为资源缺失时的兜底；插件仓库仍然保留用于手动“检查更新”。
                string installedMemory = GetInstalledMemoryHubVersion();
                if (NormalizeVersion(installedMemory) != MEMORY_HUB_VERSION)
                {
                    string tgz = ExtractEmbeddedTgz("DSHHotplugHub.Resources.dsh_memory_hub.tgz", "dsh-memory-hub-" + MEMORY_HUB_VERSION + ".tgz");
                    if (tgz == null)
                    {
                        Dictionary<string, string> info = GetMemoryHubReleaseInfo();
                        tgz = info != null && info.ContainsKey("url")
                            ? info["url"]
                            : "https://github.com/ARFCON/dsh-hotplug-hub/releases/download/v" + APP_VERSION + "/dsh-memory-hub-" + MEMORY_HUB_VERSION + ".tgz";
                    }
                    string output = InstallPluginPackage(tgz);
                    if (output != null && (output.Contains("ERR_PNPM") || output.Contains("Error:") || output.Contains("error:")))
                    {
                        try
                        {
                            string logDir = Path.Combine(
                                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                "DSH-Hotplug-Hub");
                            Directory.CreateDirectory(logDir);
                            File.AppendAllText(Path.Combine(logDir, "plugin-install.log"),
                                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " memory-hub install failed: " + output + Environment.NewLine);
                        }
                        catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
                    }
                }
                InstallEmbeddedSkillMcp();
                EnsureDshHub();
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }

        private static Dictionary<string, string> GetMemoryHubReleaseInfo()
        {
            Dictionary<string, object> root = GitHubGetJsonCached("https://api.github.com/repos/" + PROJECT_REPO + "/releases/tags/v" + APP_VERSION, 10);
            if (root == null || !root.ContainsKey("assets")) return null;
            object[] assets = root["assets"] as object[];
            if (assets == null) return null;
            foreach (object assetObj in assets)
            {
                Dictionary<string, object> asset = assetObj as Dictionary<string, object>;
                if (asset == null) continue;
                string name = Convert.ToString(asset.ContainsKey("name") ? asset["name"] : "");
                if (!name.StartsWith("dsh-memory-hub-") || !name.EndsWith(".tgz")) continue;
                if (!asset.ContainsKey("browser_download_url")) continue;
                Dictionary<string, string> info = new Dictionary<string, string>();
                info["url"] = Convert.ToString(asset["browser_download_url"]);
                string ver = name.Substring("dsh-memory-hub-".Length);
                if (ver.EndsWith(".tgz")) ver = ver.Substring(0, ver.Length - ".tgz".Length);
                info["latest"] = ver;
                return info;
            }
            return null;
        }

        // 内置 dseam-skillmcp（原开源 dsh-skill-mcp-panel 改名适配，MIT）：从 EXE 资源释放 tgz 并安装到 profile。
        private static string InstallEmbeddedSkillMcp()
        {
            try
            {
                string installed = GetInstalledPanelVersion();
                if (NormalizeVersion(installed) == PANEL_VERSION)
                {
                    return "内置 Skill/MCP 管理器已是最新 v" + PANEL_VERSION;
                }
                string tgz = ExtractEmbeddedTgz("DSHHotplugHub.Resources.dseam_skillmcp.tgz", "dseam-skillmcp-" + PANEL_VERSION + ".tgz");
                if (tgz == null)
                {
                    return "未找到内置 dseam-skillmcp 安装包，请重新下载完整版";
                }
                string output = InstallPluginPackage(tgz);
                if (output == null)
                {
                    return "未找到 dsh 命令，请先安装官方 DSH Desktop 或把 dsh 加入 PATH";
                }
                if (output.Contains("ERR_PNPM") || output.Contains("Error:") || output.Contains("error:"))
                {
                    return "安装失败：" + output.Substring(0, Math.Min(output.Length, 160));
                }
                return "内置 Skill/MCP 管理器 v" + PANEL_VERSION + " 已提交安装，重启 DSH 后生效";
            }
            catch (Exception ex)
            {
                return "安装异常：" + ex.Message;
            }
        }

        // 从 EXE 内嵌资源释放 tgz 到临时目录，返回文件路径；资源不存在返回 null。
        private static string ExtractEmbeddedTgz(string resourceName, string fileName)
        {
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
                {
                    if (stream == null) return null;
                    string dir = Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-embedded");
                    Directory.CreateDirectory(dir);
                    string tgz = Path.Combine(dir, fileName);
                    using (FileStream fs = new FileStream(tgz, FileMode.Create, FileAccess.Write))
                    {
                        stream.CopyTo(fs);
                    }
                    return tgz;
                }
            }
            catch { /* 有意吞掉：释放失败返回 null，调用方回退到网络下载 */ }
            return null;
        }

        private static string GetInstalledMemoryHubVersion()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                List<string> candidates = new List<string>();
                string profilesDir = Path.Combine(home, ".dsh", "profiles");
                if (Directory.Exists(profilesDir))
                {
                    foreach (string profileDir in Directory.GetDirectories(profilesDir))
                    {
                        candidates.Add(Path.Combine(profileDir, "node_modules", "dsh-memory-hub", "package.json"));
                    }
                }
                candidates.Add(Path.Combine(home, ".dsh", "plugin-src", "dsh-memory-hub", "package.json"));
                foreach (string pkgFile in candidates)
                {
                    if (!File.Exists(pkgFile)) continue;
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(pkgFile));
                    if (root != null && root.ContainsKey("version"))
                    {
                        string v = Convert.ToString(root["version"]);
                        if (!string.IsNullOrEmpty(v)) return v;
                    }
                }
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            return null;
        }
        // 内置 dsh-hub：随应用版本一起更新（EXE 资源），插件仓库 ARFCON/dsh-hub-DSH 保留用于手动“检查更新”。
        private static void EnsureDshHub()
        {
            try
            {
                string installed = GetInstalledDshHubVersion();
                if (NormalizeVersion(installed) == DSH_HUB_VERSION) return;
                string tgz = ExtractEmbeddedTgz("DSHHotplugHub.Resources.dsh_hub.tgz", "dsh-hub-" + DSH_HUB_VERSION + ".tgz");
                if (tgz == null)
                {
                    string latest = GetLatestDshHubVersion();
                    // 离线/接口失败（latest 为空）时跳过：旧逻辑此时会每次启动都重新下载 main 分支 tarball
                    if (string.IsNullOrEmpty(latest)) return;
                    if (NormalizeVersion(installed) == NormalizeVersion(latest)) return;
                    InstallPluginPackage("https://codeload.github.com/ARFCON/dsh-hub-DSH/tar.gz/refs/heads/main");
                    return;
                }
                string output = InstallPluginPackage(tgz);
                if (output != null && (output.Contains("ERR_PNPM") || output.Contains("Error:") || output.Contains("error:")))
                {
                    try
                    {
                        string logDir = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                            "DSH-Hotplug-Hub");
                        Directory.CreateDirectory(logDir);
                        File.AppendAllText(Path.Combine(logDir, "plugin-install.log"),
                            DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " dsh-hub install failed: " + output + Environment.NewLine);
                    }
                    catch { /* 有意吞掉：内置 dsh-hub 安装失败不阻塞启动，插件管理页可手动更新 */ }
                }
            }
            catch { /* 有意吞掉：内置 dsh-hub 安装失败不阻塞启动，插件管理页可手动更新 */ }
        }

        private static string GetLatestDshHubVersion()
        {
            try
            {
                Dictionary<string, object> root = GitHubGetJsonCached("https://api.github.com/repos/ARFCON/dsh-hub-DSH/contents/package.json", 10);
                if (root != null && root.ContainsKey("content"))
                {
                    string base64 = Convert.ToString(root["content"]).Replace("\n", "").Replace("\r", "");
                    byte[] data = Convert.FromBase64String(base64);
                    Dictionary<string, object> pkg = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(data));
                    if (pkg != null && pkg.ContainsKey("version")) return Convert.ToString(pkg["version"]);
                }
            }
            catch { /* 有意吞掉：离线时不做 dsh-hub 更新 */ }
            return null;
        }

        private static string GetInstalledDshHubVersion()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                List<string> candidates = new List<string>();
                string profilesDir = Path.Combine(home, ".dsh", "profiles");
                if (Directory.Exists(profilesDir))
                {
                    foreach (string profileDir in Directory.GetDirectories(profilesDir))
                    {
                        candidates.Add(Path.Combine(profileDir, "node_modules", "dsh-hub", "package.json"));
                    }
                }
                candidates.Add(Path.Combine(home, ".dsh", "plugin-src", "dsh-hub", "package.json"));
                foreach (string pkgFile in candidates)
                {
                    if (!File.Exists(pkgFile)) continue;
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(pkgFile));
                    if (root != null && root.ContainsKey("version")) return Convert.ToString(root["version"]);
                }
            }
            catch { /* 有意吞掉：读不到版本则下次重试 */ }
            return null;
        }

        private static string GetProfileDir()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string dir = Path.Combine(home, ".dsh", "profiles", "web");
            Directory.CreateDirectory(dir);
            return dir;
        }

        private static List<string> GetBundleList(Dictionary<string, object> root)
        {
            List<string> list = new List<string>();
            if (root == null || !root.ContainsKey("dsh")) return list;
            Dictionary<string, object> dsh = root["dsh"] as Dictionary<string, object>;
            if (dsh == null || !dsh.ContainsKey("profile")) return list;
            Dictionary<string, object> profile = dsh["profile"] as Dictionary<string, object>;
            if (profile == null || !profile.ContainsKey("bundles")) return list;
            object[] arr = profile["bundles"] as object[];
            if (arr != null)
            {
                foreach (object obj in arr)
                {
                    string bundle = Convert.ToString(obj);
                    if (!string.IsNullOrEmpty(bundle) && !list.Contains(bundle)) list.Add(bundle);
                }
            }
            return list;
        }

        // 一次读取 node_modules/<name>/package.json，版本与 bundle 判断共用，避免同一文件重复读
        private static Dictionary<string, object> ReadInstalledPackageJson(string name)
        {
            try
            {
                if (string.IsNullOrEmpty(name)) return null;
                string pkgFile = Path.Combine(Path.Combine(GetProfileDir(), "node_modules"), name.Replace("/", Path.DirectorySeparatorChar.ToString()), "package.json");
                if (!File.Exists(pkgFile)) return null;
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(pkgFile));
            }
            catch { /* 有意吞掉：读不到按未安装处理 */ }
            return null;
        }

        private static bool HasBundlePatch(Dictionary<string, object> pkgRoot)
        {
            Dictionary<string, object> dsh = pkgRoot != null && pkgRoot.ContainsKey("dsh") ? pkgRoot["dsh"] as Dictionary<string, object> : null;
            Dictionary<string, object> bundle = dsh != null && dsh.ContainsKey("bundle") ? dsh["bundle"] as Dictionary<string, object> : null;
            return bundle != null && bundle.ContainsKey("patch");
        }

        private static string GetKnownLatestVersion(string name)
        {
            if (name == "dsh-hub") return GetLatestDshHubVersion();
            if (name == "dsh-memory-hub")
            {
                Dictionary<string, string> info = GetMemoryHubReleaseInfo();
                if (info != null && info.ContainsKey("latest")) return info["latest"];
                return "0.8.0-pre";
            }
            // dseam-skillmcp 内置于 EXE，不做版本比对/更新提示
            if (name == "dseam-skillmcp") return null;
            return null;
        }

        private static string GetKnownRepo(string name)
        {
            if (name == "dsh-hub") return "https://github.com/ARFCON/dsh-hub-DSH";
            if (name == "dsh-memory-hub") return "https://github.com/ARFCON/dsh-hotplug-hub";
            // dseam-skillmcp 内置于 EXE，不显示仓库按钮
            return null;
        }

        // ---- 插件启停（与 DSH Desktop 设置页「插件」栏同一套 cordis.patch.yml 手术） ----
        // 官方壳并不是通过增删 dsh.profile.bundles 来启停插件，而是在 profile 的
        // cordis.patch.yml 顶层写/删 - id: <loaderId> + disabled: true 覆盖条目。
        // 本区域完整移植 scripts/plugin-manager-patch.js 的 togglePluginInPatch 语义，
        // 保证与官方设置页双向兼容（官方页能识别我们写的条目，我们也能识别官方写的）。

        private static string ProfilePatchPath()
        {
            return Path.Combine(GetProfileDir(), "cordis.patch.yml");
        }

        // loader id 白名单：与 PACK_ID_RE 对齐（v5 阶段 4，PatchContract.cs；
        // 曾 `^[A-Za-z0-9_.-]+$`——允许前导 . _ - 且无 64 上限，一次性破坏性收紧）
        private static bool ValidPluginLoaderId(string id)
        {
            return PatchContract.IsValidLoaderId(id);
        }

        private static string RegexEscapeForPatch(string s)
        {
            return System.Text.RegularExpressions.Regex.Escape(s ?? "");
        }

        private static string YamlSingleQuote(string s)
        {
            return "'" + (s ?? "").Replace("'", "''") + "'";
        }

        // 从安装包自己的 cordis.patch.yml（bundle patch）读取 loader id：
        // dshmarket→dsh-market、dsh-memory-hub→memory-hub、dsh-ui-guard→ui-guard、
        // @deepseek-ai/dsh-bridge-browser→bridge-browser、@liustack/modlens→modlens 等。
        private static string GetBundlePatchLoaderId(string name)
        {
            try
            {
                if (string.IsNullOrEmpty(name)) return null;
                string dir = Path.Combine(Path.Combine(GetProfileDir(), "node_modules"), name.Replace("/", Path.DirectorySeparatorChar.ToString()));
                string patch = Path.Combine(dir, "cordis.patch.yml");
                if (!File.Exists(patch)) return null;
                return GetFirstInsertIdFromPatch(File.ReadAllText(patch));
            }
            catch { return null; }
        }

        private static string GetFirstInsertIdFromPatch(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(text, @"- insert:\s*\r?\n[ \t]+- id:\s*([A-Za-z0-9_.-]+)");
            if (m.Success && m.Groups.Count > 1) return m.Groups[1].Value;
            return null;
        }

        // 非 bundle 插件（如 dsh-hub）的 loader id 登记在 profile patch 的 insert 块里，按包名反查。
        private static string GetProfilePatchInsertId(string name)
        {
            try
            {
                string patchFile = ProfilePatchPath();
                if (!File.Exists(patchFile) || string.IsNullOrEmpty(name)) return null;
                string text = File.ReadAllText(patchFile).Replace("\r\n", "\n");
                string[] lines = text.Split('\n');
                for (int k = 0; k + 1 < lines.Length; k++)
                {
                    string t = lines[k].Trim();
                    if (t != "- insert:") continue;
                    string blockId = null;
                    string blockName = null;
                    for (int n = k + 1; n < lines.Length; n++)
                    {
                        string lt = lines[n].Trim();
                        if (lt.StartsWith("- id:")) blockId = lt.Substring(5).Trim().Trim('\'', '"');
                        else if (lt.StartsWith("name:")) blockName = lt.Substring(5).Trim().Trim('\'', '"');
                        else if (lt.StartsWith("- ")) break;
                        if (blockId != null && blockName != null) break;
                    }
                    if (blockId != null && blockName == name) return blockId;
                }
            }
            catch { /* 有意吞掉：反查不到时走净化名兜底 */ }
            return null;
        }

        private static string SanitizePluginInsertId(string name)
        {
            if (string.IsNullOrEmpty(name)) return "plugin";
            string id = name.Contains("/") ? name.Substring(name.IndexOf('/') + 1) : name;
            id = System.Text.RegularExpressions.Regex.Replace(id, "[^A-Za-z0-9_-]+", "-").Trim('-');
            if (id.Length == 0) id = "plugin-" + Environment.TickCount.ToString();
            if (id.Length > 64) id = id.Substring(0, 64);
            return id;
        }

        private static string GetLoaderIdForPackage(string name)
        {
            string loaderId = GetBundlePatchLoaderId(name);
            if (string.IsNullOrEmpty(loaderId)) loaderId = GetProfilePatchInsertId(name);
            if (string.IsNullOrEmpty(loaderId)) loaderId = SanitizePluginInsertId(name);
            return loaderId;
        }

        // 顶层用户层条目是否带 disabled: true（官方插件管理页与我们的启停共用这一判定）
        private static bool HasUserDisabledEntry(string id)
        {
            try
            {
                if (!ValidPluginLoaderId(id)) return false;
                string patchFile = ProfilePatchPath();
                if (!File.Exists(patchFile)) return false;
                string text = File.ReadAllText(patchFile).Replace("\r\n", "\n");
                string pattern = @"(?:^|\n)([ \t]{0,2})- id:\s*" + RegexEscapeForPatch(id) + @"(?![ \t]*[A-Za-z0-9_.-])[^\n]*\n([\s\S]*?)(?=(?:\n[ \t]{0,2}- id:)|(?:\n[ \t]{0,2}- insert:)|(?:\n#)|\s*$)";
                foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(text, pattern))
                {
                    if (System.Text.RegularExpressions.Regex.IsMatch(m.Value, @"(?:^|\n)[ \t]{0,2}disabled\s*:\s*true\b")) return true;
                }
                return false;
            }
            catch { return false; }
        }

        // 把 profile cordis.patch.yml 的某插件启停条目与 DSH Desktop 保持一致：
        // 关闭 = 从 insert 块移除内层条目 + 顶层写 disabled: true；启用 = 移除 disabled 行。
        private static string TogglePluginInPatch(string text, string id, bool enabled, string name)
        {
            if (text == null) text = "";
            if (!ValidPluginLoaderId(id)) throw new ArgumentException("id 含非法字符（仅允许字母/数字开头，1-64 位，允许 . _ -）: " + id);
            string outText = text;
            string pkgName = string.IsNullOrEmpty(name) ? id : name;
            const string desktopOwner = "desktop";
            // 旧 `# 插件管理（设置页「插件」栏）：关闭 <id>` 标记块（迁移期识别，写时清理为 ## desktop:<id>）
            string legacyMarkerPattern = @"(?:^|(?<=\n))# [^\n]*关闭 " + RegexEscapeForPatch(id) + @"[^\n]*(?:\n|$)";
            // 顶层/块内无标记 disabled 条目（官方壳语义，双向兼容——保留识别）
            string topEntryPattern = @"(?:^|\n)([ \t]{0,2})- id:\s*" + RegexEscapeForPatch(id) + @"(?![ \t]*[A-Za-z0-9_.-])[^\n]*\n([\s\S]*?)(?=(?:\n[ \t]{0,2}- id:)|(?:\n[ \t]{0,2}- insert:)|(?:\n#)|\s*$)";

            if (!enabled)
            {
                // 1) 从 insert 块移除内层条目（保持既有语义）
                string innerPattern = @"(?:^|\n)[ \t]+- id:\s*" + RegexEscapeForPatch(id) + @"(?![ \t]*[A-Za-z0-9_.-])[^\n]*\n([\s\S]*?)(?=(?:\n[ \t]+- id:)|(?:\n[ \t]{0,2}- id:)|(?:\n[ \t]{0,2}- insert:)|\s*$)";
                outText = System.Text.RegularExpressions.Regex.Replace(outText, innerPattern, delegate(System.Text.RegularExpressions.Match m) { return m.Value.StartsWith("\n") ? "\n" : ""; });
                string emptyInsert = @"(?:^|\n)- insert:\s*\n(?![ \t]+-)";
                outText = System.Text.RegularExpressions.Regex.Replace(outText, emptyInsert, delegate(System.Text.RegularExpressions.Match m) { return m.Value.StartsWith("\n") ? "\n" : ""; });

                // 2) 已有顶层/块内无标记 disabled 条目 → 保证 disabled:true（官方语义，保留识别）
                if (System.Text.RegularExpressions.Regex.IsMatch(outText, topEntryPattern))
                {
                    outText = System.Text.RegularExpressions.Regex.Replace(outText, topEntryPattern, delegate(System.Text.RegularExpressions.Match m)
                    {
                        string block = m.Value;
                        if (System.Text.RegularExpressions.Regex.IsMatch(block, @"(?:^|\n)[ \t]{0,2}disabled\s*:")) return block;
                        System.Text.RegularExpressions.Match nameMatch = System.Text.RegularExpressions.Regex.Match(block, @"(?:\n[ \t]{0,2}name\s*:[^\n]*)");
                        if (nameMatch.Success) return block.Replace(nameMatch.Value, nameMatch.Value + "\n  disabled: true");
                        return block.TrimEnd('\n') + "\n  disabled: true\n";
                    });
                }
                else
                {
                    // 3) 迁移：清理旧 `# 插件管理…` 标记块（下次写时清理为契约块）
                    outText = System.Text.RegularExpressions.Regex.Replace(outText, legacyMarkerPattern, "");
                    // 4) 分节保留合并：`## desktop:<id>` 块替换/追加；其余块/注释原样保留
                    string blockYaml = "- id: " + id + "\n  name: " + YamlSingleQuote(pkgName) + "\n  disabled: true";
                    outText = PatchContract.MergePatchSection(outText, desktopOwner, id, blockYaml);
                }
                return outText;
            }

            // 启用：移除 `## desktop:<id>` 块 + 旧标记块 + 无标记 disabled 条目（其余原样保留）
            outText = PatchContract.MergePatchSection(outText, desktopOwner, id, "");
            outText = System.Text.RegularExpressions.Regex.Replace(outText, legacyMarkerPattern, "");
            outText = System.Text.RegularExpressions.Regex.Replace(outText, topEntryPattern, delegate(System.Text.RegularExpressions.Match m)
            {
                string withoutDisabled = System.Text.RegularExpressions.Regex.Replace(m.Value, @"\n[ \t]{0,2}disabled\s*:\s*(?:true|false)[^\n]*", "");
                if (System.Text.RegularExpressions.Regex.IsMatch(withoutDisabled, @"(?:^|\n)[ \t]{0,2}config\s*:")) return withoutDisabled;
                return m.Value.StartsWith("\n") ? "\n" : "";
            });
            return outText;
        }
        private static string CheckPluginUpdates()
        {
            ClearGitHubCache(); // 用户显式点击“检查更新”时强制刷新远端版本
            return GetPluginsJson();
        }

        /// <summary>插件行数据的唯一构造入口（GetPluginsJson 序列化 / UpdateAllPlugins 筛选共用）。</summary>
        internal static List<Dictionary<string, object>> GetPluginRows()
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            try
            {
                string pkgFile = Path.Combine(GetProfileDir(), "package.json");
                if (!File.Exists(pkgFile)) return list;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(pkgFile));
                if (root == null) return list;
                Dictionary<string, object> deps = null;
                if (root.ContainsKey("dependencies")) deps = root["dependencies"] as Dictionary<string, object>;
                if (deps == null) return list;
                foreach (string name in deps.Keys)
                {
                    Dictionary<string, object> item = new Dictionary<string, object>();
                    item["id"] = name;
                    item["name"] = name;
                    string spec = Convert.ToString(deps[name]);
                    item["spec"] = spec;
                    Dictionary<string, object> pkgRoot = ReadInstalledPackageJson(name);
                    string version = pkgRoot != null && pkgRoot.ContainsKey("version") ? Convert.ToString(pkgRoot["version"]) : null;
                    string latest = GetKnownLatestVersion(name);
                    item["version"] = version;
                    item["enabled"] = !HasUserDisabledEntry(GetLoaderIdForPackage(name));
                    item["latest"] = latest;
                    item["repo"] = GetKnownRepo(name);
                    string versionN = NormalizeVersion(version);
                    string latestN = NormalizeVersion(latest);
                    bool hasUpdate = false;
                    if (!string.IsNullOrEmpty(versionN) && !string.IsNullOrEmpty(latestN))
                    {
                        hasUpdate = versionN != latestN;
                    }
                    else if (!string.IsNullOrEmpty(versionN) && !string.IsNullOrEmpty(spec))
                    {
                        // 第三方插件：用 profile package.json 里的 semver range 与已装版本比对
                        hasUpdate = !SpecSatisfiedBy(spec, versionN);
                    }
                    item["hasUpdate"] = hasUpdate;
                    list.Add(item);
                }
            }
            catch { /* 读取失败返回已收集部分（通常为空） */ }
            return list;
        }

        private static string GetPluginsJson()
        {
            return new JavaScriptSerializer().Serialize(GetPluginRows());
        }

        /// <summary>一键更新：顺序更新全部 hasUpdate 插件（避免并发安装写坏 profile），返回汇总文案。</summary>
        private static string UpdateAllPlugins()
        {
            List<Dictionary<string, object>> rows = GetPluginRows();
            int total = 0, done = 0;
            List<string> failed = new List<string>();
            foreach (Dictionary<string, object> row in rows)
            {
                if (!(row.ContainsKey("hasUpdate") && row["hasUpdate"] is bool && (bool)row["hasUpdate"])) continue;
                string id = Convert.ToString(row["id"]);
                total++;
                string result = UpdatePlugin(id) ?? "";
                if (result.Contains("失败") || result.Contains("异常") || result.Contains("未获取到"))
                {
                    failed.Add(id);
                }
                else
                {
                    done++;
                }
            }
            if (total == 0) return "没有需要更新的插件";
            if (failed.Count == 0) return done + " 个插件更新已提交，重启 DSH 后生效";
            return done + " 个更新已提交，" + failed.Count + " 个失败：" + string.Join("、", failed.ToArray());
        }

        // 宽松的 semver range 判断（^ ~ >= 精确值 */latest）；URL/git/file 形式的 spec 无法判断，一律视为满足以免误报
        private static bool SpecSatisfiedBy(string spec, string version)
        {
            string s = (spec ?? "").Trim();
            if (s.Length == 0 || s == "*" || s == "x" || s == "latest") return true;
            if (s.Contains("/") || s.Contains(":")) return true; // URL / git / file: 形式
            bool caret = s.StartsWith("^");
            bool tilde = s.StartsWith("~");
            bool gte = s.StartsWith(">=");
            string body = NormalizeVersion(s.TrimStart('^', '~', '>', '='));
            int[] specParts = ParseVersionParts(body);
            int[] verParts = ParseVersionParts(NormalizeVersion(version));
            if (specParts == null || verParts == null) return true;
            int cmp = CompareVersionParts(verParts, specParts);
            if (caret)
            {
                if (specParts[0] > 0) return verParts[0] == specParts[0] && cmp >= 0;
                return verParts[0] == 0 && verParts[1] == specParts[1] && cmp >= 0; // ^0.x.y 锁定 minor
            }
            if (tilde) return verParts[0] == specParts[0] && verParts[1] == specParts[1] && cmp >= 0;
            if (gte) return cmp >= 0;
            return cmp == 0;
        }

        private static int[] ParseVersionParts(string v)
        {
            if (string.IsNullOrEmpty(v)) return null;
            string core = v.Split('-', '+')[0];
            string[] raw = core.Split('.');
            if (raw.Length == 0) return null;
            int[] parts = new int[3];
            int seen = 0;
            for (int i = 0; i < raw.Length && i < 3; i++)
            {
                int n;
                if (!int.TryParse(raw[i], out n)) return null;
                parts[i] = n;
                seen++;
            }
            return seen > 0 ? parts : null;
        }

        private static int CompareVersionParts(int[] a, int[] b)
        {
            for (int i = 0; i < 3; i++)
            {
                if (a[i] != b[i]) return a[i] > b[i] ? 1 : -1;
            }
            return 0;
        }

        private static string SetPluginEnabled(string id, bool enabled)
        {
            FileStream lockHandle = null;
            try
            {
                if (string.IsNullOrEmpty(id)) return "插件 ID 为空";
                string loaderId = GetLoaderIdForPackage(id);
                if (!ValidPluginLoaderId(loaderId)) return "无法解析插件 loader id：" + id;
                string patchFile = ProfilePatchPath();
                // v5 阶段 4：四写者锁（<profile>/.dsh-patch.lock，CONTRACT.md §5）——
                // 与 launcher/hotplug/dseam 同一把锁，读-改-写全程互斥
                lockHandle = PatchContract.AcquirePatchLock(Path.GetDirectoryName(patchFile));
                string text = File.Exists(patchFile) ? File.ReadAllText(patchFile).Replace("\r\n", "\n") : "";
                if (text.Trim().Length == 0) text = "";
                string patched = TogglePluginInPatch(text, loaderId, enabled, id);
                if (patched != text)
                {
                    // 原子写：随机临时名 + rename（与 shared fs/atomic 同语义；
                    // net48 无 File.Move 覆盖重载 → 先删目标再 Move）
                    string temp = Path.Combine(Path.GetDirectoryName(patchFile),
                        ".cordis.patch.yml." + Process.GetCurrentProcess().Id + "." + Guid.NewGuid().ToString("N").Substring(0, 8) + ".tmp");
                    File.WriteAllText(temp, patched, new UTF8Encoding(false));
                    if (File.Exists(patchFile)) File.Delete(patchFile);
                    File.Move(temp, patchFile);
                }
                return (enabled ? "已启用插件 " : "已停用插件 ") + id + "（重启 DSH 后生效）";
            }
            catch (Exception ex)
            {
                return "切换失败：" + ex.Message;
            }
            finally
            {
                if (lockHandle != null)
                    PatchContract.ReleasePatchLock(lockHandle, Path.GetDirectoryName(ProfilePatchPath()));
            }
        }

        private static string RunDshPluginCli(string arguments)
        {
            string[] cmd = FindDshCommand();
            if (cmd == null) return null;
            return RunCliLong(cmd[0], cmd[1] + " plugin --profile web " + arguments);
        }

        // 把 dsh CLI 输出转成给用户看的结果文案；null（找不到 dsh）与常见错误关键字单独提示
        private static string FormatCliResult(string output, string successMessage)
        {
            if (output == null) return "未找到 dsh 命令，请先安装官方 DSH Desktop 或把 dsh 加入 PATH";
            if (output.Contains("ERR_PNPM") || output.Contains("Error:") || output.Contains("error:"))
            {
                string brief = output.Substring(0, Math.Min(output.Length, 160)).Replace("\r", " ").Replace("\n", " ");
                return "操作失败：" + brief;
            }
            return successMessage;
        }

        // 插件源/ID 白名单：字母数字与 npm 包名、semver range、GitHub URL 常见字符。
        // 引号/&/|/^/%/反引号等 shell 元字符一律拒绝，防止经 cmd.exe 的回退路径被拼接注入
        private static bool IsSafePluginSpec(string spec)
        {
            if (string.IsNullOrEmpty(spec)) return false;
            foreach (char c in spec)
            {
                if (!(char.IsLetterOrDigit(c) || "/:@._~#+,=-".IndexOf(c) >= 0)) return false;
            }
            return true;
        }

        private static string AddPlugin(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(payload);
                string name = data != null && data.ContainsKey("name") ? Convert.ToString(data["name"]) : "";
                string source = data != null && data.ContainsKey("source") ? Convert.ToString(data["source"]) : "";
                string spec = !string.IsNullOrEmpty(source) ? source : name;
                if (string.IsNullOrEmpty(spec)) return "插件名或来源不能为空";
                if (!IsSafePluginSpec(spec)) return "插件来源包含不支持的字符，已拒绝执行";
                string output = RunDshPluginCli("add \"" + spec + "\"");
                return FormatCliResult(output, "插件 " + spec + " 已提交安装，重启 DSH 后生效");
            }
            catch (Exception ex)
            {
                return "安装异常：" + ex.Message;
            }
        }

        private static string DeletePlugin(string id)
        {
            if (string.IsNullOrEmpty(id)) return "插件 ID 为空";
            if (!IsSafePluginSpec(id)) return "插件 ID 非法，已拒绝执行";
            return FormatCliResult(RunDshPluginCli("remove \"" + id + "\""), "插件 " + id + " 已卸载");
        }

        private static string UpdatePlugin(string id)
        {
            if (id == "dsh-hub")
            {
                return FormatCliResult(InstallPluginPackage("https://codeload.github.com/ARFCON/dsh-hub-DSH/tar.gz/refs/heads/main"), "dsh-hub 更新已提交，重启 DSH 后生效");
            }
            if (id == "dsh-memory-hub")
            {
                Dictionary<string, string> info = GetMemoryHubReleaseInfo();
                if (info != null && info.ContainsKey("url"))
                {
                    return FormatCliResult(InstallPluginPackage(info["url"]), "dsh-memory-hub 更新已提交，重启 DSH 后生效");
                }
                return "未获取到 dsh-memory-hub 发布信息，请检查网络";
            }
            if (id == "dseam-skillmcp")
            {
                InstallEmbeddedSkillMcp();
                return "内置 Skill/MCP 管理器已重新安装";
            }
            if (string.IsNullOrEmpty(id)) return "插件 ID 为空";
            if (!IsSafePluginSpec(id)) return "插件 ID 非法，已拒绝执行";
            return FormatCliResult(RunDshPluginCli("update \"" + id + "\""), "插件 " + id + " 更新已提交，重启 DSH 后生效");
        }

        private static string GetMemoryJson()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string hubDir = Path.Combine(home, ".dsh", "memory-hub");
                List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
                if (!Directory.Exists(hubDir)) return "[]";
                foreach (string packDir in Directory.GetDirectories(hubDir))
                {
                    string packFile = Path.Combine(packDir, "pack.json");
                    if (!File.Exists(packFile)) continue;
                    string packId = Path.GetFileName(packDir);
                    string entriesDir = Path.Combine(packDir, "entries");
                    if (!Directory.Exists(entriesDir)) continue;
                    foreach (string entryFile in Directory.GetFiles(entriesDir, "*.md"))
                    {
                        Dictionary<string, object> entry = ParseMemoryEntry(entryFile);
                        Dictionary<string, object> row = new Dictionary<string, object>();
                        row["packId"] = packId;
                        row["id"] = entry.ContainsKey("id") ? entry["id"] : Path.GetFileNameWithoutExtension(entryFile);
                        row["title"] = entry.ContainsKey("title") ? entry["title"] : Path.GetFileNameWithoutExtension(entryFile);
                        row["type"] = entry.ContainsKey("type") ? entry["type"] : "";
                        row["body"] = entry.ContainsKey("body") ? entry["body"] : "";
                        row["keywords"] = entry.ContainsKey("keywords") ? entry["keywords"] : new List<string>();
                        row["updatedAt"] = entry.ContainsKey("updatedAt") ? entry["updatedAt"] : "";
                        rows.Add(row);
                        if (rows.Count >= 50) break;
                    }
                    if (rows.Count >= 50) break;
                }
                return new JavaScriptSerializer().Serialize(rows);
            }
            catch { return "[]"; }
        }

        // 解析 memory-hub 条目文件（entries/*.md）：frontmatter 键值 + body 前 200 字符。
        private static Dictionary<string, object> ParseMemoryEntry(string file)
        {
            Dictionary<string, object> m = new Dictionary<string, object>();
            string body = "";
            try
            {
                string text = File.ReadAllText(file);
                body = text;
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0)
                    {
                        string fm = text.Substring(3, end - 3);
                        body = text.Substring(end + 4).Trim();
                        List<string> keywords = new List<string>();
                        foreach (string raw in fm.Split('\n'))
                        {
                            string line = raw.TrimEnd('\r');
                            int ci = line.IndexOf(':');
                            if (ci <= 0) continue;
                            string k = line.Substring(0, ci).Trim();
                            string v = line.Substring(ci + 1).Trim();
                            if (k == "keywords")
                            {
                                if (v.StartsWith("["))
                                {
                                    try
                                    {
                                        object[] arr = new JavaScriptSerializer().Deserialize<object[]>(v);
                                        if (arr != null)
                                        {
                                            foreach (object o in arr)
                                            {
                                                string p = Convert.ToString(o).Trim().Trim('\'', '"');
                                                if (p.Length > 0) keywords.Add(p);
                                            }
                                        }
                                    }
                                    catch
                                    {
                                        foreach (string part in v.Trim('[', ']').Split(','))
                                        {
                                            string p = part.Trim().Trim('\'', '"');
                                            if (p.Length > 0) keywords.Add(p);
                                        }
                                    }
                                }
                                else if (v.Length > 0)
                                {
                                    foreach (string part in v.Split(','))
                                    {
                                        string p = part.Trim().Trim('\'', '"');
                                        if (p.Length > 0) keywords.Add(p);
                                    }
                                }
                            }
                            else if (k == "id") m["id"] = v;
                            else if (k == "title") m["title"] = v.Trim('\'', '"');
                            else if (k == "type") m["type"] = v;
                            else if (k == "updatedAt") m["updatedAt"] = v;
                        }
                        if (keywords.Count == 0)
                        {
                            bool inKwList = false;
                            foreach (string raw in fm.Split('\n'))
                            {
                                string line = raw.TrimEnd('\r');
                                if (line.StartsWith("keywords:")) { inKwList = true; continue; }
                                if (inKwList && line.StartsWith("- "))
                                {
                                    string p = line.Substring(2).Trim().Trim('\'', '"');
                                    if (p.Length > 0) keywords.Add(p);
                                }
                                else if (inKwList && line.Length > 0 && !line.StartsWith(" "))
                                {
                                    inKwList = false;
                                }
                            }
                        }
                        m["keywords"] = keywords;
                    }
                }
            }
            catch
            {
            }
            if (!m.ContainsKey("title")) m["title"] = Path.GetFileNameWithoutExtension(file);
            string bodyText = string.IsNullOrEmpty(body) ? "" : body;
            m["body"] = bodyText.Length > 2000 ? bodyText.Substring(0, 2000) : bodyText;
            return m;
        }

        private static string FindMemoryEntryFile(string id)
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string hubDir = Path.Combine(home, ".dsh", "memory-hub");
                if (!Directory.Exists(hubDir)) return null;
                foreach (string packDir in Directory.GetDirectories(hubDir))
                {
                    string entriesDir = Path.Combine(packDir, "entries");
                    if (!Directory.Exists(entriesDir)) continue;
                    foreach (string entryFile in Directory.GetFiles(entriesDir, "*.md"))
                    {
                        if (Path.GetFileNameWithoutExtension(entryFile) == id) return entryFile;
                        Dictionary<string, object> entry = ParseMemoryEntry(entryFile);
                        if (entry.ContainsKey("id") && Convert.ToString(entry["id"]) == id) return entryFile;
                    }
                }
            }
            catch { /* 有意吞掉：查找失败返回 null，调用方按不存在处理 */ }
            return null;
        }

        private static string SetFmValue(string fm, string key, string value)
        {
            string[] lines = fm.Replace("\r\n", "\n").Split('\n');
            List<string> next = new List<string>();
            bool replaced = false;
            foreach (string line in lines)
            {
                string t = line.TrimEnd('\r');
                if (t.StartsWith(key + ":"))
                {
                    next.Add(key + ": " + value);
                    replaced = true;
                }
                else
                {
                    next.Add(t);
                }
            }
            if (!replaced) next.Add(key + ": " + value);
            return string.Join("\n", next);
        }

        private static void DeleteMemoryFile(string id)
        {
            try
            {
                string file = FindMemoryEntryFile(id);
                if (file != null) File.Delete(file);
            }
            catch { /* 有意吞掉：删除失败在刷新后可见，不阻塞主流程 */ }
        }

        private static void SaveMemoryFile(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(payload);
                if (data == null) return;
                string id = data.ContainsKey("id") ? Convert.ToString(data["id"]) : "";
                string file = FindMemoryEntryFile(id);
                if (file == null) return;
                string text = File.ReadAllText(file);
                string title = data.ContainsKey("title") ? Convert.ToString(data["title"]) : "";
                string body = data.ContainsKey("body") ? Convert.ToString(data["body"]) : "";
                string type = data.ContainsKey("type") ? Convert.ToString(data["type"]) : "";
                object[] keywords = data.ContainsKey("keywords") ? data["keywords"] as object[] : null;
                List<string> kw = new List<string>();
                if (keywords != null)
                {
                    foreach (object k in keywords)
                    {
                        string p = Convert.ToString(k).Trim();
                        if (p.Length > 0) kw.Add(p);
                    }
                }
                string fm = "";
                string oldBody = "";
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0)
                    {
                        fm = text.Substring(3, end - 3);
                        oldBody = text.Substring(end + 4).Trim();
                    }
                }
                if (title.Length > 0) fm = SetFmValue(fm, "title", title);
                if (type.Length > 0) fm = SetFmValue(fm, "type", type);
                fm = SetFmValue(fm, "updatedAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"));
                if (kw.Count > 0) fm = SetFmValue(fm, "keywords", new JavaScriptSerializer().Serialize(kw));
                if (body.Length == 0) body = oldBody;
                File.WriteAllText(file, "---\n" + fm + "\n---\n\n" + body + "\n");
            }
            catch { /* 有意吞掉：保存失败在刷新后可见，不阻塞主流程 */ }
        }
        private static string GetSkillsJson()
        {
            try
            {
                string dir = SkillsDir();
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                List<string> seen = new List<string>();
                string[] files = Directory.GetFiles(dir, "*.md");
                foreach (string file in files)
                {
                    string id = Path.GetFileNameWithoutExtension(file);
                    Dictionary<string, string> fm = ReadSkillFrontmatter(file);
                    AddSkillItem(list, seen, id, fm, true);
                }
                string[] disabled = Directory.GetFiles(dir, "*.md.disabled");
                foreach (string file in disabled)
                {
                    string name = Path.GetFileName(file);
                    string id = name.Substring(0, name.Length - ".md.disabled".Length);
                    Dictionary<string, string> fm = ReadSkillFrontmatter(file);
                    AddSkillItem(list, seen, id, fm, false);
                }
                foreach (string sub in Directory.GetDirectories(dir))
                {
                    string skillMd = Path.Combine(sub, "SKILL.md");
                    string disabledMd = skillMd + ".disabled";
                    string id = Path.GetFileName(sub);
                    if (seen.Contains(id)) continue;
                    if (File.Exists(skillMd))
                    {
                        Dictionary<string, string> fm = ReadSkillFrontmatter(skillMd);
                        AddSkillItem(list, seen, id, fm, true);
                    }
                    else if (File.Exists(disabledMd))
                    {
                        Dictionary<string, string> fm = ReadSkillFrontmatter(disabledMd);
                        AddSkillItem(list, seen, id, fm, false);
                    }
                }
                return new JavaScriptSerializer().Serialize(list);
            }
            catch { return "[]"; }
        }

        private static void AddSkillItem(List<Dictionary<string, object>> list, List<string> seen, string id, Dictionary<string, string> fm, bool enabled)
        {
            Dictionary<string, object> item = new Dictionary<string, object>();
            item["id"] = id;
            item["name"] = string.IsNullOrEmpty(fm["name"]) ? id : fm["name"];
            item["enabled"] = enabled;
            item["desc"] = fm["desc"];
            list.Add(item);
            seen.Add(id);
        }

        private static string SkillSourceDir()
        {
            string env = Environment.GetEnvironmentVariable("DSH_SKILL_SOURCE_DIR");
            if (!string.IsNullOrEmpty(env)) return env;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "reasonix", "skills");
        }

        private static string GetSkillSourceJson()
        {
            try
            {
                string root = SkillSourceDir();
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                List<string> seen = new List<string>();
                if (Directory.Exists(root))
                {
                    string[] mds = Directory.GetFiles(root, "SKILL.md", SearchOption.AllDirectories);
                    foreach (string md in mds)
                    {
                        string full = Path.GetFullPath(md);
                        string dirName = Path.GetFileName(Path.GetDirectoryName(full));
                        Dictionary<string, string> fm = ReadSkillFrontmatter(full);
                        string sourceId = string.IsNullOrEmpty(fm["name"]) ? SanitizeSkillName(dirName) : SanitizeSkillName(fm["name"]);
                        if (sourceId.Length == 0) sourceId = SanitizeSkillName(dirName);
                        if (sourceId.Length == 0 || seen.Contains(sourceId)) continue;
                        seen.Add(sourceId);
                        bool installed = SkillInstalled(sourceId);
                        Dictionary<string, object> item = new Dictionary<string, object>();
                        item["id"] = sourceId;
                        item["name"] = string.IsNullOrEmpty(fm["name"]) ? sourceId : fm["name"];
                        item["desc"] = fm["desc"];
                        item["path"] = Path.GetDirectoryName(full);
                        item["installed"] = installed;
                        list.Add(item);
                    }
                }
                return new JavaScriptSerializer().Serialize(new Dictionary<string, object>() { { "dir", root }, { "skills", list } });
            }
            catch { return "{\"dir\":\"\",\"skills\":[]}"; }
        }

        private static bool SkillInstalled(string id)
        {
            string dir = SkillsDir();
            return Directory.Exists(Path.Combine(dir, id)) || File.Exists(Path.Combine(dir, id + ".md")) || File.Exists(Path.Combine(dir, id + ".md.disabled"));
        }

        private static void AddSkillsFromSource(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(payload);
                object[] paths = data != null && data.ContainsKey("paths") ? (object[])data["paths"] : null;
                if (paths == null) return;
                string cli = PanelCliPath();
                foreach (object p in paths)
                {
                    string path = Convert.ToString(p);
                    if (string.IsNullOrEmpty(path) || !Directory.Exists(path)) continue;
                    if (cli != null)
                    {
                        RunCli(GetNodeExe(), "\"" + cli + "\" skill add \"" + path.Replace("\"", "\\\"") + "\"");
                    }
                    else
                    {
                        CopySkillBundleToInstalled(path);
                    }
                }
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }

        private static void CopySkillBundleToInstalled(string sourceDir)
        {
            try
            {
                string src = Path.Combine(sourceDir, "SKILL.md");
                Dictionary<string, string> fm = File.Exists(src) ? ReadSkillFrontmatter(src) : null;
                string dirName = Path.GetFileName(Path.GetFullPath(sourceDir));
                string id = fm != null && !string.IsNullOrEmpty(fm["name"]) ? SanitizeSkillName(fm["name"]) : SanitizeSkillName(dirName);
                if (id.Length == 0) id = SanitizeSkillName(dirName);
                if (id.Length == 0) return;
                string target = Path.Combine(SkillsDir(), id);
                if (Directory.Exists(target) || File.Exists(target + ".md")) return;
                Directory.CreateDirectory(target);
                if (File.Exists(src)) File.Copy(src, Path.Combine(target, "SKILL.md"));
                foreach (string file in Directory.GetFiles(sourceDir))
                {
                    string name = Path.GetFileName(file);
                    if (name == "SKILL.md") continue;
                    File.Copy(file, Path.Combine(target, name));
                }
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }

        private static Dictionary<string, string> ReadSkillFrontmatter(string file)
        {
            Dictionary<string, string> m = new Dictionary<string, string>();
            m["name"] = Path.GetFileNameWithoutExtension(file);
            m["desc"] = "本地 Skill";
            try
            {
                string text = File.ReadAllText(file);
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0)
                    {
                        string fm = text.Substring(3, end - 3);
                        foreach (string line in fm.Split('\n'))
                        {
                            string t = line.TrimEnd('\r');
                            if (t.StartsWith("name:"))
                            {
                                string v = t.Substring("name:".Length).Trim().Trim('\'', '"');
                                if (v.Length > 0) m["name"] = v;
                            }
                            else if (t.StartsWith("description:"))
                            {
                                string v = t.Substring("description:".Length).Trim().Trim('\'', '"');
                                if (v.Length > 0) m["desc"] = v;
                            }
                        }
                    }
                }
                else
                {
                    string first = text.TrimStart('#', ' ', '\t', '\r', '\n');
                    if (first.Length > 0)
                    {
                        int nl = first.IndexOf('\n');
                        string n = (nl > 0 ? first.Substring(0, nl) : first).Trim();
                        if (n.Length > 0) m["name"] = n;
                    }
                }
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            return m;
        }

        private static void SaveSkillFile(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(payload);
                string name = data != null && data.ContainsKey("name") ? Convert.ToString(data["name"]) : "skill";
                string desc = data != null && data.ContainsKey("desc") ? Convert.ToString(data["desc"]) : "";
                string id = SanitizeSkillName(name);
                if (id.Length == 0) id = "skill-" + DateTime.Now.Ticks.ToString("x");
                string dir = Path.Combine(SkillsDir(), id);
                if (Directory.Exists(dir)) id = id + "-" + DateTime.Now.Ticks.ToString("x");
                dir = Path.Combine(SkillsDir(), id);
                Directory.CreateDirectory(dir);
                string frontmatter =
                    "---\n" +
                    "name: " + id + "\n" +
                    "description: " + desc + "\n" +
                    "disable-model-invocation: false\n" +
                    "---\n\n" +
                    desc + "\n";
                File.WriteAllText(Path.Combine(dir, "SKILL.md"), frontmatter);
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }

        private static string SanitizeSkillName(string name)
        {
            string s = System.Text.RegularExpressions.Regex.Replace((name ?? "").ToLowerInvariant(), "[^a-z0-9]+", "-");
            s = s.Trim('-');
            if (s.Length > 64) s = s.Substring(0, 64);
            return s;
        }

        private static void DeleteSkillFile(string id)
        {
            try
            {
                string dir = Path.Combine(SkillsDir(), id);
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                    return;
                }
                string file = Path.Combine(SkillsDir(), id + ".md");
                if (File.Exists(file)) File.Delete(file);
                string disabledFile = Path.Combine(SkillsDir(), id + ".md.disabled");
                if (File.Exists(disabledFile)) File.Delete(disabledFile);
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }


        private static string PanelCliPath()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string cli = Path.Combine(home, ".dsh", "profiles", "web", "node_modules", "dseam-skillmcp", "lib", "cli.js");
                if (File.Exists(cli)) return cli;
                cli = Path.Combine(home, ".dsh", "profiles", "desktop", "node_modules", "dseam-skillmcp", "lib", "cli.js");
                if (File.Exists(cli)) return cli;
                cli = Path.Combine(home, ".dsh", "profiles", "web", "node_modules", "dsh-skill-mcp-panel", "lib", "cli.js");
                if (File.Exists(cli)) return cli;
            }
            catch { /* 有意吞掉：找不到面板 CLI 时 MCP 管理按失败处理 */ }
            return null;
        }

        private static string RunDshPanelCli(string arguments)
        {
            string cli = PanelCliPath();
            if (cli == null) return null;
            return RunCli(GetNodeExe(), "\"" + cli + "\" " + arguments);
        }

        private static string ExtractYamlValue(string text, string key)
        {
            string pattern = "^\\s*" + key + ":\\s*(.*)$";
            foreach (string line in text.Replace("\r\n", "\n").Split('\n'))
            {
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(line, pattern);
                if (m.Success)
                {
                    string v = m.Groups[1].Value.Trim();
                    if (v.Length >= 2 && ((v[0] == '\'' && v[v.Length - 1] == '\'') || (v[0] == '"' && v[v.Length - 1] == '"'))) v = v.Substring(1, v.Length - 2);
                    return v;
                }
            }
            return null;
        }

        private static List<string> ExtractYamlStringList(string text, string key)
        {
            List<string> list = new List<string>();
            string pattern = "^\\s*" + key + ":\\s*\\[(.*)\\]\\s*$";
            foreach (string line in text.Replace("\r\n", "\n").Split('\n'))
            {
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(line, pattern);
                if (m.Success)
                {
                    string inner = m.Groups[1].Value;
                    foreach (string part in inner.Split(','))
                    {
                        string p = part.Trim().Trim('\'', '"');
                        if (p.Length > 0) list.Add(p);
                    }
                    break;
                }
            }
            return list;
        }

        private static string GetMcpsJson()
        {
            try
            {
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                string patch = McpPatchPath();
                if (File.Exists(patch))
                {
                    string text = File.ReadAllText(patch);
                    string block = null;
                    // v5 阶段 4：先契约单行 marker（## <owner>:mcp），再旧 begin/end 形态（迁移期读兼容）
                    string[] newMarkers = new string[] { "## dseam-skillmcp:mcp", "## dsh-skill-mcp-panel:mcp" };
                    foreach (string marker in newMarkers)
                    {
                        int mb = text.IndexOf(marker);
                        if (mb >= 0)
                        {
                            int blockStart = text.IndexOf('\n', mb);
                            if (blockStart >= 0)
                            {
                                int me = text.Length;
                                foreach (string m2 in newMarkers)
                                {
                                    int idx = text.IndexOf(m2, blockStart + 1);
                                    if (idx >= 0 && idx < me) me = idx;
                                }
                                block = text.Substring(blockStart + 1, me - blockStart - 1);
                            }
                            break;
                        }
                    }
                    if (block == null)
                    {
                        string begin = "# >>> dseam-skillmcp:mcp:begin";
                        string end = "# <<< dseam-skillmcp:mcp:end";
                        int b = text.IndexOf(begin);
                        int e = text.IndexOf(end);
                        if (b < 0 || e <= b)
                        {
                            begin = "# >>> dsh-skill-mcp-panel:mcp:begin";
                            end = "# <<< dsh-skill-mcp-panel:mcp:end";
                            b = text.IndexOf(begin);
                            e = text.IndexOf(end);
                        }
                        if (b >= 0 && e > b)
                            block = text.Substring(b + begin.Length, e - b - begin.Length);
                    }
                    if (block != null)
                    {
                        System.Text.RegularExpressions.MatchCollection rows = System.Text.RegularExpressions.Regex.Matches(block, @"- id:\s*((?:dseam-mcp|panel-mcp)-[A-Za-z0-9_-]+)[\s\S]*?(?=\n\s*- id:|\z)");
                        foreach (System.Text.RegularExpressions.Match rowMatch in rows)
                        {
                            string rowText = rowMatch.Value;
                            string id = rowMatch.Groups[1].Value;
                            string serverName = ExtractYamlValue(rowText, "serverName") ?? id;
                            string transport = ExtractYamlValue(rowText, "transport") ?? "stdio";
                            Dictionary<string, object> item = new Dictionary<string, object>();
                            item["id"] = serverName;
                            item["name"] = serverName;
                            item["enabled"] = !rowText.Contains("disabled: true");
                            item["transport"] = transport;
                            item["command"] = ExtractYamlValue(rowText, "command") ?? "";
                            item["url"] = ExtractYamlValue(rowText, "url") ?? "";
                            item["args"] = ExtractYamlStringList(rowText, "args");
                            item["autoStart"] = false;
                            list.Add(item);
                        }
                    }
                }
                return new JavaScriptSerializer().Serialize(list);
            }
            catch { return "[]"; }
        }

        private static void SaveMcpFile(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(payload);
                if (data == null) return;
                string name = data.ContainsKey("name") ? Convert.ToString(data["name"]) : "";
                string oldName = data.ContainsKey("oldName") ? Convert.ToString(data["oldName"]) : "";
                name = SanitizeServerName(name);
                if (name.Length == 0) return;
                string transport = data.ContainsKey("transport") ? Convert.ToString(data["transport"]) : "stdio";
                bool enabled = !data.ContainsKey("enabled") || Convert.ToBoolean(data["enabled"]);
                if (!string.IsNullOrEmpty(oldName) && oldName != name) RunDshPanelCli("mcp remove \"" + oldName + "\" --yes");
                RunDshPanelCli("mcp remove \"" + name + "\" --yes");
                string addArgs = "mcp add --profile web --name \"" + name + "\" ";
                if (transport == "streamable-http")
                {
                    string url = data.ContainsKey("url") ? Convert.ToString(data["url"]) : "";
                    if (url.Length == 0) return;
                    addArgs += "--http --url \"" + url + "\"";
                }
                else
                {
                    string command = data.ContainsKey("command") ? Convert.ToString(data["command"]) : "";
                    if (command.Length == 0) return;
                    addArgs += "--stdio --command \"" + command + "\"";
                    if (data.ContainsKey("args"))
                    {
                        object[] arr = data["args"] as object[];
                        if (arr == null && data["args"] is string)
                        {
                            string argsRaw = Convert.ToString(data["args"]);
                            foreach (string part in argsRaw.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
                            {
                                addArgs += " --args \"" + part + "\"";
                            }
                        }
                        else if (arr != null)
                        {
                            foreach (object a in arr) addArgs += " --args \"" + Convert.ToString(a) + "\"";
                        }
                    }
                }
                RunDshPanelCli(addArgs);
                if (!enabled) RunDshPanelCli("mcp disable \"" + name + "\"");
            }
            catch { /* 有意吞掉：MCP 保存失败在刷新后可见，不阻塞主流程 */ }
        }

        private static void DeleteMcpFile(string id)
        {
            try
            {
                RunDshPanelCli("mcp remove \"" + SanitizeServerName(id) + "\" --yes");
            }
            catch { /* 有意吞掉：删除失败在刷新后可见，不阻塞主流程 */ }
        }

        private static string McpPatchPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "profiles", "web", "cordis.patch.yml");
        }

        private static string SanitizeServerName(string id)
        {
            string s = System.Text.RegularExpressions.Regex.Replace(id ?? "", "[^A-Za-z0-9_-]", "-");
            if (s.Length > 32) s = s.Substring(0, 32);
            return s.Length == 0 ? "mcp" : s;
        }

        private static string StartMcpProcess(string id)
        {
            try
            {
                string name = SanitizeServerName(id);
                string output = RunDshPanelCli("mcp test \"" + name + "\"");
                return output ?? "MCP 测试失败（未找到 dsh-skill-mcp-panel CLI）";
            }
            catch (Exception ex)
            {
                return "MCP 测试异常：" + ex.Message;
            }
        }
        private static bool TestApiConnection(ApiConfig cfg, out string error)
        {
            return TestApiConnection(cfg, cfg.defaultModel, out error);
        }

        private static bool TestApiConnection(ApiConfig cfg, string model, out string error)
        {
            return TestApiConnection(cfg, model, null, null, out error);
        }

        private static bool TestApiConnection(ApiConfig cfg, string model, string apiKeyOverride, string baseUrlOverride, out string error)
        {
            error = "";
            string apiKey = string.IsNullOrEmpty(apiKeyOverride) ? cfg.apiKey : apiKeyOverride;
            try
            {
                string baseUrl = string.IsNullOrEmpty(baseUrlOverride) ? cfg.baseUrl : baseUrlOverride;
                string endpoint = (baseUrl.TrimEnd('/')) + "/chat/completions";
                string body = "{\"model\":" + JsString(string.IsNullOrEmpty(model) ? cfg.defaultModel : model) +
                    ",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}";
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Accept = "application/json";
                request.Headers["Authorization"] = "Bearer " + apiKey;
                request.Timeout = 15000;
                byte[] data = Encoding.UTF8.GetBytes(body);
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) { stream.Write(data, 0, data.Length); }
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    {
                        reader.ReadToEnd();
                    }
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }
        private string CallLlm(string userText, string model, string systemPrompt, List<Dictionary<string, string>> history, string packJson, ApiConfig cfg, string apiKeyOverride = null, string baseUrlOverride = null)
        {
            string apiKey = string.IsNullOrEmpty(apiKeyOverride) ? cfg.apiKey : apiKeyOverride;
            try
            {
                string baseUrl = string.IsNullOrEmpty(baseUrlOverride) ? cfg.baseUrl : baseUrlOverride;
                string endpoint = (baseUrl.TrimEnd('/')) + "/chat/completions";
                const string defaultSystem =
                    "你是 DSH 插件包组装器。请根据用户需求生成一个 hotpack 1.0 插件包清单：" +
                    "{\"hotpack\":\"1.0\",\"id\":\"pack.ai.<英文短id>\",\"name\":\"<中文包名>\",\"version\":\"0.1.0\",\"description\":\"<一句话说明>\",\"tags\":[\"<标签>\"],\"plugins\":[{\"id\":\"<英文插件id>\",\"name\":\"<npm包名>\",\"version\":\"<精确版本号>\",\"source\":{\"type\":\"npm\"},\"config\":{}}]}。" +
                    "只输出 JSON，不要输出其他文字。";
                var msgs = new List<string>();
                msgs.Add("{\"role\":\"system\",\"content\":" + JsString(string.IsNullOrEmpty(systemPrompt) ? defaultSystem : systemPrompt) + "}");
                if (history != null)
                {
                    foreach (Dictionary<string, string> m in history)
                    {
                        if (m == null || !m.ContainsKey("role") || !m.ContainsKey("content")) continue;
                        msgs.Add("{\"role\":" + JsString(m["role"]) + ",\"content\":" + JsString(m["content"]) + "}");
                    }
                }
                string userContent = userText;
                if (!string.IsNullOrEmpty(packJson))
                    userContent = "当前已装配的 hotpack 1.0 清单：\n" + packJson + "\n\n用户新指令：" + userText;
                msgs.Add("{\"role\":\"user\",\"content\":" + JsString(userContent) + "}");
                string body = "{\"model\":" + JsString(model) +
                    ",\"messages\":[" + string.Join(",", msgs) +
                    "],\"temperature\":" + cfg.temperature.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) +
                    ",\"max_tokens\":4096}";

                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Accept = "application/json";
                request.Headers["Authorization"] = "Bearer " + apiKey;
                request.Timeout = 120000;
                byte[] data = Encoding.UTF8.GetBytes(body);
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream())
                {
                    stream.Write(data, 0, data.Length);
                }
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string responseText = reader.ReadToEnd();
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(responseText);
                    if (root == null || !root.ContainsKey("choices")) return null;
                    object[] choices = (object[])root["choices"];
                    if (choices.Length == 0) return null;
                    Dictionary<string, object> choice = (Dictionary<string, object>)choices[0];
                    Dictionary<string, object> message = (Dictionary<string, object>)choice["message"];
                    return Convert.ToString(message["content"]);
                }
            }
            catch (WebException we)
            {
                string detail = "";
                try
                {
                    if (we.Response != null)
                    {
                        using (StreamReader sr = new StreamReader(we.Response.GetResponseStream(), Encoding.UTF8))
                        {
                            detail = sr.ReadToEnd();
                            if (detail.Length > 300) detail = detail.Substring(0, 300);
                            if (!string.IsNullOrEmpty(apiKey)) detail = detail.Replace(apiKey, "***");
                        }
                    }
                }
                catch { /* 错误正文读取失败时忽略 */ }
                HttpWebResponse resp = we.Response as HttpWebResponse;
                int status = (resp != null) ? (int)resp.StatusCode : 0;
                throw new Exception("AI 服务 HTTP " + status + (detail.Length > 0 ? "：" + detail : "：" + we.Message), we);
            }
            catch (Exception ex)
            {
                throw new Exception("AI 请求失败：" + ex.Message, ex);
            }
        }

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}