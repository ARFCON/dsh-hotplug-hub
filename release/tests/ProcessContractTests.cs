// ProcessContractTests.cs — 子进程执行/终止/探测判定契约行为断言（v1.1 桌面壳审计 PC5/PC11/PC12/PC13；CI 必须全绿）
//
// 覆盖（真实子进程，非 mock）：
//   ① RunProcess 基本契约：正常退出读输出、启动失败 Started=false/Output=null、超时杀树返回部分输出；
//   ② KillProcessTree：cmd → ping 孙进程整树回收（.NET Kill() 只杀直接子进程的缺陷锁定）；
//   ③ owned 登记：活动子进程登记/注销、KillAllOwnedProcesses 统一回收（fire-and-forget 安装任务不再遗留）；
//   ④ LooksLikeVersionText：正向版本形态判定——ASCII 版本/多行/CRLF 放行；UTF-16 乱码（夹 \0）、
//      cmd 横幅（Microsoft/Windows）、错误文案拒绝（PC13：wsl.exe 自身错误消息误判回归锁定）；
//   ⑤ MergeStderr 选项：stderr-only 错误在合并模式下可见（用户可见 CLI 操作的错误不静默）；
//   ⑥ 超时常量档位存在性与大小关系。
//
// 编译：csc /nologo /target:exe /out:ProcessContractTests.exe ProcessContract.cs ProcessContractTests.cs
// 运行：ProcessContractTests.exe（非零退出 = 存在失败断言；需要 cmd.exe/ping/taskkill，仅限 Windows）
using System;
using System.Diagnostics;
using System.Threading;

