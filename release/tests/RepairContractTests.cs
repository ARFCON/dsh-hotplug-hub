// RepairContractTests.cs — 「修复配置」契约行为断言（CI 必须全绿）
//
// 锁定 RepairContract 单一真源，回归 Main.cs RepairDshConfig 内联实现的缺陷：
//   ① RemoveDuplicateYamlKeys —— 同父作用域重复键去重（含列表项/块标量/嵌套作用域/跨空行注释）；
//   ② FlattenCredentialsYaml —— version/refs 包裹扁平化（含 version 误判/冒号值/头行变体/嵌套保守/注释保留）。
//
// 编译：csc /nologo /target:exe /out:RepairContractTests.exe RepairContract.cs RepairContractTests.cs
// 运行：RepairContractTests.exe（非零退出 = 存在失败断言）
using System;
using System.Collections.Generic;

namespace DSHHotplugHub
{
    public static class RepairContractTestRunner
    {
        public static int Main()
        {
            try
            {
                return RepairContractTests.Run();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 2;
            }
        }
    }

    public static class RepairContractTests
    {
        private static int _failures = 0;
        private static int _passes = 0;

        private static void Check(bool cond, string name)
        {
            if (cond) { _passes++; Console.WriteLine("  PASS " + name); }
            else { _failures++; Console.WriteLine("  FAIL " + name); }
        }

        private static bool EqLines(string[] actual, string[] expected)
        {
            if (actual == null || expected == null) return false;
            if (actual.Length != expected.Length) return false;
            for (int i = 0; i < actual.Length; i++)
            {
                if (actual[i] != expected[i]) return false;
            }
            return true;
        }

        private static string[] L(params string[] lines) { return lines; }

