// ShellContract.cs — 桌面外壳（托盘常驻 / 窗口状态）契约的单一真源
//
// 与 Main.cs 的托盘生命周期、单实例互斥、窗口状态持久化逻辑对齐，
// 消除此前三处各自手写 `w|h|max` 序列化的分歧：
//   · MainForm.SaveWindowState 曾「最大化时跳过保存 + max 恒为 0」，导致
//     LoadWindowState 的「恢复最大化」成为死代码（见 tests/ShellContractTests.cs 锁定）；
//   · 托盘创建失败时仍「隐藏到托盘」会让窗口不可恢复（无托盘图标/任务栏/窗口），
//     由 ShouldHideToTray 统一兜底：托盘不可用 → 放行关闭（退出）。
using System;
using System.Threading;

namespace DSHHotplugHub
{
    /// <summary>桌面外壳契约（窗口状态持久化 + 托盘关闭语义），供 Main.cs 三处窗体共用。</summary>
    public static class ShellContract
    {
        /// <summary>序列化窗口状态：`&lt;w&gt;|&lt;h&gt;|&lt;max&gt;`（max=1 表示上次最大化关闭）。</summary>
        public static string SerializeWindowState(int w, int h, bool maximized)
        {
            return w + "|" + h + "|" + (maximized ? "1" : "0");
        }

        /// <summary>解析窗口状态：返回 {w,h,max}；格式非法或尺寸低于最小阈值 → null。
        /// 与 MainForm.LoadWindowState / HarnessHostForm.LoadState / BorderlessHarnessForm.LoadState 的
        /// 原判定语义一致（int.TryParse + 最小尺寸门槛 + max 仅当第三段为 "1"）。</summary>
        public static int[] ParseWindowState(string text, int minW, int minH)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string[] parts = text.Trim().Split('|');
            if (parts.Length < 2) return null;
            int w, h;
            if (!int.TryParse(parts[0].Trim(), out w) || !int.TryParse(parts[1].Trim(), out h)) return null;
            if (w < minW || h < minH) return null;
            int max = (parts.Length >= 3 && parts[2].Trim() == "1") ? 1 : 0;
            return new int[] { w, h, max };
        }

        /// <summary>持久化尺寸决议：正常态取当前 Bounds；最大化/最小化态取 RestoreBounds
        /// （用户拖到的大小），最大化另记 max=1。返回 {w,h,max}。</summary>
        public static int[] ResolveWindowState(bool isNormal, bool isMaximized, int boundsW, int boundsH, int restoreW, int restoreH)
        {
            int w = isNormal ? boundsW : restoreW;
            int h = isNormal ? boundsH : restoreH;
            int max = isMaximized ? 1 : 0;
            return new int[] { w, h, max };
        }

        /// <summary>关闭语义：托盘可用且非显式退出 → 隐藏到托盘（常驻）；
        /// 否则（托盘不可用 / 显式退出）→ 放行关闭。避免托盘失败时窗口无任何恢复途径。</summary>
        public static bool ShouldHideToTray(bool trayReady, bool allowExit)
        {
            return trayReady && !allowExit;
        }

        // ---------- 无边框窗口 chrome 契约（聚焦状态决议 / 尺寸钳制） ----------

        // 窗口显示状态码：与 System.Windows.Forms.FormWindowState 数值逐位一致
        // （Normal=0 / Minimized=1 / Maximized=2），使 ShellContract 免于依赖 WinForms 引用、
        // 可在 csc 纯逻辑测试中直接断言。
        public const int WS_NORMAL = 0, WS_MINIMIZED = 1, WS_MAXIMIZED = 2;

        /// <summary>聚焦/唤起（托盘双击、托盘菜单「打开」、跨进程 WM_*_FOCUS 广播）时的目标状态决议：
        /// 最小化 → 还原为 Normal；Normal/Maximized 原样保持。
        /// 修复旧 ShowMainForm 无条件 `WindowState=Normal`，导致「重复启动已最大化的主窗」时
        /// 把最大化窗口降级为普通窗（与 harness 窗聚焦语义分歧：harness 只还原最小化，主窗却连最大化也还原）。</summary>
        public static int ResolveShowWindowState(int currentState)
        {
            return currentState == WS_MINIMIZED ? WS_NORMAL : currentState;
        }

