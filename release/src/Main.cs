using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
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
        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, @"LocalDseamWorld-DSH-Hotplug-Hub", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("Dseam世界已经在运行（托盘或后台进程）。", "Dseam世界", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                SetProcessDPIAware();
                try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 webView = new WebView2();
        private const string APP_VERSION = "0.9.1";
        private const string PROJECT_REPO = "ARFCON/dsh-hotplug-hub";
        private const string PANEL_REPO = "Fishquito7/dsh-skill-mcp-panel";
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
        private static bool _panelUpdateNotified = false;
        private NotifyIcon _trayIcon = null;
        private bool _allowExit = false;

        public MainForm()
        {
            Text = "Dseam世界";
            Width = 1180;
            Height = 800;
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { Icon = SystemIcons.Application; }

            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.White;

            Controls.Add(webView);
            Load += async delegate { await InitializeAsync(); };
            FormClosing += (sender, e) =>
            {
                if (_allowExit) return;
                // 关闭窗口时隐藏到托盘，保持后台进程常驻（运行后后台也有进程）。
                e.Cancel = true;
                Hide();
                ShowInTaskbar = false;
            };
            SetupTray();
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
                menu.Items.Add("打开 Dseam世界", null, delegate { ShowMainForm(); });
                menu.Items.Add("退出", null, delegate { ExitApplication(); });
                _trayIcon.ContextMenuStrip = menu;
                _trayIcon.DoubleClick += delegate { ShowMainForm(); };
                _trayIcon.Visible = true;
            }
            catch { /* 有意吞掉：托盘不可用时应用仍可正常使用 */ }
        }

        private void ShowMainForm()
        {
            Show();
            ShowInTaskbar = true;
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void ExitApplication()
        {
            _allowExit = true;
            try { _trayIcon.Visible = false; _trayIcon.Dispose(); } catch { /* 有意吞掉 */ }
            Application.Exit();
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
                        else if (message == "checkUpdate")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
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
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
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
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                        }
                        else if (message != null && message.StartsWith("deleteSkill:"))
                        {
                            DeleteSkillFile(message.Substring("deleteSkill:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                        }
                        else if (message == "listSkillSource")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkillSource(" + GetSkillSourceJson() + ");");
                        }
                        else if (message != null && message.StartsWith("addSkillSource:"))
                        {
                            AddSkillsFromSource(message.Substring("addSkillSource:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkillSource(" + GetSkillSourceJson() + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                        }
                        else if (message != null && message.StartsWith("enableSkill:"))
                        {
                            RunDshPanelCli("skill enable \"" + SanitizeServerName(message.Substring("enableSkill:".Length)) + "\"");
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("disableSkill:"))
                        {
                            RunDshPanelCli("skill disable \"" + SanitizeServerName(message.Substring("disableSkill:".Length)) + "\"");
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills(" + GetSkillsJson() + ");");
                        }
                        else if (message == "listMcp")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                        }
                        else if (message != null && message.StartsWith("addMcp:"))
                        {
                            SaveMcpFile(message.Substring("addMcp:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                        }
                        else if (message != null && message.StartsWith("deleteMcp:"))
                        {
                            DeleteMcpFile(message.Substring("deleteMcp:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMcps(" + GetMcpsJson() + ");");
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                        }
                        else if (message != null && message.StartsWith("startMcp:"))
                        {
                            string testResult = StartMcpProcess(message.Substring("startMcp:".Length));
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
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMemory=function(d){window.__memoryData=d||[];if(typeof renderMemory==='function')renderMemory();if(typeof renderShell==='function')renderShell();};window.__setSkills=function(d){window.__skillsData=d||[];if(typeof renderSkills==='function')renderSkills();};window.__setSkillSource=function(d){window.__skillSourceData=d||null;if(typeof renderSkills==='function')renderSkills();};window.__setMcps=function(d){window.__mcpsData=d||[];if(typeof renderMcp==='function')renderMcp();};window.chrome.webview.postMessage('listMemory');window.chrome.webview.postMessage('listSkills');window.chrome.webview.postMessage('listSkillSource');window.chrome.webview.postMessage('listMcp');");
                            string latestCheck = GetLatestReleaseVersion();
                            if (!_updateNotified && !string.IsNullOrEmpty(latestCheck) && latestCheck != APP_VERSION)
                            {
                                _updateNotified = true;
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('发现新版本 v" + latestCheck + "，请到 自检更新 下载');");
                            }
                            string panelLatestCheck = "0.8.0-pre";
                            string panelInstalledCheck = GetInstalledPanelVersion();
                            if (!_panelUpdateNotified && !string.IsNullOrEmpty(panelLatestCheck) && panelLatestCheck != panelInstalledCheck)
                            {
                                _panelUpdateNotified = true;
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('内置 Skill/MCP 管理器可更新到 v" + panelLatestCheck + "，请到 自检更新 安装');");
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

        // 左侧栏底部版本信息上方注入居中启动按钮；同时补上原型缺失的 .hidden 规则，让左侧导航真正切换视图
        private static string InjectSidebarLaunchButton(string html)
        {
            string style = "<style>" +
                ".hidden { display: none !important; }" +
                ".side-launch { margin: 4px 0 12px; text-align: center; }" +
                ".side-launch .launch-btn {" +
                " width: 100%; padding: 10px 12px; border: 0; border-radius: 8px;" +
                " background: #0e7c6b; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;" +
                " }" +
                ".side-launch .launch-btn:hover { background: #0a6a5c; }" +
                ".side-launch .launch-btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.35); color: #e7f0ec; margin-top: 8px; }" +
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
            string pnpm = GetPnpmVersion();
            string dshDesktop = FindOfficialHarness();
            string dshVersion = GetDshCoreVersion();
            if (string.IsNullOrEmpty(dshVersion) && dshDesktop != null)
            {
                try { dshVersion = FileVersionInfo.GetVersionInfo(dshDesktop).FileVersion; } catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            }
            string wv = null;
            try { wv = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            string profiles = DetectProfiles();
            string latest = GetLatestReleaseVersion();
            string panelInstalled = GetInstalledPanelVersion();
            string panelLatest = "0.8.0-pre";

            string js =
                "window.__nativeSelfCheck={" +
                "node:" + JsString(node) + "," +
                "pnpm:" + JsString(pnpm) + "," +
                "dshDesktop:" + JsString(dshDesktop) + "," +
                "dshVersion:" + JsString(dshVersion) + "," +
                "webview2:" + JsString(wv) + "," +
                "profiles:" + JsString(profiles) + "," +
                "appVersion:" + JsString(APP_VERSION) + "," +
                "latestVersion:" + JsString(latest) + "," +
                "panelInstalled:" + JsString(panelInstalled) + "," +
                "panelLatest:" + JsString(panelLatest) +
                "};" +
                "if(window.__nativeSelfCheck.dshVersion){state.dshVersion=window.__nativeSelfCheck.dshVersion;state.latestVersion=window.__nativeSelfCheck.dshVersion;if(typeof renderShell==='function')renderShell();}" +
                "if(window.__nativeSelfCheck.panelInstalled||window.__nativeSelfCheck.panelLatest){state.panelInstalled=window.__nativeSelfCheck.panelInstalled||state.panelInstalled||null;state.panelLatest=window.__nativeSelfCheck.panelLatest||state.panelLatest||null;}" +
                "(function(){window.__baseGetChecks=window.__baseGetChecks||getChecks;getChecks=function(){var r=window.__baseGetChecks();" +
                "for(var i=0;i<r.length;i++){" +
                "if(r[i].name==='Node.js'){r[i].val=window.__nativeSelfCheck.node||'未检测到';r[i].text=window.__nativeSelfCheck.node?'已检测':'未安装';r[i].status=window.__nativeSelfCheck.node?'ok':'err';}" +
                "if(r[i].name==='pnpm'){r[i].val=window.__nativeSelfCheck.pnpm||'未检测到';r[i].text=window.__nativeSelfCheck.pnpm?'已检测':'未安装';r[i].status=window.__nativeSelfCheck.pnpm?'ok':'err';}" +
                "if(r[i].name==='DSH 版本'){r[i].val=window.__nativeSelfCheck.dshVersion||r[i].val;r[i].text=window.__nativeSelfCheck.dshDesktop?'官方 Harness 已安装':'未找到官方 Harness';r[i].status=window.__nativeSelfCheck.dshDesktop?'ok':'warn';}" +
                "if(r[i].name==='官方 Skill/MCP 面板'){var pi=window.__nativeSelfCheck.panelInstalled;var pl=window.__nativeSelfCheck.panelLatest;r[i].val=pi||'未安装';if(!pi){r[i].status='warn';r[i].text='可安装 v'+(pl||'?');}else if(pl&&pi!==pl){r[i].status='update';r[i].text='可更新至 v'+pl;}else{r[i].status='ok';r[i].text='已最新';}}" +
                "}" +
                "if(window.__nativeSelfCheck.webview2){r.push({name:'WebView2',desc:'桌面渲染内核',val:window.__nativeSelfCheck.webview2,status:'ok',text:'可用'});}" +
                "if(window.__nativeSelfCheck.profiles){r.push({name:'本地 DSH Profile',desc:'~/.dsh/profiles 探测',val:window.__nativeSelfCheck.profiles,status:'ok',text:'已探测'});}" +
                "if(window.__nativeSelfCheck.dshDesktop){r.push({name:'官方 Harness 路径',desc:'当前启动器',val:window.__nativeSelfCheck.dshDesktop,status:'ok',text:'已选择'});}" +
                "if(window.__nativeSelfCheck.appVersion){r.push({name:'本程序版本',desc:'当前安装版本',val:window.__nativeSelfCheck.appVersion,status:'ok',text:'v'+window.__nativeSelfCheck.appVersion});}" +
                "if(window.__nativeSelfCheck.latestVersion){r.push({name:'最新版本',desc:'GitHub 最新发布',val:window.__nativeSelfCheck.latestVersion,status:window.__nativeSelfCheck.latestVersion===window.__nativeSelfCheck.appVersion?'ok':'warn',text:window.__nativeSelfCheck.latestVersion===window.__nativeSelfCheck.appVersion?'已是最新':'可更新'});}" +
                "return r;};" +
                "if(typeof renderCheck==='function'){renderCheck();}" +
                "var drs=document.querySelectorAll('.check-row');for(var i=0;i<drs.length;i++){var dn=drs[i].querySelector('.name');if(dn&&dn.textContent==='DSH 版本'){var db=document.createElement('button');db.className='btn sm primary';db.style.marginLeft='8px';db.textContent='⬇ 下载官方客户端';db.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('downloadHarness');}};drs[i].appendChild(db);}}" +
                "var urs=document.querySelectorAll('.check-row');for(var i=0;i<urs.length;i++){var un=urs[i].querySelector('.name');if(un&&un.textContent==='本程序版本'){var b1=document.createElement('button');b1.className='btn sm primary';b1.style.marginLeft='8px';b1.textContent='检查更新';b1.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('checkUpdate');}};var b2=document.createElement('button');b2.className='btn sm';b2.style.marginLeft='8px';b2.textContent='下载新版本';b2.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('downloadProject');}};urs[i].appendChild(b1);urs[i].appendChild(b2);}}" +
                "var prs=document.querySelectorAll('.check-row');for(var i=0;i<prs.length;i++){var pn=prs[i].querySelector('.name');if(pn&&pn.textContent==='官方 Skill/MCP 面板'){var pv=window.__nativeSelfCheck.panelInstalled;var plv=window.__nativeSelfCheck.panelLatest;var pb=document.createElement('button');pb.className='btn sm primary';pb.style.marginLeft='8px';if(!pv){pb.textContent='安装插件';pb.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('installPanel');}};}else if(plv&&pv!==plv){pb.textContent='更新到 v'+plv;pb.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('updatePanel');}};}else{pb.textContent='重新安装';pb.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('installPanel');}};}prs[i].appendChild(pb);var ob=document.createElement('button');ob.className='btn sm';ob.style.marginLeft='8px';ob.textContent='打开页面';ob.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('openPanelPage');}};prs[i].appendChild(ob);}}" +
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

        private static void LaunchOfficialHarness()
        {
            string harnessPath = FindOfficialHarness();
            if (harnessPath == null)
            {
                DialogResult choose = MessageBox.Show(
                    "未找到官方 DSH 桌面端（DSH Desktop / DeepSeek Harness）。\n\n是否手动选择 DSH 桌面端启动程序？",
                    "Dseam世界", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (choose == DialogResult.Yes)
                {
                    harnessPath = ChooseHarnessManually();
                }
                if (harnessPath == null)
                {
                    MessageBox.Show("未选择官方 DSH 桌面端。", "Dseam世界",
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
                MessageBox.Show("启动官方 DSH 桌面端失败：\n" + ex.Message, "Dseam世界",
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
                MessageBox.Show("打开官方下载页失败：\n" + ex.Message, "Dseam世界",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
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

        private static string GetLatestReleaseVersion()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + PROJECT_REPO + "/releases/tags/v" + APP_VERSION);
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Accept = "application/vnd.github+json";
                string githubToken = GetGithubToken();
                if (!string.IsNullOrEmpty(githubToken)) request.Headers.Add("Authorization", "Bearer " + githubToken);
                request.Timeout = 15000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                    if (root != null && root.ContainsKey("tag_name"))
                    {
                        string tag = Convert.ToString(root["tag_name"]);
                        return tag.TrimStart('v');
                    }
                }
            }
            catch
            {
            }
            return null;
        }


        // ---------- 官方 Skill/MCP 面板插件（dsh-skill-mcp-panel）安装与自动更新 ----------

        private static Dictionary<string, string> GetPanelReleaseInfo()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + PANEL_REPO + "/releases/latest");
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Accept = "application/vnd.github+json";
                string githubToken = GetGithubToken();
                if (!string.IsNullOrEmpty(githubToken)) request.Headers.Add("Authorization", "Bearer " + githubToken);
                request.Timeout = 15000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
                    if (root == null) return null;
                    Dictionary<string, string> info = new Dictionary<string, string>();
                    if (root.ContainsKey("tag_name"))
                    {
                        string tag = Convert.ToString(root["tag_name"]).TrimStart('v');
                        info["latest"] = tag;
                    }
                    if (root.ContainsKey("assets"))
                    {
                        object[] assets = root["assets"] as object[];
                        if (assets != null)
                        {
                            foreach (object assetObj in assets)
                            {
                                Dictionary<string, object> asset = assetObj as Dictionary<string, object>;
                                if (asset == null) continue;
                                string name = Convert.ToString(asset.ContainsKey("name") ? asset["name"] : "");
                                if (name.EndsWith(".tgz") && asset.ContainsKey("browser_download_url"))
                                {
                                    info["url"] = Convert.ToString(asset["browser_download_url"]);
                                    break;
                                }
                            }
                        }
                    }
                    return info.Count > 0 ? info : null;
                }
            }
            catch
            {
            }
            return null;
        }

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
        private static string[] FindDshCommand()
        {
            // 1. 官方 DSH Desktop 内置 dsh CLI（最可靠，优先）
            string harness = FindOfficialHarness();
            if (harness != null)
            {
                string appDir = Path.GetDirectoryName(harness);
                if (appDir != null)
                {
                    string binJs = Path.Combine(appDir, "resources", "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                    if (File.Exists(binJs))
                    {
                        return new string[] { "node", "\"" + binJs + "\"" };
                    }
                }
            }

            // 2. PATH 中直接有 dsh（npm/pnpm 全局安装）。
            //    注意：cmd.exe /c dsh --version 在找不到 dsh 时会打印 cmd 自身版本横幅，
            //    必须排除 "Microsoft"/"Windows" 字样，避免把 cmd 横幅误判成 dsh 版本。
            string probe = RunCli("cmd.exe", "/c dsh --version");
            if (!string.IsNullOrEmpty(probe) && probe.Contains(".")
                && !probe.Contains("Microsoft") && !probe.Contains("Windows"))
            {
                return new string[] { "cmd.exe", "/c dsh" };
            }

            // 3. Linux/macOS 常见位置（本 EXE 在 Windows 上运行，此项保留给未来移植）
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string altBin = Path.Combine(home, ".dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
            if (File.Exists(altBin))
            {
                return new string[] { "node", "\"" + altBin + "\"" };
            }

            return null;
        }


        // 部分 Windows 环境的 pnpm 访问 GitHub Release 会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE，
        // 需要给 web profile 写 .npmrc 关闭严格 SSL，否则 dsh plugin add 必然失败。
        private static void EnsureProfileNpmrc()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string profileDir = Path.Combine(home, ".dsh", "profiles", "web");
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
        private static string RunDshPluginAdd(string tarballUrl)
        {
            string[] cmd = FindDshCommand();
            if (cmd == null) return null;
            string args = cmd[1] + " plugin --profile web add " + tarballUrl;
            return RunCliLong(cmd[0], args);
        }

        private static string RunDshPanelInstall(string tarballUrl)
        {
            return RunDshPluginAdd(tarballUrl);
        }

        private static string RunCliLong(string fileName, string arguments)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(fileName, arguments);
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(180000);
                    return output.Trim();
                }
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }

        private static string InstallOrUpdatePanel()
        {
            try
            {
                Dictionary<string, string> info = GetPanelReleaseInfo();
                if (info == null || !info.ContainsKey("url"))
                {
                    return "未获取到 dsh-skill-mcp-panel 发布信息，请检查网络";
                }
                string latest = info.ContainsKey("latest") ? info["latest"] : "?";
                string installed = GetInstalledPanelVersion();
                if (!string.IsNullOrEmpty(installed) && installed == latest)
                {
                    return "官方面板插件已是最新 v" + installed;
                }
                EnsureProfileNpmrc();
                string output = RunDshPanelInstall(info["url"]);
                if (output == null)
                {
                    return "未找到 dsh 命令，请先安装官方 DSH Desktop 或把 dsh 加入 PATH";
                }
                if (output.Contains("ERR_PNPM") || output.Contains("Error:") || output.Contains("error:"))
                {
                    return "安装失败：" + output.Substring(0, Math.Min(output.Length, 160));
                }
                return "官方面板插件 v" + latest + " 已提交安装，重启 DSH 后生效";
            }
            catch (Exception ex)
            {
                return "安装异常：" + ex.Message;
            }
        }
        // 读取官方 DSH Desktop 内置的核心 dsh 版本（resources/app/package.json 的 @deepseek-ai/dsh）
        private static string GetDshCoreVersion()
        {
            try
            {
                string appDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs", "DSH Desktop", "resources", "app");
                string pkg = Path.Combine(appDir, "package.json");
                if (!File.Exists(pkg)) return null;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(pkg));
                if (root != null && root.ContainsKey("dependencies"))
                {
                    Dictionary<string, object> deps = root["dependencies"] as Dictionary<string, object>;
                    if (deps != null && deps.ContainsKey("@deepseek-ai/dsh"))
                    {
                        return Convert.ToString(deps["@deepseek-ai/dsh"]);
                    }
                }
                if (root != null && root.ContainsKey("version"))
                {
                    return Convert.ToString(root["version"]);
                }
            }
            catch
            {
            }
            return null;
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
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DeepSeek Harness", "DSH Desktop.exe")
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
                "var status=document.createElement('div');status.style.cssText='margin:8px 0;padding:10px 12px;border:1px solid var(--line);border-radius:var(--rad);background:var(--panel);cursor:pointer;';status.innerHTML='⚙ 当前模型：<b>'+(window.__apiConfig.defaultModel||'未知')+'</b>（点击配置）';status.onclick=function(){if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('openApiConfig');}};composeBtn.parentNode.insertBefore(status,composeBtn);" +
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
                var aiErrorTask = webView.CoreWebView2.ExecuteScriptAsync("window.__onAiError(" + JsString("AI 调用异常：" + ex.Message) + ");");
            }
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
                EnsureProfileNpmrc();
                Dictionary<string, string> info = GetMemoryHubReleaseInfo();
                string url = info != null && info.ContainsKey("url")
                    ? info["url"]
                    : "https://github.com/ARFCON/dsh-hotplug-hub/releases/download/v0.9.1/dsh-memory-hub-0.8.0-pre.tgz";
                string latest = info != null && info.ContainsKey("latest") ? info["latest"] : null;
                string installed = GetInstalledMemoryHubVersion();
                if (!string.IsNullOrEmpty(installed) && !string.IsNullOrEmpty(latest) && installed == latest)
                {
                    return;
                }
                string output = RunDshPluginAdd(url);
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
                InstallEmbeddedSkillMcp();
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
        }

        private static Dictionary<string, string> GetMemoryHubReleaseInfo()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + PROJECT_REPO + "/releases/tags/v" + APP_VERSION);
                request.Method = "GET";
                request.UserAgent = "DSH-Hotplug-Hub";
                request.Accept = "application/vnd.github+json";
                string githubToken = GetGithubToken();
                if (!string.IsNullOrEmpty(githubToken)) request.Headers.Add("Authorization", "Bearer " + githubToken);
                request.Timeout = 15000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.Deserialize<Dictionary<string, object>>(json);
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
                }
            }
            catch { /* 有意吞掉：尽力而为的探测/清理，失败使用回退值，不影响主流程 */ }
            return null;
        }

        // 内置 dseam-skillmcp（原开源 dsh-skill-mcp-panel 改名适配，MIT）：从 EXE 资源释放 tgz 并安装到 profile。
        private static void InstallEmbeddedSkillMcp()
        {
            try
            {
                string installed = GetInstalledPanelVersion();
                if (installed == "0.8.0-pre") return;
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DSHHotplugHub.Resources.dseam_skillmcp.tgz"))
                {
                    if (stream == null) return;
                    string dir = Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-embedded");
                    Directory.CreateDirectory(dir);
                    string tgz = Path.Combine(dir, "dseam-skillmcp-0.8.0-pre.tgz");
                    using (FileStream fs = new FileStream(tgz, FileMode.Create, FileAccess.Write))
                    {
                        stream.CopyTo(fs);
                    }
                    RunDshPluginAdd(tgz);
                }
            }
            catch { /* 有意吞掉：内置管理器安装失败不阻塞启动，下次启动重试 */ }
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
                        RunCli("node", "\"" + cli + "\" skill add \"" + path.Replace("\"", "\\\"") + "\"");
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
            return RunCli("node", "\"" + cli + "\" " + arguments);
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
                    {
                        string block = text.Substring(b + begin.Length, e - b - begin.Length);
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
            error = "";
            try
            {
                string endpoint = (cfg.baseUrl.TrimEnd('/')) + "/chat/completions";
                string body = "{\"model\":" + JsString(cfg.defaultModel) +
                    ",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}";
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Accept = "application/json";
                request.Headers["Authorization"] = "Bearer " + cfg.apiKey;
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
}