// ProcessContract.cs — 子进程执行/终止/探测判定的统一契约
//
// v1.1（桌面壳审计 PC5/PC11/PC12/PC13）：Main.cs 此前存在两个语义分裂的执行器——
//   RunCli     超时杀树（taskkill /T）+ 只读 stdout + 异常→null；
//   RunCliLong 超时只 Kill() 直接子进程（cmd /c npm 链孙进程孤儿）+ 合并 stderr + 异常→ex.Message。
// 同文件两套契约并存且各有缺陷。本契约收敛为单一执行器：
//   · 超时一律杀整棵进程树（孙进程不孤儿）；
//   · stderr 合并与否成为显式选项（探测=只 stdout；用户可见 CLI 操作=合并，错误不静默）；
//   · 启动失败统一返回 null（"找不到命令"语义），诊断信息保留；
//   · 活动子进程登记表：退出路径统一回收（fire-and-forget 安装任务的 npm/pnpm 不再遗留）。
// 另收口版本探测判定（LooksLikeVersionText）：正向形态判定取代
// "输出含 . 且不含 Microsoft/Windows" 的负向串匹配——wsl.exe 自身的 UTF-16 错误消息
// 按系统页解码成夹 \0 乱码后仍可能含 '.'，旧判定会把「WSL 未装 dsh」误判成可用。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace DSHHotplugHub
{
    /// <summary>子进程执行的选项与结果契约。</summary>
    public sealed class CliOptions
    {
        /// <summary>超时毫秒（超时后杀整棵树，返回已读到的部分输出）。</summary>
        public int TimeoutMs = 15000;
        /// <summary>是否把 stderr 合并进返回值（用户可见 CLI 操作应为 true：pnpm/dsh 的报错大多走 stderr）。</summary>
        public bool MergeStderr = false;
        /// <summary>stdout 解码（null = 系统默认页）。wsl.exe -l 等自身消息为 UTF-16LE 的命令需显式传 Encoding.Unicode。</summary>
        public Encoding OutputEncoding = null;
        /// <summary>进程级环境变量注入（如 npm 配置重试），不污染全局配置；null = 不注入。</summary>
        public IDictionary<string, string> ExtraEnv = null;
    }

    public sealed class CliResult
    {
        /// <summary>合并后的输出（Trim）；启动失败为 null。</summary>
        public string Output;
        /// <summary>是否超时被杀。</summary>
        public bool TimedOut;
        /// <summary>进程是否成功启动。</summary>
        public bool Started;
    }

    /// <summary>子进程执行/终止/探测的单一真源（Main.cs 执行器薄委托到此）。</summary>
    public static class ProcessContract
    {
        // ---------- 超时档位（单一真源；Main.cs 各调用点按操作类别取档） ----------

        /// <summary>版本探测类（node/pnpm/dsh --version）：冷启动慢≠未安装，统一 15s。</summary>
        public const int ProbeTimeoutMs = 15000;
        /// <summary>面板 CLI 类（skill/mcp enable/disable/add/remove/test）：写配置 + 可能起服务器握手。</summary>
        public const int PanelCliTimeoutMs = 30000;
        /// <summary>插件安装类（dsh plugin add/remove/update，本地 tgz / registry）。</summary>
        public const int InstallTimeoutMs = 180000;
        /// <summary>网络安装类（npm/pnpm 全局安装、Node 便携版解压）。</summary>
        public const int NetInstallTimeoutMs = 600000;

        // ---------- 活动子进程登记（退出路径统一回收，PC11） ----------

        private static readonly object OwnedLock = new object();
        private static readonly List<Process> OwnedProcesses = new List<Process>();

        private static void RegisterOwned(Process p)
        {
            lock (OwnedLock) { OwnedProcesses.Add(p); }
        }

        private static void UnregisterOwned(Process p)
        {
            lock (OwnedLock) { OwnedProcesses.Remove(p); }
        }

        /// <summary>杀掉并清空本进程登记的全部活动子进程树（应用退出路径调用；
        /// fire-and-forget 的安装任务不再遗留 npm/pnpm 孤儿）。
        /// 注意：只杀不 Dispose——在途 RunProcess 的 using 块持有该 Process 的所有权，
        /// 外部 Dispose 会让其 WaitForExit/using 抛 ObjectDisposedException、把成功误报为启动失败。</summary>
        public static int KillAllOwnedProcesses()
        {
            List<Process> snapshot;
            lock (OwnedLock)
            {
                snapshot = new List<Process>(OwnedProcesses);
                OwnedProcesses.Clear();
            }
            int killed = 0;
            foreach (Process p in snapshot)
            {
                try
                {
                    if (p != null && !p.HasExited) { KillProcessTree(p); killed++; }
                }
                catch { /* 尽力而为 */ }
            }
            return killed;
        }

        /// <summary>杀整棵进程树：taskkill /T /F（覆盖 cmd.exe 包装的孙进程），
        /// 等 2s 后回退 Kill() 直接子进程。与 RunCli 旧实现的树杀语义一致（单一真源）。</summary>
        public static void KillProcessTree(Process p)
        {
            if (p == null) return;
            try
            {
                string taskkill = Path.Combine(Environment.SystemDirectory, "taskkill.exe");
                using (Process killer = Process.Start(new ProcessStartInfo(taskkill, "/PID " + p.Id + " /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                }))
                {
                    if (killer != null && !killer.WaitForExit(2000)) { /* 尽力而为 */ }
                }
            }
            catch { /* 回退：至少杀直接子进程 */ }
            try { if (!p.HasExited) p.Kill(); } catch { /* 已退出/无权限 */ }
            try { p.WaitForExit(2000); } catch { /* 尽力而为 */ }
        }

        /// <summary>统一执行器：启动失败返回 Started=false（Output=null）；超时杀树后返回部分输出。
        /// 退出与管道 EOF 无 happens-before 关系，WaitForExit 后显式排空输出（最多 3s）。</summary>
        public static CliResult RunProcess(string fileName, string arguments, CliOptions options)
        {
            CliResult result = new CliResult();
            if (options == null) options = new CliOptions();
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(fileName, arguments);
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
                if (options.OutputEncoding != null)
                {
                    psi.StandardOutputEncoding = options.OutputEncoding;
                    psi.StandardErrorEncoding = options.OutputEncoding;
                }
                if (options.ExtraEnv != null)
                {
                    foreach (KeyValuePair<string, string> kv in options.ExtraEnv)
                    {
                        psi.EnvironmentVariables[kv.Key] = kv.Value;
                    }
                }
                using (Process p = Process.Start(psi))
                {
                    result.Started = true;
                    RegisterOwned(p);
                    try
                    {
                        Task<string> stdout = p.StandardOutput.ReadToEndAsync();
                        Task<string> stderr = p.StandardError.ReadToEndAsync();
                        if (!p.WaitForExit(options.TimeoutMs))
                        {
                            result.TimedOut = true;
                            KillProcessTree(p);
                        }
                        try { Task.WaitAll(new[] { stdout, stderr }, 3000); } catch { /* 超时即用已读到的部分 */ }
                        string outText = stdout.Status == TaskStatus.RanToCompletion ? stdout.Result.Trim() : "";
                        if (options.MergeStderr)
                        {
                            string errText = stderr.Status == TaskStatus.RanToCompletion ? stderr.Result.Trim() : "";
                            result.Output = errText.Length > 0 ? outText + Environment.NewLine + errText : outText;
                        }
                        else
                        {
                            result.Output = outText;
                        }
                    }
                    finally
                    {
                        UnregisterOwned(p);
                    }
                }
            }
            catch
            {
                // 启动失败（找不到文件/权限）：Started=false, Output=null —— 「命令不存在」语义单一化
                result.Started = false;
                result.Output = null;
            }
            return result;
        }

        // ---------- 版本探测判定（PC12/PC13：正向形态判定，取代负向串匹配） ----------

        // 版本形态：可带 v 前缀，至少「数字.数字」（如 20.11.1 / v0.3.1 / dsh/1.2.3 / 1.0.0-rc.1）。
        // 不锚定行首：npm 风格输出（"pkg/1.2.3"）与多行横幅后跟版本行的形态都要命中；
        // 乱码（\0）与 cmd 横幅已在前置判定拒绝。
        private static readonly Regex VersionShapeRe = new Regex(@"v?\d+\.\d+", RegexOptions.Compiled);

        /// <summary>输出是否「看起来像版本号」：存在版本形态行，且不含 \0（UTF-16 按 ANSI 页
        /// 解码的乱码特征——wsl.exe 自身错误消息）与 cmd 横幅（Microsoft/Windows）。
        /// 取代旧判定 `Contains(".") && !Contains("Microsoft") && !Contains("Windows")`
        /// （旧判定对夹 \0 乱码里的 '.' 误放行，把「WSL 无 dsh」误判成可用）。</summary>
        public static bool LooksLikeVersionText(string output)
        {
            if (string.IsNullOrEmpty(output)) return false;
            if (output.IndexOf('\0') >= 0) return false;                 // UTF-16 乱码：拒绝
            if (output.Contains("Microsoft") || output.Contains("Windows")) return false; // cmd 横幅
            return VersionShapeRe.IsMatch(output);
        }
    }
}