        /// <summary>窗口尺寸钳制：把 {w,h} 收敛到 [minW,minH] … [maxW,maxH] 区间（max 取当前屏幕工作区）。
        /// 修复极端场景：在 4K 屏保存 3840×2160 后换到 1080p 屏（或拔掉外接显示器），
        /// 恢复的窗口尺寸大于当前屏幕 → 标题栏/边缘越出屏幕外不可拖动恢复。
        /// max &lt; min 时（极小屏）以 min 为准兜底（WinForms MinimumSize 同样强制）。</summary>
        public static int[] ClampWindowSize(int w, int h, int minW, int minH, int maxW, int maxH)
        {
            if (maxW < minW) maxW = minW;
            if (maxH < minH) maxH = minH;
            int cw = Math.Min(Math.Max(w, minW), maxW);
            int ch = Math.Min(Math.Max(h, minH), maxH);
            return new int[] { cw, ch };
        }

        // ---------- 无边框窗口边缘命中（WM_NCHITTEST 单一真源） ----------

        // Win32 命中测试码（与 user32 HT* 常量一致；0 = HTCLIENT 交予子控件/默认处理）
        public const int HT_LEFT = 10, HT_RIGHT = 11, HT_TOP = 12,
                         HT_TOPLEFT = 13, HT_TOPRIGHT = 14,
                         HT_BOTTOM = 15, HT_BOTTOMLEFT = 16, HT_BOTTOMRIGHT = 17;

        /// <summary>无边框窗口边缘命中：x/y 为客户端坐标，border 为可调边框宽，titleBarH 为顶部标题栏高度（无标题栏传 0）。
        /// 顶部可调边位于标题栏下缘 [titleBarH, titleBarH+border]，与主窗（无标题栏 [0,border]）语义统一。
        /// 修复旧实现三处各自手写 `top = y &lt;= border`，使 harness 窗（含 36px 标题栏）顶部可调边
        /// 错位到标题栏内部（y&lt;=6），标题栏下方真正的 6px 空隙反而变成既不能拖动也不能缩放的死区。
        /// 返回 Win32 HT* 码；命中客户区返回 0。</summary>
        public static int HitTestResizeEdge(int x, int y, int clientW, int clientH, int border, int titleBarH)
        {
            bool left = x <= border;
            bool right = x >= clientW - border;
            bool top = y >= titleBarH && y <= titleBarH + border;
            bool bottom = y >= clientH - border;
            if (left && top) return HT_TOPLEFT;
            if (right && top) return HT_TOPRIGHT;
            if (left && bottom) return HT_BOTTOMLEFT;
            if (right && bottom) return HT_BOTTOMRIGHT;
            if (left) return HT_LEFT;
            if (right) return HT_RIGHT;
            if (top) return HT_TOP;
            if (bottom) return HT_BOTTOM;
            return 0;
        }

        // ---------- 单实例互斥（含崩溃遗留「弃置互斥」接管） ----------

        /// <summary>获取单实例互斥：返回 true 表示本进程成为唯一实例（首次创建，或接管了上一实例
        /// 崩溃遗留的弃置互斥）；false 表示已有存活实例（调用方应唤起对方并退出）。
        /// mutex 仅在返回 true 时有效（已获取所有权），调用方须 ReleaseMutex + Dispose 释放。
        /// 修复旧 `new Mutex(true, name, out createdNew)` 无法接管弃置互斥：进程崩溃/被强杀后，
        /// 命名互斥仍被「死进程」持有，后续启动永远命中 `!createdNew` 分支 → 主程序/DSH 独立程序
        /// 再也无法启动（只能重启系统）。零超时 WaitOne 可立即接管弃置互斥并抛 AbandonedMutexException。</summary>
        public static bool TryAcquireSingleInstance(string name, out Mutex mutex)
        {
            bool createdNew;
            mutex = new Mutex(false, name, out createdNew);
            bool acquired = false;
            try
            {
                acquired = mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                acquired = true; // 弃置互斥：上一实例崩溃遗留，本实例接管
            }
            if (!acquired)
            {
                mutex.Dispose();
                mutex = null;
                return false;
            }
            return true;
        }
    }
}
