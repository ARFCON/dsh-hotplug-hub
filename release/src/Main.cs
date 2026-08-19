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
        private const string APP_VERSION = "0.1.9";
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
        }

        private async Task InitializeAsync()
        {
            try
            {
                InstallPluginsToHarness();
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
                                Process.Start("https://github.com/" + PANEL_REPO + "/releases/latest");
                            }
                            catch
                            {
                            }
                        }
                        else if (message == "listMemory")
                        {
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setMemory(" + GetMemoryJson() + ");");
                        }                        else if (message == "listSkills")
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
                            StartMcpProcess(message.Substring("startMcp:".Length));
                            await webView.CoreWebView2.ExecuteScriptAsync(BuildNativeSelfCheckScript());
                        }                        else if (message != null && message.StartsWith("ai:"))
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
                            await webView.CoreWebView2.ExecuteScriptAsync("window.__setSkills=function(d){window.__skillsData=d||[];if(typeof renderSkills==='function')renderSkills();};window.__setMcps=function(d){window.__mcpsData=d||[];if(typeof renderMcp==='function')renderMcp();};window.chrome.webview.postMessage('listSkills');window.chrome.webview.postMessage('listMcp');");
                            string latestCheck = GetLatestReleaseVersion();
                            if (!_updateNotified && !string.IsNullOrEmpty(latestCheck) && latestCheck != APP_VERSION)
                            {
                                _updateNotified = true;
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('发现新版本 v" + latestCheck + "，请到 自检更新 下载');");
                            }
                            string panelLatestCheck = null;
                            try
                            {
                                Dictionary<string, string> panelRelease = GetPanelReleaseInfo();
                                if (panelRelease != null && panelRelease.ContainsKey("latest")) panelLatestCheck = panelRelease["latest"];
                            }
                            catch
                            {
                            }
                            string panelInstalledCheck = GetInstalledPanelVersion();
                            if (!_panelUpdateNotified && !string.IsNullOrEmpty(panelLatestCheck) && panelLatestCheck != panelInstalledCheck)
                            {
                                _panelUpdateNotified = true;
                                await webView.CoreWebView2.ExecuteScriptAsync("if(typeof toast==='function')toast('官方 Skill/MCP 面板插件可更新到 v" + panelLatestCheck + "，请到 自检更新 安装');");
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
                try { dshVersion = FileVersionInfo.GetVersionInfo(dshDesktop).FileVersion; } catch { }
            }
            string wv = null;
            try { wv = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
            string profiles = DetectProfiles();
            string latest = GetLatestReleaseVersion();
            string panelInstalled = GetInstalledPanelVersion();
            string panelLatest = null;
            try
            {
                Dictionary<string, string> panelInfo = GetPanelReleaseInfo();
                if (panelInfo != null && panelInfo.ContainsKey("latest")) panelLatest = panelInfo["latest"];
            }
            catch
            {
            }

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
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + PROJECT_REPO + "/releases/latest");
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
                        candidates.Add(Path.Combine(profileDir, "node_modules", "dsh-skill-mcp-panel", "package.json"));
                    }
                }
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
        private static string RunDshPanelInstall(string tarballUrl)
        {
            string[] cmd = FindDshCommand();
            if (cmd == null) return null;
            string args = cmd[1] + " plugin --profile web add " + tarballUrl;
            return RunCliLong(cmd[0], args);
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
            catch { }
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
            catch { }
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
            catch { }
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
                webView.CoreWebView2.ExecuteScriptAsync("window.__onAiError(" + JsString("AI 调用异常：" + ex.Message) + ");");
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

        // 启动时自动把仓库插件安装/注册到本地 DeepSeek Harness
        private static void InstallPluginsToHarness()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string src = Path.GetFullPath(Path.Combine(baseDir, "..", "dsh-hotplug-hub", "dsh-memory-hub"));
                if (!Directory.Exists(src)) return;
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string target = Path.Combine(home, ".dsh", "plugin-src", "dsh-memory-hub");
                if (Directory.Exists(target)) { try { Directory.Delete(target, true); } catch { } }
                CopyDirectory(src, target);

                string patch = Path.Combine(home, ".dsh", "profiles", "web", "cordis.patch.yml");
                if (File.Exists(patch))
                {
                    string text = File.ReadAllText(patch);
                    text = text.Replace("# [已禁用]     - id: memory-hub", "    - id: memory-hub");
                    text = text.Replace("# [已禁用]       name: 'dsh-memory-hub'", "      name: 'dsh-memory-hub'");
                    if (!text.Contains("name: 'dsh-memory-hub'"))
                    {
                        text = text.TrimEnd() + "\n- insert:\n    - id: memory-hub\n      name: 'dsh-memory-hub'\n      config: { \"hubDir\": null, \"writePolicy\": \"ask\", \"snapshotOrder\": -50 }\n";
                    }
                    File.WriteAllText(patch, text);
                }
            }
            catch { }
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
        private static string GetMemoryJson()
        {
            try
            {
                string repo = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
                ProcessStartInfo psi = new ProcessStartInfo("node", "scripts/memoryhub-list.mjs");
                psi.WorkingDirectory = repo;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(10000);
                    return string.IsNullOrEmpty(output) ? "[]" : output;
                }
            }
            catch { return "[]"; }
        }
        private static string GetSkillsJson()
        {
            try
            {
                string dir = SkillsDir();
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                foreach (string file in Directory.GetFiles(dir, "*.md"))
                {
                    string id = Path.GetFileNameWithoutExtension(file);
                    string name = id;
                    string desc = "本地 Skill";
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
                                    if (line.StartsWith("name:")) name = line.Substring("name:".Length).Trim();
                                    if (line.StartsWith("description:")) desc = line.Substring("description:".Length).Trim();
                                }
                            }
                        }
                        else
                        {
                            name = text.TrimStart('#', ' ', '\t', '\r', '\n').Split('\n')[0].Trim();
                        }
                    }
                    catch { }
                    Dictionary<string, object> item = new Dictionary<string, object>();
                    item["id"] = id;
                    item["name"] = string.IsNullOrEmpty(name) ? id : name;
                    item["enabled"] = true;
                    item["desc"] = desc;
                    list.Add(item);
                }
                return new JavaScriptSerializer().Serialize(list);
            }
            catch { return "[]"; }
        }

        private static void SaveSkillFile(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(payload);
                string name = data != null && data.ContainsKey("name") ? Convert.ToString(data["name"]) : "skill";
                string desc = data != null && data.ContainsKey("desc") ? Convert.ToString(data["desc"]) : "";
                string id = "skill-" + DateTime.Now.Ticks.ToString("x");
                string dir = SkillsDir();
                Directory.CreateDirectory(dir);
                string frontmatter =
                    "---\n" +
                    "name: " + name + "\n" +
                    "description: " + desc + "\n" +
                    "disable-model-invocation: false\n" +
                    "---\n\n" +
                    desc + "\n";
                File.WriteAllText(Path.Combine(dir, id + ".md"), frontmatter);
            }
            catch { }
        }

        private static void DeleteSkillFile(string id)
        {
            try
            {
                string file = Path.Combine(SkillsDir(), id + ".md");
                if (File.Exists(file)) File.Delete(file);
            }
            catch { }
        }

        private static string GetMcpsJson()
        {
            try
            {
                string file = McpFilePath();
                if (!File.Exists(file))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    File.WriteAllText(file, "[]");
                }
                return File.ReadAllText(file);
            }
            catch { return "[]"; }
        }

        private static void SaveMcpFile(string payload)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> mcp = ser.Deserialize<Dictionary<string, object>>(payload);
                if (mcp == null) return;
                string file = McpFilePath();
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                if (File.Exists(file)) list = ser.Deserialize<List<Dictionary<string, object>>>(File.ReadAllText(file)) ?? new List<Dictionary<string, object>>();
                if (!mcp.ContainsKey("id") || mcp["id"] == null) mcp["id"] = "mcp-" + DateTime.Now.Ticks.ToString("x");
                string id = Convert.ToString(mcp["id"]);
                int idx = list.FindIndex((x) => x.ContainsKey("id") && Convert.ToString(x["id"]) == id);
                if (idx >= 0) list[idx] = mcp; else list.Add(mcp);
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllText(file, ser.Serialize(list));
                WriteMcpToPatch(mcp);
            }
            catch { }
        }

        private static void DeleteMcpFile(string id)
        {
            try
            {
                string file = McpFilePath();
                if (!File.Exists(file)) return;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                List<Dictionary<string, object>> list = ser.Deserialize<List<Dictionary<string, object>>>(File.ReadAllText(file)) ?? new List<Dictionary<string, object>>();
                list.RemoveAll((x) => x.ContainsKey("id") && Convert.ToString(x["id"]) == id);
                File.WriteAllText(file, ser.Serialize(list));
                RemoveMcpFromPatch(id);
            }
            catch { }
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

        private static void WriteMcpToPatch(Dictionary<string, object> mcp)
        {
            try
            {
                string patch = McpPatchPath();
                if (!File.Exists(patch)) return;
                string id = Convert.ToString(mcp.ContainsKey("id") ? mcp["id"] : "mcp");
                string serverName = SanitizeServerName(id);
                string command = mcp.ContainsKey("command") ? Convert.ToString(mcp["command"]) : "";
                string argsRaw = mcp.ContainsKey("args") ? Convert.ToString(mcp["args"]) : "";
                string[] args = argsRaw.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                string text = File.ReadAllText(patch);
                // 移除旧块
                text = System.Text.RegularExpressions.Regex.Replace(text, @"- insert:\r?\n\s+- id: mcp-" + System.Text.RegularExpressions.Regex.Escape(id) + @"[\s\S]*?(?=\r?\n- insert:|\r?\n\s*#|\z)", "");
                string block =
                    "- insert:\n" +
                    "    - id: mcp-" + id + "\n" +
                    "      name: '@deepseek-ai/dsh-mcp-client'\n" +
                    "      config:\n" +
                    "        transport: stdio\n" +
                    "        serverName: " + serverName + "\n" +
                    "        command: " + command + "\n" +
                    "        args: [" + string.Join(", ", args) + "]\n";
                text = text.TrimEnd() + "\n" + block;
                File.WriteAllText(patch, text);
            }
            catch { }
        }

        private static void RemoveMcpFromPatch(string id)
        {
            try
            {
                string patch = McpPatchPath();
                if (!File.Exists(patch)) return;
                string text = File.ReadAllText(patch);
                text = System.Text.RegularExpressions.Regex.Replace(text, @"- insert:\r?\n\s+- id: mcp-" + System.Text.RegularExpressions.Regex.Escape(id) + @"[\s\S]*?(?=\r?\n- insert:|\r?\n\s*#|\z)", "");
                File.WriteAllText(patch, text);
            }
            catch { }
        }
        private static void StartMcpProcess(string id)
        {
            try
            {
                string file = McpFilePath();
                if (!File.Exists(file)) return;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                List<Dictionary<string, object>> list = ser.Deserialize<List<Dictionary<string, object>>>(File.ReadAllText(file)) ?? new List<Dictionary<string, object>>();
                Dictionary<string, object> mcp = list.Find((x) => x.ContainsKey("id") && Convert.ToString(x["id"]) == id);
                if (mcp == null) return;
                string command = mcp.ContainsKey("command") ? Convert.ToString(mcp["command"]) : "";
                string args = mcp.ContainsKey("args") ? Convert.ToString(mcp["args"]) : "";
                if (string.IsNullOrEmpty(command)) return;
                Process.Start(new ProcessStartInfo(command, args) { UseShellExecute = false, CreateNoWindow = true });
            }
            catch { }
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