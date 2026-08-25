// SkillContractTests.cs — Skill 管理纯逻辑契约行为断言（v1.1 桌面壳审计 PC3/PC24；CI 必须全绿）
//
// 覆盖：
//   ① ValidSkillId / SanitizeSkillName（id 语法 = 净化产出集，创建/删除/探测共用同一真源）；
//   ② SafeSkillDir 路径安全（PC3 主断言：IPC id 穿越向量一律拒绝，绝不拼接出逃逸路径）；
//   ③ ReadSkillFrontmatter（frontmatter name/description、引号剥离、无块标题回退、损坏输入兜底）；
//   ④ BuildSkillMarkdown（新建 SKILL.md 内容形态）。
//
// 编译：csc /nologo /target:exe /out:SkillContractTests.exe SkillContract.cs SkillContractTests.cs
// 运行：SkillContractTests.exe（非零退出 = 存在失败断言）
using System;
using System.IO;

namespace DSHHotplugHub
{
    public static class SkillContractTestRunner
    {
        public static int Main()
        {
            try { return SkillContractTests.Run(); }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                return 2;
            }
        }
    }

    public static class SkillContractTests
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
            Console.WriteLine("== SkillContract 契约测试（skill id 语法 / 路径安全 / frontmatter） ==");

            // ① id 语法与净化
            Console.WriteLine("-- ① ValidSkillId / SanitizeSkillName --");
            Check(SkillContract.ValidSkillId("web-search"), "合法 id");
            Check(SkillContract.ValidSkillId("a"), "单字符 id");
            Check(SkillContract.ValidSkillId("a1-b2"), "含数字/连字符 id");
            Check(!SkillContract.ValidSkillId("a_b"), "下划线拒绝（净化产物集仅 [a-z0-9-]）");
            Check(SkillContract.ValidSkillId(new string('a', 64)), "64 字符上限");
            Check(!SkillContract.ValidSkillId(new string('a', 65)), "65 字符拒绝");
            Check(!SkillContract.ValidSkillId("-abc"), "前导连字符拒绝");
            Check(!SkillContract.ValidSkillId("abc-"), "尾随连字符拒绝");
            Check(!SkillContract.ValidSkillId("A-B"), "大写拒绝（净化产物恒小写）");
            Check(!SkillContract.ValidSkillId("ab c"), "空格拒绝");
            Check(!SkillContract.ValidSkillId("ab/c"), "路径分隔符拒绝");
            Check(!SkillContract.ValidSkillId("ab\\c"), "反斜杠拒绝");
            Check(!SkillContract.ValidSkillId(".."), "点号拒绝");
            Check(!SkillContract.ValidSkillId(""), "空拒绝");
            Check(!SkillContract.ValidSkillId(null), "null 拒绝");
            Check(SkillContract.SanitizeSkillName("Web Search 2") == "web-search-2", "净化：大小写+空格");
            Check(SkillContract.SanitizeSkillName("文献管理") == "", "纯非 ASCII 净化为空（调用方 ticks 兜底）");
            Check(SkillContract.SanitizeSkillName("---___") == "", "全符号净化为空");
            Check(SkillContract.SanitizeSkillName(new string('x', 100)).Length == 64, "净化截 64");
            Check(SkillContract.SanitizeSkillName(null) == "", "null 净化为空");
            // 净化产物必须总能通过语法校验（往返闭环）
            Check(SkillContract.ValidSkillId(SkillContract.SanitizeSkillName("Any Input! 123")) , "净化产物过语法校验");
            Check(SkillContract.ValidSkillId(SkillContract.SanitizeSkillName("x")) , "最短产物过语法校验");

            // ② SafeSkillDir 路径安全（PC3 主断言）
            Console.WriteLine("-- ② SafeSkillDir（IPC id 穿越向量矩阵） --");
            string root = Path.Combine(Path.GetTempPath(), "skill-contract-test-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(root);
            Check(SkillContract.SafeSkillDir(root, "web-search") == Path.Combine(root, "web-search"), "合法 id 正常拼接");
            Check(SkillContract.SafeSkillDir(root, "..") == null, ".. 拒绝");
            Check(SkillContract.SafeSkillDir(root, "../..") == null, "../.. 拒绝");
            Check(SkillContract.SafeSkillDir(root, "..\\..\\Documents") == null, "反斜杠穿越拒绝");
            Check(SkillContract.SafeSkillDir(root, "../../Windows/System32") == null, "绝对穿越拒绝");
            Check(SkillContract.SafeSkillDir(root, "a/b") == null, "子目录 id 拒绝");
            Check(SkillContract.SafeSkillDir(root, "a\\b") == null, "反斜杠子目录拒绝");
            Check(SkillContract.SafeSkillDir(root, "C:\\evil") == null, "绝对路径 id 拒绝");
            Check(SkillContract.SafeSkillDir(root, ".hidden") == null, "前导点拒绝");
            Check(SkillContract.SafeSkillDir(root, "") == null, "空 id 拒绝");
            Check(SkillContract.SafeSkillDir(root, null) == null, "null id 拒绝");
            Check(SkillContract.SafeSkillDir(null, "ok") == null, "null root 拒绝（GetFullPath 抛异常路径由调用方 try 包裹）");
            // 组合不越界（语法白名单当前不可达越界，此断言锁定「合法输入 → 结果仍在 root 内」的不变量，
            // 为未来语法放宽时的 StartsWith 双保险提供基线）
            string subRoot = Path.Combine(root, "sub");
            Directory.CreateDirectory(subRoot);
            string inside = SkillContract.SafeSkillDir(subRoot, "ok");
            Check(inside != null && Path.GetFullPath(inside).StartsWith(Path.GetFullPath(subRoot), StringComparison.OrdinalIgnoreCase), "合法子 root 正常且结果不越界");
            // 真实场景：删除入口拿到非法 id 时必须拿不到任何路径
            string evil = "..\\..\\..\\Users";
            Check(SkillContract.SafeSkillDir(root, evil) == null, "PC3 场景复现：deleteSkill 穿越向量被拒");

            // ③ frontmatter 解析
            Console.WriteLine("-- ③ ReadSkillFrontmatter --");
            string fmFile = Path.Combine(root, "a.md");
            File.WriteAllText(fmFile, "---\nname: 我的技能\ndescription: '描述文本'\n---\n\n正文\n");
            var fm = SkillContract.ReadSkillFrontmatter(fmFile);
            Check(fm["name"] == "我的技能", "name 解析");
            Check(fm["desc"] == "描述文本", "description 解析（引号剥离）");
            File.WriteAllText(fmFile, "---\nname: \"quoted\"\ndescription: \"d2\"\n---\nx");
            fm = SkillContract.ReadSkillFrontmatter(fmFile);
            Check(fm["name"] == "quoted", "双引号剥离");
            File.WriteAllText(fmFile, "# 标题行\n\n正文");
            fm = SkillContract.ReadSkillFrontmatter(fmFile);
            Check(fm["name"] == "标题行", "无 frontmatter 回退首个标题");
            Check(fm["desc"] == "本地 Skill", "无 description 默认");
            File.WriteAllText(fmFile, "---\nbroken");
            fm = SkillContract.ReadSkillFrontmatter(fmFile);
            Check(fm["name"] == "a", "残缺 frontmatter 回退文件名");
            File.WriteAllText(fmFile, "---\r\nname: crlf-name\r\ndescription: crlf-desc\r\n---\r\n");
            fm = SkillContract.ReadSkillFrontmatter(fmFile);
            Check(fm["name"] == "crlf-name", "CRLF frontmatter 解析");
            Check(fm["desc"] == "crlf-desc", "CRLF description 解析");
            File.WriteAllText(fmFile, "---\nname: x\nunrelated: y\n---\n");
            fm = SkillContract.ReadSkillFrontmatter(fmFile);
            Check(fm["name"] == "x", "无关键跳过");
            string missing = Path.Combine(root, "missing.md");
            fm = SkillContract.ReadSkillFrontmatter(missing);
            Check(fm["name"] == "missing", "文件不存在回退文件名");
            Check(fm["desc"] == "本地 Skill", "文件不存在默认描述");

            // ④ SKILL.md 构造
            Console.WriteLine("-- ④ BuildSkillMarkdown --");
            string md = SkillContract.BuildSkillMarkdown("my-skill", "做某事");
            Check(md.StartsWith("---\n"), "frontmatter 起始");
            Check(md.Contains("name: my-skill"), "name 写入");
            Check(md.Contains("description: 做某事"), "description 写入");
            Check(md.Contains("disable-model-invocation: false"), "默认可调用");
            Check(md.TrimEnd().EndsWith("做某事"), "正文含描述");

            Directory.Delete(root, true);

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
