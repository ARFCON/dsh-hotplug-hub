// ShellContract.cs — 桌面外壳（托盘常驻 / 窗口状态）契约的单一真源
//
// 与 Main.cs 的托盘生命周期、单实例互斥、窗口状态持久化逻辑对齐，
// 消除此前三处各自手写 `w|h|max` 序列化的分歧：
//   · MainForm.SaveWindowState 曾「最大化时跳过保存 + max 恒为 0」，导致
//     LoadWindowState 的「恢复最大化」成为死代码（见 tests/ShellContractTests.cs 锁定）；
//   · 托盘创建失败时仍「隐藏到托盘」会让窗口不可恢复（无托盘图标/任务栏/窗口），
//     由 ShouldHideToTray 统一兜底：托盘不可用 → 放行关闭（退出）。
using System;

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
    }
}
