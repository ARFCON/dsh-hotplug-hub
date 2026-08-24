// CoreTests.cs — DSH 桌面卸载器纯逻辑（Core.cs）行为断言（CI 必须全绿）
//
// Core.cs 的公共类型（PureHelpers / NameMatcher / VariantCatalog / RetentionOptions）刻意
// 无 UI/注册表/进程 I/O，可在 csc 纯逻辑测试中直接断言。覆盖：
//   ① BuildQuotedArguments / EscapeWindowsArg（Windows 命令行引号规则）；
//   ② ParsePresetNames（逗号/分号/中文逗号分隔 + 去重 + 忽略 */all）；
//   ③ NameMatcher.EqualsToken vs ContainsToken（精确 vs 子串，锁定 HIGH-1 定向清理修复）；
//   ④ VariantCatalog.Find（仓库子串匹配、大小写、未知仓库）；
//   ⑤ RetentionOptions.Summary（保留项摘要）。
//
// 编译：csc /nologo /target:exe /out:CoreTests.exe /reference:System.dll Core.cs CoreTests.cs
// 运行：CoreTests.exe（非零退出 = 存在失败断言）
using System;
using System.Collections.Generic;

public static class CoreTestRunner
{
    public static int Main()
    {
        try
        {
            return CoreTests.Run();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
            Console.Error.WriteLine(ex.StackTrace);
            return 2;
        }
    }
}

public static class CoreTests
{
    private static int _failures = 0;
    private static int _passes = 0;

    private static void Check(bool cond, string name)
    {
        if (cond) { _passes++; Console.WriteLine("  PASS " + name); }
        else { _failures++; Console.WriteLine("  FAIL " + name); }
    }

    private static bool EqList(List<string> actual, params string[] expected)
    {
        if (actual == null || expected == null) return false;
        if (actual.Count != expected.Length) return false;
        for (int i = 0; i < expected.Length; i++)
        {
            if (actual[i] != expected[i]) return false;
        }
        return true;
    }

    public static int Run()
    {
        Console.WriteLine("== DSH 桌面卸载器 Core 契约测试 ==");

        // ① BuildQuotedArguments / EscapeWindowsArg
        Console.WriteLine("-- ① 命令行引号规则 --");
        Check(PureHelpers.BuildQuotedArguments(new[] { "a", "b" }) == "a b", "无空格不加引号");
        Check(PureHelpers.BuildQuotedArguments(new[] { "a b" }) == "\"a b\"", "含空格加引号");
        Check(PureHelpers.BuildQuotedArguments(new[] { "" }) == "\"\"", "空参数转空引号");
        Check(PureHelpers.BuildQuotedArguments(new[] { "a\"b" }) == "\"a\\\"b\"", "内嵌引号转义");
        Check(PureHelpers.BuildQuotedArguments(new[] { "C:\\path with space\\" }) == "\"C:\\path with space\\\\\"", "尾随反斜杠双写（标准 Windows 规则）");
        Check(PureHelpers.EscapeWindowsArg("a\\b\"c") == "a\\b\\\"c", "EscapeWindowsArg 反斜杠+引号");
        Check(PureHelpers.BuildQuotedArguments(null) == "", "null 参数数组 → 空串");
        Check(PureHelpers.BuildQuotedArguments(new string[0]) == "", "空参数数组 → 空串");

        // ② ParsePresetNames
        Console.WriteLine("-- ② ParsePresetNames 解析 + 去重 --");
        Check(EqList(PureHelpers.ParsePresetNames("a,b,c"), "a", "b", "c"), "逗号分隔");
        Check(EqList(PureHelpers.ParsePresetNames("a;b;c"), "a", "b", "c"), "分号分隔");
        Check(EqList(PureHelpers.ParsePresetNames("a,b，c"), "a", "b", "c"), "中文逗号分隔");
        Check(EqList(PureHelpers.ParsePresetNames("a, A"), "a"), "去重（大小写不同，旧实现产生重复）");
        Check(EqList(PureHelpers.ParsePresetNames("a,a,b"), "a", "b"), "去重（同项重复）");
        Check(EqList(PureHelpers.ParsePresetNames(" a , b "), "a", "b"), "去首尾空白");
        Check(EqList(PureHelpers.ParsePresetNames("*"), new string[0]), "忽略 *");
        Check(EqList(PureHelpers.ParsePresetNames("all"), new string[0]), "忽略 all");
        Check(EqList(PureHelpers.ParsePresetNames(""), new string[0]), "空串 → 空列表");
        Check(EqList(PureHelpers.ParsePresetNames(null), new string[0]), "null → 空列表");

        // ③ NameMatcher.EqualsToken vs ContainsToken（HIGH-1 定向清理）
        Console.WriteLine("-- ③ 名称匹配：精确 vs 子串 --");
        Check(NameMatcher.EqualsToken("DSH Desktop", new[] { "DSH Desktop" }), "EqualsToken 完全相等 → true");
        Check(!NameMatcher.EqualsToken("DSH Desktop Hub", new[] { "DSH Desktop" }), "EqualsToken：DSH Desktop ≠ DSH Desktop Hub");
        Check(!NameMatcher.EqualsToken("DSH Desk", new[] { "DSH Desktop" }), "EqualsToken：DSH Desk ≠ DSH Desktop");
        Check(NameMatcher.ContainsToken("DSH Desktop Hub", new[] { "DSH Desktop" }), "ContainsToken 子串会命中（正是定向清理需避免的语义）");
        Check(!NameMatcher.EqualsToken("dsh-desktop", new[] { "dsh-desktop-hub" }), "EqualsToken：dsh-desktop ≠ dsh-desktop-hub");

        // ④ VariantCatalog.Find
        Console.WriteLine("-- ④ 变体目录查找 --");
        Check(VariantCatalog.Find("deepseek-ai/deepseek-harness") != null && VariantCatalog.Find("deepseek-ai/deepseek-harness").Repo == "deepseek-ai", "官方仓库命中");
        Check(VariantCatalog.Find("DEEPSEEK-AI/x") != null && VariantCatalog.Find("DEEPSEEK-AI/x").Repo == "deepseek-ai", "仓库匹配大小写不敏感");
        Check(VariantCatalog.Find("myyangyunfan/dsh_desktop") != null && VariantCatalog.Find("myyangyunfan/dsh_desktop").Repo == "myyangyunfan", "第三方仓库命中");
        Check(VariantCatalog.Find("unknown-repo/x") == null, "未知仓库 → null");
        Check(VariantCatalog.Find("") == null, "空仓库 → null");
        Check(VariantCatalog.Find(null) == null, "null → null");

        // ⑤ RetentionOptions.Summary
        Console.WriteLine("-- ⑤ 保留项摘要 --");
        var r = new RetentionOptions();
        Check(r.Summary() == "(none)", "默认无保留 → (none)");
        r.Presets = true;
        r.ChatData = true;
        string s = r.Summary();
        Check(s.IndexOf(".agent-presets", StringComparison.Ordinal) >= 0 && s.IndexOf("聊天数据", StringComparison.Ordinal) >= 0, "预设 + 聊天数据摘要含两者");
        var r2 = new RetentionOptions();
        r2.Runtime = true;
        Check(r2.Summary().IndexOf(".dsh-runtime", StringComparison.Ordinal) >= 0, "运行时摘要");

        Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
        return _failures == 0 ? 0 : 1;
    }
}