namespace DSHHotplugHub
{
    public static class ProcessContractTestRunner
    {
        public static int Main()
        {
            try { return ProcessContractTests.Run(); }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                return 2;
            }
        }
    }

    public static class ProcessContractTests
    {
        private static int _failures = 0;
        private static int _passes = 0;

        private static void Check(bool cond, string name)
        {
            if (cond) { _passes++; Console.WriteLine("  PASS " + name); }
            else { _failures++; Console.WriteLine("  FAIL " + name); }
        }

        private static int PingProcessCount()
        {
            try { return Process.GetProcessesByName("PING").Length; }
            catch { return 0; }
        }

        public static int Run()
        {
            Console.WriteLine("== ProcessContract 契约测试（真实子进程：执行/树杀/登记/版本判定） ==");

            // ① RunProcess 基本契约
            Console.WriteLine("-- ① RunProcess 基本契约 --");
            CliResult hello = ProcessContract.RunProcess("cmd.exe", "/c echo hello-probe", new CliOptions { TimeoutMs = 15000 });
            Check(hello.Started, "cmd 启动成功");
            Check(hello.Output != null && hello.Output.Contains("hello-probe"), "stdout 正确读取");
            Check(!hello.TimedOut, "未超时");

            CliResult missing = ProcessContract.RunProcess("definitely-not-a-command-xyz.exe", "--version", new CliOptions { TimeoutMs = 3000 });
            Check(!missing.Started, "不存在的命令 Started=false");
            Check(missing.Output == null, "启动失败 Output=null（「命令不存在」语义单一化）");

            // 超时：先输出再挂起（部分输出可在超时后被读到——「超时返回部分输出」契约锁定）
            CliResult partial = ProcessContract.RunProcess("cmd.exe", "/c echo early-out& ping -n 30 127.0.0.1 > nul", new CliOptions { TimeoutMs = 1200 });
            Check(partial.Started, "部分输出用例启动成功");
            Check(partial.TimedOut, "部分输出用例超时标记");
            Check(partial.Output != null && partial.Output.Contains("early-out"), "超时杀树后仍返回已读部分输出");

            // ② KillProcessTree：cmd（直接子）→ ping（孙）整树回收
            // 计数断言用「相对差」而非绝对值（CI 机器可能有无关 ping 并发）：只要求
            // 树杀后 ping 数量比杀前显著回落，容忍外部噪声抬基线。
            Console.WriteLine("-- ② KillProcessTree（cmd→ping 孙进程） --");
            int pingBefore = PingProcessCount();
            Process tree = Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 30 127.0.0.1")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            });
            int pingDuring = pingBefore;
            for (int spin = 0; spin < 10 && pingDuring <= pingBefore; spin++)
            {
                Thread.Sleep(300); // 等孙进程（ping）真正起起来（重载机器重试窗口 3s）
                pingDuring = PingProcessCount();
            }
            Check(pingDuring > pingBefore, "孙进程（ping）已出现（基线 " + pingBefore + " → " + pingDuring + "）");
            ProcessContract.KillProcessTree(tree);
            int pingAfter = PingProcessCount();
            for (int spin = 0; spin < 10 && pingAfter >= pingDuring; spin++)
            {
                Thread.Sleep(300); // taskkill 异步生效窗口（重载机器重试 3s）
                pingAfter = PingProcessCount();
            }
            Check(pingAfter < pingDuring, "树杀后孙进程回收（" + pingDuring + " → " + pingAfter + "）");
            try { tree.Dispose(); } catch { }

            // ③ owned 登记 + KillAllOwnedProcesses（在后台线程发起长命令，主线程统一回收——
            //    复现 fire-and-forget 安装任务的退出路径）
            Console.WriteLine("-- ③ owned 登记 / KillAllOwnedProcesses --");
            CliResult bg1 = null;
            Thread worker = new Thread(delegate()
            {
                CliOptions longRun = new CliOptions { TimeoutMs = 60000 };
                bg1 = ProcessContract.RunProcess("cmd.exe", "/c ping -n 60 127.0.0.1 > nul", longRun);
            });
            worker.IsBackground = true;
            worker.Start();
            Thread.Sleep(1500); // 等长命令真实起跑并登记
            int killed = ProcessContract.KillAllOwnedProcesses();
            Check(killed >= 1, "KillAllOwnedProcesses 回收 ≥1 个在途登记进程（实际 " + killed + "）");
            bool joined = worker.Join(10000);
            Check(joined && bg1 != null && bg1.Started, "被回收的执行器及时返回且不被误报为启动失败（只杀不 Dispose 契约）");
            int killedAgain = ProcessContract.KillAllOwnedProcesses();
            Check(killedAgain == 0, "清空后再次回收 = 0（登记已注销）");

            // ④ LooksLikeVersionText（PC12/PC13 判定单一真源）
            Console.WriteLine("-- ④ LooksLikeVersionText --");
            Check(ProcessContract.LooksLikeVersionText("20.11.1"), "两段版本放行");
            Check(ProcessContract.LooksLikeVersionText("v0.3.1"), "v 前缀放行");
            Check(ProcessContract.LooksLikeVersionText("dsh/1.2.3"), "名字+版本放行");
            Check(ProcessContract.LooksLikeVersionText("1.0.0-rc.1"), "pre 后缀放行");
            Check(ProcessContract.LooksLikeVersionText("multi\r\nline\r\n0.9.8"), "多行 CRLF 含版本行放行");
            Check(ProcessContract.LooksLikeVersionText("\n  2.1.0\n"), "行首空白版本放行");
            Check(!ProcessContract.LooksLikeVersionText(""), "空拒绝");
            Check(!ProcessContract.LooksLikeVersionText(null), "null 拒绝");
            Check(!ProcessContract.LooksLikeVersionText("no digits here"), "无版本形态拒绝");
            Check(!ProcessContract.LooksLikeVersionText("command not found"), "bash 错误文案拒绝");
            Check(!ProcessContract.LooksLikeVersionText("系统找不到指定的文件"), "cmd 中文错误拒绝");
            Check(!ProcessContract.LooksLikeVersionText("Microsoft Windows [版本 10.0.22631.4460]"), "cmd 横幅拒绝（含版本形态但含 Microsoft/Windows）");
            Check(!ProcessContract.LooksLikeVersionText("0\x00.\x001\x00.\x002"), "UTF-16 乱码（夹 \\0）拒绝");
            // PC13 主断言：wsl.exe 自身英文错误消息按 UTF-16 → 系统页解码的形态（含 '.' 与 \0）必须拒绝
            string wslMojibake = "T\0h\0e\0r\0e\0 \0i\0s\0 \0n\0o\0 \0d\0i\0s\0t\0r\0i\0b\0u\0t\0i\0o\0n\0.\0";
            Check(!ProcessContract.LooksLikeVersionText(wslMojibake), "PC13 场景复现：wsl UTF-16 错误乱码拒绝（旧判定误放行）");
            Check(ProcessContract.LooksLikeVersionText("v1.2 "), "尾随空白容忍（前缀命中）");

            // ⑤ MergeStderr（用户可见 CLI 操作契约）
            Console.WriteLine("-- ⑤ MergeStderr --");
            CliResult merged = ProcessContract.RunProcess("cmd.exe", "/c echo out-msg& echo err-msg 1>&2", new CliOptions { TimeoutMs = 15000, MergeStderr = true });
            Check(merged.Output != null && merged.Output.Contains("out-msg"), "合并模式 stdout 可见");
            Check(merged.Output != null && merged.Output.Contains("err-msg"), "合并模式 stderr 可见（错误不静默）");
            CliResult probeOnly = ProcessContract.RunProcess("cmd.exe", "/c echo out-msg& echo err-msg 1>&2", new CliOptions { TimeoutMs = 15000, MergeStderr = false });
            Check(probeOnly.Output != null && probeOnly.Output.Contains("out-msg"), "探测模式 stdout 可见");
            Check(probeOnly.Output == null || !probeOnly.Output.Contains("err-msg"), "探测模式 stderr 不混入（版本解析不受污染）");

            // ⑥ 超时档位
            Console.WriteLine("-- ⑥ 超时档位 --");
            Check(ProcessContract.ProbeTimeoutMs == 15000, "探测档 15s（冷启动慢≠未安装）");
            Check(ProcessContract.PanelCliTimeoutMs == 30000, "面板 CLI 档 30s");
            Check(ProcessContract.InstallTimeoutMs == 180000, "安装档 180s");
            Check(ProcessContract.NetInstallTimeoutMs == 600000, "网络安装档 600s");
            Check(ProcessContract.ProbeTimeoutMs < ProcessContract.PanelCliTimeoutMs, "探测 < 面板");
            Check(ProcessContract.PanelCliTimeoutMs < ProcessContract.InstallTimeoutMs, "面板 < 安装");
            Check(ProcessContract.InstallTimeoutMs < ProcessContract.NetInstallTimeoutMs, "安装 < 网络安装");

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
