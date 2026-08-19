using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DSHHotplugHub
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            SetProcessDPIAware();
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 webView = new WebView2();

        public MainForm()
        {
            Text = "DSH 热插拔中枢 / DSH Hotplug Hub";
            Width = 1180;
            Height = 800;
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { Icon = SystemIcons.Application; }

            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = DshTheme.Bg; // 与 Web --bg 一致，避免加载瞬间白闪

            Controls.Add(webView);
            Load += async delegate { await InitializeAsync(); };
        }

        private async Task InitializeAsync()
        {
            try
            {
                string html = ReadEmbeddedHtml();
                html = InjectSidebarLaunchButton(html);

                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DSH-Hotplug-Hub", "WebView2");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(env);

                webView.CoreWebView2.WebMessageReceived += async delegate (object sender, CoreWebView2WebMessageReceivedEventArgs e)
                {
                    try
                    {
                        string message = e.TryGetWebMessageAsString();
                        if (message == "launch")
                        {
                            LaunchOfficialHarness();
                        }
                        else if (message == "recheck")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
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
                                await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                            }
                        }
                        else if (message == "downloadHarness")
                        {
                            OpenOfficialDownloadPage();
                        }
                        else if (message != null && message.StartsWith("ai:"))
                        {
                            await HandleAiRequestAsync(message.Substring(3));
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
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildApiIntegrationScript());
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
                MessageBox.Show("WebView2 初始化失败：\n" + ex.Message, "DSH 热插拔中枢",
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

        // 左侧栏底部版本信息上方注入居中启动按钮；同时补上原型缺失的 .hidden 规则，让左侧导航真正切换视图
        private static string InjectSidebarLaunchButton(string html)
        {
            // 注入样式直接引用页面 :root 令牌（var(--teal) 等），与 prototype.html 单一配色源保持一致
            string style = "<style>" +
                ".hidden { display: none !important; }" +
                ".side-launch { margin: 4px 0 12px; text-align: center; }" +
                ".side-launch .launch-btn {" +
                " width: 100%; padding: 10px 12px; border: 0; border-radius: var(--rad);" +
                " background: var(--teal); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;" +
                " }" +
                ".side-launch .launch-btn:hover { background: var(--teal-hover); }" +
                ".side-launch .launch-btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.35); color: var(--sidebar-ink); margin-top: 8px; }" +
                ".side-launch .launch-btn.secondary:hover { background: rgba(255,255,255,0.08); }" +
                "</style>";

            string buttonHtml =
                "<div class=\"side-launch\">" +
                "<button class=\"launch-btn\" style=\"margin-bottom:8px\" onclick=\"if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('openApiConfig');}\">⚙ DSH API 配置</button>" +
                "<button class=\"launch-btn\" onclick=\"if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('launch');}\">▶ 启动 DSH 官方启动器</button>" +
                "<button class=\"launch-btn secondary\" onclick=\"if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('chooseHarness');}\">📁 选择桌面端</button>" +
                "</div>";

            html = html.Replace("</head>", style + "</head>");
            html = html.Replace(
                "<div class=\"side-foot\" id=\"sideFoot\"></div>",
                buttonHtml + "<div class=\"side-foot\" id=\"sideFoot\"></div>");
            return html;
        }

        // 生成注入到页面里的真实自检数据脚本（Node/pnpm/官方 Harness/WebView2/profile 探测）
        private static string BuildNativeSelfCheckScript()
        {
            string node = RunCli("node", "--version");
            string pnpm = RunCli("pnpm", "--version");
            string dshDesktop = FindOfficialHarness();
            string dshVersion = null;
            if (dshDesktop != null)
            {
                try { dshVersion = FileVersionInfo.GetVersionInfo(dshDesktop).FileVersion; } catch { }
            }
            string wv = null;
            try { wv = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
            string profiles = DetectProfiles();

            string js =
                "window.__nativeSelfCheck={" +
                "node:" + JsString(node) + "," +
                "pnpm:" + JsString(pnpm) + "," +
                "dshDesktop:" + JsString(dshDesktop) + "," +
                "dshVersion:" + JsString(dshVersion) + "," +
                "webview2:" + JsString(wv) + "," +
                "profiles:" + JsString(profiles) +
                "};" +
                "(function(){var o=getChecks;getChecks=function(){var r=o();" +
                "for(var i=0;i<r.length;i++){" +
                "if(r[i].name==='Node.js'){r[i].val=window.__nativeSelfCheck.node||'未检测到';r[i].text=window.__nativeSelfCheck.node?'已检测':'未安装';r[i].status=window.__nativeSelfCheck.node?'ok':'err';}" +
                "if(r[i].name==='pnpm'){r[i].val=window.__nativeSelfCheck.pnpm||'未检测到';r[i].text=window.__nativeSelfCheck.pnpm?'已检测':'未安装';r[i].status=window.__nativeSelfCheck.pnpm?'ok':'err';}" +
                "if(r[i].name==='DSH 版本'){r[i].val=window.__nativeSelfCheck.dshVersion||r[i].val;r[i].text=window.__nativeSelfCheck.dshDesktop?'官方 Harness 已安装':'未找到官方 Harness';r[i].status=window.__nativeSelfCheck.dshDesktop?'ok':'warn';}" +
                "}" +
                "if(window.__nativeSelfCheck.webview2){r.push({name:'WebView2',desc:'桌面渲染内核',val:window.__nativeSelfCheck.webview2,status:'ok',text:'可用'});}" +
                "if(window.__nativeSelfCheck.profiles){r.push({name:'本地 DSH Profile',desc:'~/.dsh/profiles 探测',val:window.__nativeSelfCheck.profiles,status:'ok',text:'已探测'});}" +
                "if(window.__nativeSelfCheck.dshDesktop){r.push({name:'官方 Harness 路径',desc:'当前启动器',val:window.__nativeSelfCheck.dshDesktop,status:'ok',text:'已选择'});}" +
                "return r;};" +
                "if(typeof renderCheck==='function'){renderCheck();}" +
                "var drs=document.querySelectorAll('.check-row');for(var i=0;i<drs.length;i++){var dn=drs[i].querySelector('.name');if(dn&&dn.textContent==='DSH 版本'){var db=document.createElement('button');db.className='btn sm primary';db.style.marginLeft='8px';db.textContent='⬇ 下载官方客户端';db.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('downloadHarness');}};drs[i].appendChild(db);}}" +
                "var rc=document.getElementById('recheck');if(rc){rc.addEventListener('click',function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('recheck');}});}" +
                "})();";
            return js;
        }

        private static string JsString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "null";
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

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
                    string output = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(5000);
                    return output;
                }
            }
            catch
            {
                return null;
            }
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

        private static void LaunchOfficialHarness()
        {
            string harnessPath = FindOfficialHarness();
            if (harnessPath == null)
            {
                DialogResult choose = MessageBox.Show(
                    "未找到官方 DSH 桌面端（DSH Desktop / DeepSeek Harness）。\n\n是否手动选择 DSH 桌面端启动程序？",
                    "DSH 热插拔中枢", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (choose == DialogResult.Yes)
                {
                    harnessPath = ChooseHarnessManually();
                }
                if (harnessPath == null)
                {
                    MessageBox.Show("未选择官方 DSH 桌面端。", "DSH 热插拔中枢",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
            }

            string processName = Path.GetFileNameWithoutExtension(harnessPath);
            Process[] running = Process.GetProcessesByName(processName);
            if (running.Length > 0)
            {
                foreach (Process p in running)
                {
                    if (p.MainWindowHandle != IntPtr.Zero)
                    {
                        SetForegroundWindow(p.MainWindowHandle);
                        return;
                    }
                }
            }

            try
            {
                Process.Start(new ProcessStartInfo(harnessPath) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动官方 DSH 桌面端失败：\n" + ex.Message, "DSH 热插拔中枢",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
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

        private static void OpenOfficialDownloadPage()
        {
            try
            {
                Process.Start("https://github.com/deepseek-ai/deepseek-harness/releases/latest");
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开官方下载页失败：\n" + ex.Message, "DSH 热插拔中枢",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static string FindOfficialHarness()
        {
            // 1. 用户手动选择过的路径优先
            string saved = LoadHarnessPath();
            if (saved != null && File.Exists(saved)) return saved;

            // 2. 常见安装位置
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DSH Desktop", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DSH Desktop", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "DSH Desktop", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DeepSeek Harness", "DSH Desktop.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DeepSeek Harness", "DSH Desktop.exe"),
                @"C:\Users\OwO\AppData\Local\Programs\DSH Desktop\DSH Desktop.exe"
            };
            foreach (string candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                }
            }

            // 3. 自动扫描常见程序目录里的 DSH / DeepSeek 相关桌面端
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
                        if (File.Exists(full))
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

        // ---------- API 模型配置 ----------

        private sealed class ApiConfig
        {
            public string provider = "DeepSeek 官方";
            public string baseUrl = "https://api.deepseek.com/v1";
            public string apiKey = "";
            public string models = "deepseek-chat,deepseek-reasoner";
            public string defaultModel = "deepseek-chat";
            public double temperature = 0.7;
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
            }
            catch
            {
            }
        }

        private static void ShowApiConfigDialog()
        {
            ApiConfig cfg = LoadApiConfig();
            string keyMasked = string.IsNullOrEmpty(cfg.apiKey)
                ? "未配置"
                : cfg.apiKey.Length > 8
                    ? cfg.apiKey.Substring(0, 4) + "****" + cfg.apiKey.Substring(cfg.apiKey.Length - 4)
                    : "****";

            using (Form dlg = new Form())
            {
                dlg.Text = "DSH API 配置（官方）";
                dlg.Width = 560;
                dlg.Height = 320;
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false;
                dlg.MinimizeBox = false;
                dlg.Font = DshTheme.UiFont;
                dlg.BackColor = DshTheme.Panel;   // --panel
                dlg.ForeColor = DshTheme.Ink;     // --ink

                Label info = new Label();
                info.Text =
                    "本程序直接使用官方 DSH 的 API 配置：\r\n\r\n" +
                    "Provider : " + cfg.provider + "\r\n" +
                    "Model    : " + cfg.defaultModel + "\r\n" +
                    "Base URL : " + cfg.baseUrl + "\r\n" +
                    "API Key  : " + keyMasked + "\r\n\r\n" +
                    "请在官方 DSH Desktop 的模型设置中修改 API 配置，\r\n" +
                    "修改后点击“重新读取”即可生效。";
                info.SetBounds(20, 16, 500, 160);
                info.ForeColor = DshTheme.Ink; // --ink

                Button refresh = new Button();
                refresh.Text = "重新读取";
                refresh.SetBounds(20, 200, 110, 32);
                refresh.Click += delegate
                {
                    cfg = LoadApiConfig();
                    keyMasked = string.IsNullOrEmpty(cfg.apiKey)
                        ? "未配置"
                        : cfg.apiKey.Length > 8
                            ? cfg.apiKey.Substring(0, 4) + "****" + cfg.apiKey.Substring(cfg.apiKey.Length - 4)
                            : "****";
                    info.Text =
                        "本程序直接使用官方 DSH 的 API 配置：\r\n\r\n" +
                        "Provider : " + cfg.provider + "\r\n" +
                        "Model    : " + cfg.defaultModel + "\r\n" +
                        "Base URL : " + cfg.baseUrl + "\r\n" +
                        "API Key  : " + keyMasked + "\r\n\r\n" +
                        "请在官方 DSH Desktop 的模型设置中修改 API 配置，\r\n" +
                        "修改后点击“重新读取”即可生效。";
                };

                Button openDir = new Button();
                openDir.Text = "打开配置目录";
                openDir.SetBounds(140, 200, 120, 32);
                openDir.Click += delegate
                {
                    try
                    {
                        string dshDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
                        if (Directory.Exists(dshDir)) Process.Start("explorer.exe", dshDir);
                    }
                    catch
                    {
                    }
                };

                Button launch = new Button();
                launch.Text = "启动官方 DSH 配置";
                launch.SetBounds(270, 200, 140, 32);
                launch.BackColor = DshTheme.Teal;      // 与 .btn.primary 语义一致
                launch.ForeColor = Color.White;
                launch.FlatStyle = FlatStyle.Flat;
                launch.Click += delegate { LaunchOfficialHarness(); };

                Button close = new Button();
                close.Text = "关闭";
                close.SetBounds(420, 200, 80, 32);
                close.Click += delegate { dlg.Close(); };

                dlg.Controls.AddRange(new Control[] { info, refresh, openDir, launch, close });
                dlg.ShowDialog();
            }
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
                string keyLine = "DEEPSEEK_API_KEY: " + cfg.apiKey;
                if (credText.Contains("DEEPSEEK_API_KEY:"))
                {
                    string[] credLines = credText.Replace("\r\n", "\n").Split('\n');
                    for (int i = 0; i < credLines.Length; i++)
                    {
                        if (credLines[i].StartsWith("DEEPSEEK_API_KEY:"))
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
            string configJson = ser.Serialize(cfg);

            string js =
                "window.__apiConfig=" + configJson + ";" +
                "(function(){var ensureModelSelect=function(){" +
                "var composeBtn=document.getElementById('composeBtn');" +
                "if(!composeBtn||document.getElementById('aiModelSelect'))return;" +
                "var wrap=document.createElement('div');wrap.style.cssText='margin:10px 0;display:flex;align-items:center;gap:8px;';" +
                "wrap.innerHTML='模型: ';" +
                "var sel=document.createElement('select');sel.id='aiModelSelect';" +
                "var ms=(window.__apiConfig.models||'deepseek-chat').split(',');" +
                "for(var i=0;i<ms.length;i++){var id=ms[i].trim();if(!id)continue;var opt=document.createElement('option');opt.value=id;opt.text=id;sel.appendChild(opt);}" +
                "if(window.__apiConfig.defaultModel)sel.value=window.__apiConfig.defaultModel;" +
                "wrap.appendChild(sel);composeBtn.parentNode.insertBefore(wrap,composeBtn);" +
                "};" +
                "var origRenderAi=renderAi;renderAi=function(){origRenderAi();ensureModelSelect();};" +
                "var origCompose=compose;compose=function(){var input=document.getElementById('reqInput');if(!input||!input.value.trim())return;var sel=document.getElementById('aiModelSelect');var model=sel?sel.value:(window.__apiConfig.defaultModel||'deepseek-chat');if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('ai:'+JSON.stringify({text:input.value.trim(),model:model}));var box=document.getElementById('logBox');if(box){box.innerHTML='';if(typeof logLine==='function'){logLine(box,'正在调用 API（'+model+'）...','warn');}}}else{origCompose();}};" +
                "window.__onAiResult=function(result){try{var data=JSON.parse(result);aiResult=data;renderAi();if(typeof toast==='function')toast('AI 组装完成');}catch(e){if(typeof toast==='function')toast('AI 结果解析失败');}};" +
                "window.__onAiError=function(msg){var box=document.getElementById('logBox');if(box&&typeof logLine==='function'){logLine(box,msg,'warn');}if(typeof toast==='function')toast(msg);};" +
                "if(document.readyState!=='loading'){ensureModelSelect();}" +
                "})();";
            return js;
        }

        private async Task HandleAiRequestAsync(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> req = ser.Deserialize<Dictionary<string, object>>(payload);
                string text = req.ContainsKey("text") ? Convert.ToString(req["text"]) : "";
                string model = req.ContainsKey("model") ? Convert.ToString(req["model"]) : "";
                ApiConfig cfg = LoadApiConfig();
                if (string.IsNullOrEmpty(model)) model = cfg.defaultModel;

                string result = await Task.Run(() => CallLlm(text, model, cfg));
                if (result == null)
                {
                    await webView.CoreWebView2.ExecuteScriptAsync("window.__onAiError('API 调用失败，请检查 API 模型配置');");
                    return;
                }
                string jsonForPage = ExtractJsonObject(result);
                if (jsonForPage == null)
                {
                    await webView.CoreWebView2.ExecuteScriptAsync("window.__onAiError('API 返回内容无法解析为 JSON');");
                    return;
                }
                string script = "window.__onAiResult(" + jsonForPage + ");";
                await webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch (Exception ex)
            {
                webView.CoreWebView2.ExecuteScriptAsync("window.__onAiError(" + JsString("AI 调用异常：" + ex.Message) + ");");
            }
        }

        private string CallLlm(string userText, string model, ApiConfig cfg)
        {
            try
            {
                string endpoint = (cfg.baseUrl.TrimEnd('/')) + "/chat/completions";
                string systemPrompt =
                    "你是 DSH 插件包组装器。请根据用户需求生成一个 DSH 热插拔包 manifest 和 README。" +
                    "只输出 JSON，不要输出其他文字，格式如下：" +
                    "{\"name\":\"包名\",\"tags\":[\"标签\"],\"manifest\":{...hotpack/dshpack 字段...},\"readme\":\"markdown 文本\"}";
                string body = "{\"model\":" + JsString(model) +
                    ",\"messages\":[{\"role\":\"system\",\"content\":" + JsString(systemPrompt) +
                    "},{\"role\":\"user\",\"content\":" + JsString(userText) +
                    "}],\"temperature\":" + cfg.temperature.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "}";

                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Accept = "application/json";
                request.Headers["Authorization"] = "Bearer " + cfg.apiKey;
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
            catch
            {
                return null;
            }
        }

        private static string ExtractJsonObject(string text)
        {
            int start = text.IndexOf('{');
            int end = text.LastIndexOf('}');
            if (start < 0 || end <= start) return null;
            return text.Substring(start, end - start + 1);
        }

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
    }

    // ---- 设计令牌（与 dsh-pack-hub/prototype.html :root 保持同值；禁止另发明色值）----
    // 唯一权威色表见 开发文档/DSH-统一UI开发标准.md §2.1
    internal static class DshTheme
    {
        public static readonly Color Teal = Color.FromArgb(14, 124, 107);        // --teal
        public static readonly Color TealDark = Color.FromArgb(15, 47, 42);      // --teal-dark
        public static readonly Color TealSoft = Color.FromArgb(220, 238, 234);   // --teal-soft
        public static readonly Color TealHover = Color.FromArgb(10, 106, 92);    // --teal-hover
        public static readonly Color Bg = Color.FromArgb(241, 242, 236);         // --bg
        public static readonly Color Panel = Color.FromArgb(255, 254, 249);      // --panel
        public static readonly Color Ink = Color.FromArgb(23, 32, 29);           // --ink
        public static readonly Color Muted = Color.FromArgb(102, 115, 110);      // --muted
        public static readonly Color Line = Color.FromArgb(217, 221, 212);       // --line
        public static readonly Color SidebarInk = Color.FromArgb(231, 240, 236); // --sidebar-ink
        public static readonly Color Green = Color.FromArgb(26, 127, 75);        // --green
        public static readonly Color Amber = Color.FromArgb(180, 83, 9);         // --amber
        public static readonly Color Red = Color.FromArgb(179, 38, 30);          // --red
        public static readonly Color SurfaceDark = Color.FromArgb(16, 36, 31);   // --surface-dark
        public static readonly Font UiFont = new Font("Microsoft YaHei UI", 9F); // --font-sans 对应
    }
}