// InstallUninstallContractTests.cs — 安装/卸载契约行为断言（CI 必须全绿）
//
// 锁定 InstallUninstallContract 单一真源，回归安装器 AddToUserPath 与卸载器 PATH 清理的缺陷：
//   ① MergePathEntry —— 去重（大小写/尾斜杠/%VAR%）+ 前置插入；
//   ② RemovePathEntry —— 移除（大小写/尾斜杠不敏感）；
//   ③ IsPathEntryUnderDir —— 目录下条目判定（含边界：不误判兄弟目录）；
//   ④ MatchesExactName —— 精确匹配（杜绝 DSH Desk ⊂ DSH Desktop 误命中）。
//
// 编译：csc /nologo /target:exe /out:InstallUninstallContractTests.exe InstallUninstallContract.cs InstallUninstallContractTests.cs
// 运行：InstallUninstallContractTests.exe（非零退出 = 存在失败断言）
using System;

namespace DSHHotplugHub
{
    public static class InstallUninstallContractTestRunner
    {
        public static int Main()
        {
            try
            {
                return InstallUninstallContractTests.Run();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 2;
            }
        }
    }

    public static class InstallUninstallContractTests
    {
        private static int _failures = 0;
        private static int _passes = 0;

        private static void Check(bool cond, string name)
        {
            if (cond) { _passes++; Console.WriteLine("  PASS " + name); }
            else { _failures++; Console.WriteLine("  FAIL " + name); }
        }

        public static int Run()
        {
            Console.WriteLine("== InstallUninstallContract 契约测试（PATH 条目 / 名称匹配） ==");

            // ① MergePathEntry
            Console.WriteLine("-- ① MergePathEntry 前置插入 + 去重 --");
            Check(InstallUninstallContract.MergePathEntry("C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\DSH\\runtime\\node;C:\\Windows", "空档前置插入");
            Check(InstallUninstallContract.MergePathEntry("", "C:\\DSH\\runtime\\node") == "C:\\DSH\\runtime\\node", "空 PATH 仅含新条目");
            Check(InstallUninstallContract.MergePathEntry("C:\\DSH\\runtime\\node;C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\DSH\\runtime\\node;C:\\Windows", "已存在（同大小写）不重复");
            Check(InstallUninstallContract.MergePathEntry("c:\\dsh\\runtime\\node;C:\\Windows", "C:\\DSH\\runtime\\node") == "c:\\dsh\\runtime\\node;C:\\Windows", "已存在（大小写不同）不重复（旧 Contains 区分大小写→重复注入）");
            Check(InstallUninstallContract.MergePathEntry("C:\\DSH\\runtime\\node\\;C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\DSH\\runtime\\node\\;C:\\Windows", "已存在（尾反斜杠差异）不重复");
            Check(InstallUninstallContract.MergePathEntry("C:\\Windows", "") == "C:\\Windows", "空 entry 原样返回");
            Check(InstallUninstallContract.MergePathEntry(null, "C:\\x") == "C:\\x", "null PATH 视为空");
            Check(InstallUninstallContract.MergePathEntry("C:\\A;C:\\B", "C:\\C") == "C:\\C;C:\\A;C:\\B", "多段 PATH 前置插入");

            // ② RemovePathEntry
            Console.WriteLine("-- ② RemovePathEntry 移除 --");
            Check(InstallUninstallContract.RemovePathEntry("C:\\DSH\\runtime\\node;C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\Windows", "移除单条目");
            Check(InstallUninstallContract.RemovePathEntry("c:\\dsh\\runtime\\node;C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\Windows", "移除（大小写不同）");
            Check(InstallUninstallContract.RemovePathEntry("C:\\DSH\\runtime\\node\\;C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\Windows", "移除（尾反斜杠差异）");
            Check(InstallUninstallContract.RemovePathEntry("C:\\Windows", "C:\\DSH\\runtime\\node") == "C:\\Windows", "无匹配原样返回");
            Check(InstallUninstallContract.RemovePathEntry("C:\\DSH\\runtime\\node", "C:\\DSH\\runtime\\node") == "", "移除唯一条目 → 空串");
            Check(InstallUninstallContract.RemovePathEntry("", "C:\\x") == "", "空 PATH 返回空");

            // ③ IsPathEntryUnderDir
            Console.WriteLine("-- ③ IsPathEntryUnderDir 目录下条目判定 --");
            Check(InstallUninstallContract.IsPathEntryUnderDir("C:\\DSH\\runtime\\node", "C:\\DSH"), "子目录条目 → true");
            Check(InstallUninstallContract.IsPathEntryUnderDir("C:\\DSH", "C:\\DSH"), "等于目录本身 → true");
            Check(!InstallUninstallContract.IsPathEntryUnderDir("C:\\DSH-Hotplug-Hub-Other", "C:\\DSH"), "兄弟目录（前缀撞名）→ false（旧子串匹配会误删）");
            Check(!InstallUninstallContract.IsPathEntryUnderDir("C:\\DSH2\\x", "C:\\DSH"), "目录前缀撞名（DSH2）→ false");
            Check(!InstallUninstallContract.IsPathEntryUnderDir("C:\\Windows", "C:\\DSH"), "无关目录 → false");
            Check(!InstallUninstallContract.IsPathEntryUnderDir("", "C:\\DSH"), "空条目 → false");
            Check(!InstallUninstallContract.IsPathEntryUnderDir("C:\\DSH", ""), "空目录 → false");
            Check(InstallUninstallContract.IsPathEntryUnderDir("c:\\dsh\\runtime\\node", "C:\\DSH"), "大小写不同 → true");

            // ④ MatchesExactName
            Console.WriteLine("-- ④ MatchesExactName 精确匹配 --");
            Check(InstallUninstallContract.MatchesExactName("DSH Desktop", new[] { "DSH Desktop" }), "完全相等 → true");
            Check(!InstallUninstallContract.MatchesExactName("DSH Desktop Hub", new[] { "DSH Desktop" }), "DSH Desktop ⊄ DSH Desktop Hub（旧子串匹配误删另一变体）");
            Check(!InstallUninstallContract.MatchesExactName("DSH Desk", new[] { "DSH Desktop" }), "DSH Desk ≠ DSH Desktop");
            Check(!InstallUninstallContract.MatchesExactName("dsh-desktop-hub", new[] { "dsh-desktop" }), "dsh-desktop ⊄ dsh-desktop-hub");
            Check(InstallUninstallContract.MatchesExactName("dsh-desktop", new[] { "DSH-DESKTOP" }), "大小写不同相等 → true");
            Check(!InstallUninstallContract.MatchesExactName("", new[] { "DSH Desktop" }), "空值 → false");
            Check(!InstallUninstallContract.MatchesExactName("DSH Desktop", null), "null 名称数组 → false");
            Check(!InstallUninstallContract.MatchesExactName("DSH Desktop", new string[0]), "空名称数组 → false");

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