        public static int Run()
        {
            Console.WriteLine("== RepairContract 契约测试（修复配置：settings.yaml / .credentials.yaml） ==");

            // ① RemoveDuplicateYamlKeys —— 同层连续重复键
            Console.WriteLine("-- ① RemoveDuplicateYamlKeys 同层重复键 --");
            int removed;
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("model: a", "model: b"), out removed), L("model: a")) && removed == 1, "连续重复键 → 保留第一个，removed=1");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("model: deepseek-chat", "model: deepseek-reasoner"), out removed), L("model: deepseek-chat")) && removed == 1, "重复键（真实 settings 场景）保留首个值");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("a: 1", "a: 2", "a: 3"), out removed), L("a: 1")) && removed == 2, "三连重复 → 仅保留第一个，removed=2");

            // ② 跨空行/注释的重复键（旧实现只比较紧邻上一行 → 漏检）
            Console.WriteLine("-- ② RemoveDuplicateYamlKeys 跨空行/注释的重复键 --");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("model: a", "", "model: b"), out removed), L("model: a", "")) && removed == 1, "空行不阻断重复键检测（旧实现漏检）");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("model: a", "# note", "model: b"), out removed), L("model: a", "# note")) && removed == 1, "注释不阻断重复键检测（旧实现漏检）");

            // ③ 嵌套作用域：不同父下同键不去重，同父下同键去重
            Console.WriteLine("-- ③ RemoveDuplicateYamlKeys 嵌套作用域 --");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("server:", "  host: a", "client:", "  host: b"), out removed), L("server:", "  host: a", "client:", "  host: b")) && removed == 0, "不同父下同键不去重（server.host vs client.host）");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("server:", "  host: a", "  host: b"), out removed), L("server:", "  host: a")) && removed == 1, "同父下同键去重");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("a: x", "  a: y"), out removed), L("a: x", "  a: y")) && removed == 0, "不同缩进同键不去重（顶层 a vs 嵌套 a）");

            // ④ 列表项 / 非映射行 / 块标量（旧实现误删的回归）
            Console.WriteLine("-- ④ RemoveDuplicateYamlKeys 列表项与非映射行（旧实现误删） --");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("- foo", "- foo"), out removed), L("- foo", "- foo")) && removed == 0, "列表项 - foo 不去重（旧实现误删第二个合法列表项）");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("- name: a", "- name: a"), out removed), L("- name: a", "- name: a")) && removed == 0, "列表内映射 - name: a 不去重");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("model: a", "- item", "model: b"), out removed), L("model: a", "- item")) && removed == 1, "列表项为非映射行，不阻断同层重复键检测");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("model: a", "name: x", "model: b"), out removed), L("model: a", "name: x")) && removed == 1, "同层间插其它键仍检测到重复（model 出现两次）");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("prompt: |", "  The answer is 42", "  The answer is 42"), out removed), L("prompt: |", "  The answer is 42", "  The answer is 42")) && removed == 0, "块标量字面内容不去重（旧实现误删）");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("prompt: |", "  a: 1", "  a: 1"), out removed), L("prompt: |", "  a: 1", "  a: 1")) && removed == 0, "块标量内容含冒号也不去重");

            // ⑤ 键含冒号值
            Console.WriteLine("-- ⑤ RemoveDuplicateYamlKeys 冒号值 --");
            Check(EqLines(RepairContract.RemoveDuplicateYamlKeys(L("url: http://a", "url: http://b"), out removed), L("url: http://a")) && removed == 1, "值为 URL 的重复键仍去重（key 取首个冒号前）");

            // 空输入
            Check(RepairContract.RemoveDuplicateYamlKeys(null, out removed).Length == 0, "null 输入 → 空数组");
            Check(RepairContract.RemoveDuplicateYamlKeys(new string[0], out removed).Length == 0, "空数组 → 空数组");

            // ⑥ FlattenCredentialsYaml —— version/refs 包裹扁平化
            Console.WriteLine("-- ⑥ FlattenCredentialsYaml 包裹扁平化 --");
            bool flattened;
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("version: \"1\"", "refs:", "  k: v"), out flattened), L("k: v")) && flattened, "version/refs 包裹 → 扁平为 k: v");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("version: 1", "refs:", "  a: 1", "  b: 2"), out flattened), L("a: 1", "b: 2")) && flattened, "多条凭证条目全部提升顶层");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("refs:", "  k: a:b:c"), out flattened), L("k: a:b:c")) && flattened, "凭证值含冒号不被截断");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("foo: bar", "version: 1", "refs:", "  k: v"), out flattened), L("foo: bar", "k: v")) && flattened, "顶层既有条目原样保留 + 包裹条目提升");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("refs:", "  # note", "  k: v"), out flattened), L("# note", "k: v")) && flattened, "包裹内注释保留（旧实现丢弃）");

            // ⑦ 头行变体（旧实现 StartsWith("version:") 漏判 `version :`）
            Console.WriteLine("-- ⑦ FlattenCredentialsYaml 头行变体 --");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("version : \"1\"", "refs:", "  k: v"), out flattened), L("k: v")) && flattened, "`version :`（冒号前空格）也识别为头行");

            // ⑧ 无包裹 / version 单独存在 / 嵌套结构（旧实现误判/破坏）
            Console.WriteLine("-- ⑧ FlattenCredentialsYaml 无包裹不破坏 --");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("a: 1", "b: 2"), out flattened), L("a: 1", "b: 2")) && !flattened, "纯扁平凭证原样返回，flattened=false");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("version: sk-xxx", "other: sk-yyy"), out flattened), L("version: sk-xxx", "other: sk-yyy")) && !flattened, "仅 version 无 refs → 不扁平化（旧实现会销毁 version 凭证）");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("refs: {}", "other: v"), out flattened), L("refs: {}", "other: v")) && !flattened, "内联 refs: {} 非块头 → 不扁平化");
            Check(EqLines(RepairContract.FlattenCredentialsYaml(L("refs:", "  groupA:", "    key1: v1"), out flattened), L("refs:", "  groupA:", "    key1: v1")) && !flattened, "嵌套 refs（缩进≥4）超出扁平契约 → 保守不改写");
            Check(RepairContract.FlattenCredentialsYaml(null, out flattened).Length == 0 && !flattened, "null 输入 → 空数组");

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
