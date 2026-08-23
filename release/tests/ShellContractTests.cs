// ShellContractTests.cs — 托盘常驻 / 窗口状态契约行为断言（CI 必须全绿）
//
// 覆盖（锁定 ShellContract 单一真源，回归此前 Main.cs 内联实现的缺陷）：
//   ① SerializeWindowState / ParseWindowState 往返（含 max=1 最大化标志，曾恒为 0）；
//   ② ParseWindowState 最小尺寸门槛 + 非法输入（空/非数字/缺段/低于门槛）；
//   ③ ResolveWindowState 三态决议（正常取 Bounds、最大化取 RestoreBounds+max、最小化取 RestoreBounds）；
//   ④ ShouldHideToTray（托盘可用+非退出 → 藏托盘；托盘不可用/显式退出 → 放行关闭）。
//
// 编译：csc /nologo /target:exe /out:ShellContractTests.exe ShellContract.cs ShellContractTests.cs
// 运行：ShellContractTests.exe（非零退出 = 存在失败断言）
using System;

namespace DSHHotplugHub
{
    public static class ShellContractTestRunner
    {
        public static int Main()
        {
            try
            {
                return ShellContractTests.Run();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 2;
            }
        }
    }

    public static class ShellContractTests
    {
        private static int _failures = 0;
        private static int _passes = 0;

        private static void Check(bool cond, string name)
        {
            if (cond) { _passes++; Console.WriteLine("  PASS " + name); }
            else { _failures++; Console.WriteLine("  FAIL " + name); }
        }

        private static bool Eq(int[] a, int w, int h, int max)
        {
            return a != null && a.Length == 3 && a[0] == w && a[1] == h && a[2] == max;
        }

        public static int Run()
        {
            Console.WriteLine("== ShellContract 契约测试（托盘常驻 / 窗口状态） ==");

            // ① 序列化 / 解析往返（含最大化标志）
            Console.WriteLine("-- ① SerializeWindowState / ParseWindowState 往返 --");
            Check(ShellContract.SerializeWindowState(1240, 820, false) == "1240|820|0", "序列化 非最大化=0");
            Check(ShellContract.SerializeWindowState(1240, 820, true) == "1240|820|1", "序列化 最大化=1（旧 MainForm 恒为 0）");
            Check(Eq(ShellContract.ParseWindowState("1240|820|0", 900, 600), 1240, 820, 0), "解析 非最大化");
            Check(Eq(ShellContract.ParseWindowState("1240|820|1", 900, 600), 1240, 820, 1), "解析 最大化标志=1（旧实现永不写入）");
            Check(Eq(ShellContract.ParseWindowState(" 1240 | 820 | 1 ", 900, 600), 1240, 820, 1), "解析 容忍空白");
            Check(Eq(ShellContract.ParseWindowState("1240|820", 900, 600), 1240, 820, 0), "解析 缺第三段 → max=0");

            // ② 最小尺寸门槛 + 非法输入
            Console.WriteLine("-- ② ParseWindowState 门槛与非法输入 --");
            Check(Eq(ShellContract.ParseWindowState("900|600|0", 900, 600), 900, 600, 0), "解析 恰好门槛通过");
            Check(ShellContract.ParseWindowState("899|600|0", 900, 600) == null, "解析 低于 minW 拒绝");
            Check(ShellContract.ParseWindowState("900|599|0", 900, 600) == null, "解析 低于 minH 拒绝");
            Check(ShellContract.ParseWindowState("", 900, 600) == null, "解析 空串拒绝");
            Check(ShellContract.ParseWindowState(null, 900, 600) == null, "解析 null 拒绝");
            Check(ShellContract.ParseWindowState("abc|600|0", 900, 600) == null, "解析 非数字拒绝");
            Check(ShellContract.ParseWindowState("900", 900, 600) == null, "解析 缺段拒绝");

            // ③ ResolveWindowState 三态决议
            Console.WriteLine("-- ③ ResolveWindowState 三态决议 --");
            Check(Eq(ShellContract.ResolveWindowState(true, false, 1240, 820, 900, 700), 1240, 820, 0), "正常态取 Bounds + max=0");
            Check(Eq(ShellContract.ResolveWindowState(false, true, 1920, 1080, 1240, 820), 1240, 820, 1), "最大化取 RestoreBounds + max=1");
            Check(Eq(ShellContract.ResolveWindowState(false, false, 200, 200, 1240, 820), 1240, 820, 0), "最小化取 RestoreBounds + max=0");

            // ④ ShouldHideToTray 关闭语义
            Console.WriteLine("-- ④ ShouldHideToTray 关闭语义 --");
            Check(ShellContract.ShouldHideToTray(true, false), "托盘可用 + 非退出 → 藏托盘");
            Check(!ShellContract.ShouldHideToTray(false, false), "托盘不可用 → 放行关闭（旧实现会隐藏导致不可恢复）");
            Check(!ShellContract.ShouldHideToTray(true, true), "显式退出 → 放行关闭");
            Check(!ShellContract.ShouldHideToTray(false, true), "托盘不可用 + 显式退出 → 放行关闭");

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
