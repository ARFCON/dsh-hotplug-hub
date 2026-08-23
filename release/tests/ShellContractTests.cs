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
using System.Threading;

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

        // 两元素 {w,h} 判定（ClampWindowSize 返回）
        private static bool Eq2(int[] a, int w, int h)
        {
            return a != null && a.Length == 2 && a[0] == w && a[1] == h;
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

            // ⑤ ResolveShowWindowState 聚焦状态决议
            Console.WriteLine("-- ⑤ ResolveShowWindowState 聚焦状态决议 --");
            Check(ShellContract.ResolveShowWindowState(ShellContract.WS_MINIMIZED) == ShellContract.WS_NORMAL, "最小化 → 还原 Normal");
            Check(ShellContract.ResolveShowWindowState(ShellContract.WS_NORMAL) == ShellContract.WS_NORMAL, "Normal 原样保持");
            Check(ShellContract.ResolveShowWindowState(ShellContract.WS_MAXIMIZED) == ShellContract.WS_MAXIMIZED, "最大化保持（旧 ShowMainForm 会降级为 Normal）");
            Check(ShellContract.WS_NORMAL == 0 && ShellContract.WS_MINIMIZED == 1 && ShellContract.WS_MAXIMIZED == 2, "状态码与 FormWindowState 数值一致");

            // ⑥ ClampWindowSize 屏幕尺寸钳制
            Console.WriteLine("-- ⑥ ClampWindowSize 屏幕尺寸钳制 --");
            Check(Eq2(ShellContract.ClampWindowSize(1240, 820, 900, 600, 1920, 1080), 1240, 820), "屏内尺寸原样（1240×820 ∈ [900×600,1920×1080]）");
            Check(Eq2(ShellContract.ClampWindowSize(3840, 2160, 900, 600, 1920, 1080), 1920, 1080), "4K 保存 → 1080p 钳制到屏（旧实现越界不可恢复）");
            Check(Eq2(ShellContract.ClampWindowSize(500, 400, 900, 600, 1920, 1080), 900, 600), "低于 min 抬升到 min");
            Check(Eq2(ShellContract.ClampWindowSize(900, 600, 900, 600, 800, 600), 900, 600), "max<min（极小屏）以 min 兜底");
            Check(Eq2(ShellContract.ClampWindowSize(2000, 700, 900, 600, 1920, 1080), 1920, 700), "仅宽度越界 → 只钳宽度，高度原样");
            Check(Eq2(ShellContract.ClampWindowSize(1240, 2000, 900, 600, 1920, 1080), 1240, 1080), "仅高度越界 → 只钳高度，宽度原样");
            Check(ShellContract.ClampWindowSize(100, 100, 900, 600, 1920, 1080).Length == 2, "钳制结果恒为两元素 {w,h}");

            // ⑦ HitTestResizeEdge 无边框边缘命中（主窗无标题栏 titleBarH=0）
            Console.WriteLine("-- ⑦ HitTestResizeEdge 无边框边缘命中 --");
            // 主窗（无标题栏，webView 四周边距 6px）：顶部可调边 = y∈[0,6]
            Check(ShellContract.HitTestResizeEdge(3, 3, 1240, 820, 6, 0) == ShellContract.HT_TOPLEFT, "主窗 左上角");
            Check(ShellContract.HitTestResizeEdge(1237, 3, 1240, 820, 6, 0) == ShellContract.HT_TOPRIGHT, "主窗 右上角");
            Check(ShellContract.HitTestResizeEdge(3, 817, 1240, 820, 6, 0) == ShellContract.HT_BOTTOMLEFT, "主窗 左下角");
            Check(ShellContract.HitTestResizeEdge(1237, 817, 1240, 820, 6, 0) == ShellContract.HT_BOTTOMRIGHT, "主窗 右下角");
            Check(ShellContract.HitTestResizeEdge(3, 400, 1240, 820, 6, 0) == ShellContract.HT_LEFT, "主窗 左缘");
            Check(ShellContract.HitTestResizeEdge(1237, 400, 1240, 820, 6, 0) == ShellContract.HT_RIGHT, "主窗 右缘");
            Check(ShellContract.HitTestResizeEdge(600, 3, 1240, 820, 6, 0) == ShellContract.HT_TOP, "主窗 顶缘");
            Check(ShellContract.HitTestResizeEdge(600, 817, 1240, 820, 6, 0) == ShellContract.HT_BOTTOM, "主窗 底缘");
            Check(ShellContract.HitTestResizeEdge(600, 400, 1240, 820, 6, 0) == 0, "主窗 中心 → 客户区");

            // harness 窗（36px 标题栏）：顶部可调边 = 标题栏下缘 y∈[36,42]，而非旧的 y∈[0,6]
            Check(ShellContract.HitTestResizeEdge(3, 37, 1280, 800, 6, 36) == ShellContract.HT_TOPLEFT, "harness 左上角（标题栏下缘）");
            Check(ShellContract.HitTestResizeEdge(1277, 37, 1280, 800, 6, 36) == ShellContract.HT_TOPRIGHT, "harness 右上角（标题栏下缘）");
            Check(ShellContract.HitTestResizeEdge(600, 37, 1280, 800, 6, 36) == ShellContract.HT_TOP, "harness 顶缘（标题栏下 6px 空隙，旧实现命中死区）");
            Check(ShellContract.HitTestResizeEdge(600, 42, 1280, 800, 6, 36) == ShellContract.HT_TOP, "harness 顶缘下界（含 42）");
            Check(ShellContract.HitTestResizeEdge(600, 20, 1280, 800, 6, 36) == 0, "harness 标题栏内部 y=20 → 客户区（交拖拽，旧实现误判为顶缘 resize）");
            Check(ShellContract.HitTestResizeEdge(3, 20, 1280, 800, 6, 36) == ShellContract.HT_LEFT, "harness 标题栏左侧 y=20 → 左缘（沿旧语义，仅顶缘修正）");
            Check(ShellContract.HitTestResizeEdge(3, 797, 1280, 800, 6, 36) == ShellContract.HT_BOTTOMLEFT, "harness 左下角");

            // ⑧ TryAcquireSingleInstance 单实例互斥（含弃置互斥接管）
            Console.WriteLine("-- ⑧ TryAcquireSingleInstance 单实例互斥 --");
            string siName = "dsh-si-test-" + Guid.NewGuid().ToString("N");
            Mutex first;
            Check(ShellContract.TryAcquireSingleInstance(siName, out first), "首次获取成功");
            Check(first != null, "首次获取返回有效句柄");

            // 另一线程模拟「第二实例」跨线程争用同名互斥（主线程已持有）→ 必须获取失败。
            // 注意：Mutex 对同一线程可重入（同线程二次 WaitOne 会成功），故必须用异线程模拟「另一实例」。
            bool secondAcquired = true;
            Mutex second = null;
            using (ManualResetEvent secondDone = new ManualResetEvent(false))
            {
                Thread tSecond = new Thread(delegate ()
                {
                    Mutex m2;
                    secondAcquired = ShellContract.TryAcquireSingleInstance(siName, out m2);
                    second = m2;
                    secondDone.Set();
                });
                tSecond.Start();
                secondDone.WaitOne();
                tSecond.Join();
            }
            Check(!secondAcquired, "已有存活实例 → 二次获取失败（跨线程）");
            Check(second == null, "失败时句柄为 null");

            try { first.ReleaseMutex(); } catch { /* 有意吞掉 */ }
            first.Dispose();
            Mutex third;
            Check(ShellContract.TryAcquireSingleInstance(siName, out third), "释放后可再次获取");
            try { third.ReleaseMutex(); } catch { /* 有意吞掉 */ }
            third.Dispose();

            // 弃置互斥：线程获取命名互斥后不释放直接终止（模拟进程崩溃/被强杀）
            string abName = "dsh-si-abandon-" + Guid.NewGuid().ToString("N");
            bool keeperCreated;
            Mutex keeper = new Mutex(false, abName, out keeperCreated); // 主线程持句柄，防互斥对象被销毁
            using (ManualResetEvent started = new ManualResetEvent(false))
            {
                Thread t = new Thread(delegate ()
                {
                    bool tCreated;
                    Mutex m = new Mutex(false, abName, out tCreated);
                    m.WaitOne();
                    started.Set();
                    // 不 ReleaseMutex、不 Dispose，线程直接结束 → 互斥弃置
                });
                t.Start();
                started.WaitOne();
                t.Join();
            }
            Mutex takeover;
            Check(ShellContract.TryAcquireSingleInstance(abName, out takeover), "接管崩溃遗留的弃置互斥（旧实现永远启动失败）");
            if (takeover != null) { try { takeover.ReleaseMutex(); } catch { /* 有意吞掉 */ } takeover.Dispose(); }
            keeper.Dispose();

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
