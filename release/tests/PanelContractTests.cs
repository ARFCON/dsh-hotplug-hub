// PanelContractTests.cs — Skill/MCP 面板数据面纯逻辑契约行为断言（v1.1 桌面壳审计 PC24；CI 必须全绿）
//
// 覆盖：
//   ① SanitizeServerName（A-Za-z0-9_-、≤32、空回退 mcp —— IPC 注入向量收敛）；
//   ② ExtractYamlValue / ExtractYamlStringList（行级标量 / 内联数组，引号剥离）；
//   ③ ExtractMcpBlock（契约 marker 优先、旧 begin/end 兼容、多 marker 截断、无块 null）；
//   ④ ParseMcpRows（- id 条目 → 行数据字段映射、disabled 识别、缺省回退）。
//
// 编译：csc /nologo /target:exe /out:PanelContractTests.exe PanelContract.cs PanelContractTests.cs
// 运行：PanelContractTests.exe（非零退出 = 存在失败断言）
using System;
using System.Collections.Generic;

namespace DSHHotplugHub
{
    public static class PanelContractTestRunner
    {
        public static int Main()
        {
            try { return PanelContractTests.Run(); }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                return 2;
            }
        }
    }

    public static class PanelContractTests
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
            Console.WriteLine("== PanelContract 契约测试（MCP/YAML 解析 / 服务器名净化） ==");

            // ① 服务器名净化
            Console.WriteLine("-- ① SanitizeServerName --");
            Check(PanelContract.SanitizeServerName("my-server") == "my-server", "合法名原样");
            Check(PanelContract.SanitizeServerName("My Server") == "My-Server", "空格转连字符");
            Check(PanelContract.SanitizeServerName("a&b|c") == "a-b-c", "元字符转连字符（注入向量收敛）");
            string sanitized = PanelContract.SanitizeServerName("../../evil");
            Check(sanitized.IndexOf('/') < 0 && sanitized.IndexOf('.') < 0 && sanitized.Contains("evil"), "穿越向量净化（分隔符全消除）");
            Check(PanelContract.SanitizeServerName(new string('x', 40)).Length == 32, "截 32");
            Check(PanelContract.SanitizeServerName("") == "mcp", "空回退 mcp");
            Check(PanelContract.SanitizeServerName(null) == "mcp", "null 回退 mcp");
            Check(PanelContract.SanitizeServerName("服务器") == "---", "纯非 ASCII 压缩为连字符（无字母可用时调用方回退 mcp）");

            // ② YAML 行级提取
            Console.WriteLine("-- ② ExtractYamlValue / ExtractYamlStringList --");
            string y = "name: plain\nserverName: 'quoted single'\nurl: \"quoted double\"\nempty:\nargs: ['a', \"b\", c]\n";
            Check(PanelContract.ExtractYamlValue(y, "name") == "plain", "裸标量");
            Check(PanelContract.ExtractYamlValue(y, "serverName") == "quoted single", "单引号剥离");
            Check(PanelContract.ExtractYamlValue(y, "url") == "quoted double", "双引号剥离");
            Check(PanelContract.ExtractYamlValue(y, "empty") == "", "空值返回空串");
            Check(PanelContract.ExtractYamlValue(y, "missing") == null, "未命中 null");
            Check(PanelContract.ExtractYamlValue(null, "k") == null, "null 文本 null");
            var args = PanelContract.ExtractYamlStringList(y, "args");
            Check(args.Count == 3, "内联数组三项");
            Check(args[0] == "a" && args[1] == "b" && args[2] == "c", "内联数组引号剥离");
            Check(PanelContract.ExtractYamlStringList(y, "name").Count == 0, "非数组键空表");
            Check(PanelContract.ExtractYamlStringList("args: []", "args").Count == 0, "空数组空表");
            Check(PanelContract.ExtractYamlStringList("k: not-array", "k").Count == 0, "非数组形态空表");
            string crlfY = y.Replace("\n", "\r\n");
            Check(PanelContract.ExtractYamlValue(crlfY, "serverName") == "quoted single", "CRLF 兼容");
            // 前缀键不误命中（servername ≠ serverName）
            Check(PanelContract.ExtractYamlValue("xserverName: z\nserverName: real", "serverName") == "real", "键名前缀不误命中");

            // ③ MCP 分节提取
            Console.WriteLine("-- ③ ExtractMcpBlock --");
            string patch =
                "# 顶部注释\n" +
                "- insert:\n" +
                "  - id: memory-hub\n" +
                "## dseam-skillmcp:mcp\n" +
                "- id: dseam-mcp-abc123\n" +
                "  serverName: srv1\n" +
                "## other-owner:x\n" +
                "  非本节内容\n";
            string block = PanelContract.ExtractMcpBlock(patch);
            Check(block != null, "契约 marker 命中");
            Check(block.Contains("dseam-mcp-abc123"), "块内容正确");
            Check(!block.Contains("非本节内容"), "下一 marker 截断");
            Check(!block.Contains("memory-hub"), "marker 之前内容不含");
            string legacy =
                "x\n# >>> dseam-skillmcp:mcp:begin\n- id: dseam-mcp-old\n# <<< dseam-skillmcp:mcp:end\ny\n";
            string legacyBlock = PanelContract.ExtractMcpBlock(legacy);
            Check(legacyBlock != null && legacyBlock.Contains("dseam-mcp-old"), "旧 begin/end 兼容");
            string legacy2 =
                "x\n# >>> dsh-skill-mcp-panel:mcp:begin\n- id: panel-mcp-old2\n# <<< dsh-skill-mcp-panel:mcp:end\n";
            string legacyBlock2 = PanelContract.ExtractMcpBlock(legacy2);
            Check(legacyBlock2 != null && legacyBlock2.Contains("panel-mcp-old2"), "旧 panel 前缀 begin/end 兼容");
            Check(PanelContract.ExtractMcpBlock("没有分节") == null, "无块 null");
            Check(PanelContract.ExtractMcpBlock("") == null, "空文本 null");
            Check(PanelContract.ExtractMcpBlock(null) == null, "null null");
            Check(PanelContract.ExtractMcpBlock("## dseam-skillmcp:mcp") == "", "marker 行尾无内容 → 空块（0 行条目，非 null）");
            // marker 行带前后空白（实现按整行 Trim 相等匹配）
            string padded = "  ## dseam-skillmcp:mcp  \nP\n";
            Check(PanelContract.ExtractMcpBlock(padded) != null && PanelContract.ExtractMcpBlock(padded).Contains("P"), "marker 行前后空白容忍");
            // marker 出现在行中（非整行）不误命中（旧实现 IndexOf 子串会命中）
            Check(PanelContract.ExtractMcpBlock("xx ## dseam-skillmcp:mcp yy\nQ\n") == null, "行中子串形态不误命中（收紧为整行匹配）");
            // 两个 marker 取文本序首个（修复：旧实现按 marker 数组序而非文档位置取块）
            string dual = "## dsh-skill-mcp-panel:mcp\nA\n## dseam-skillmcp:mcp\nB\n";
            Check(PanelContract.ExtractMcpBlock(dual).Contains("A") && !PanelContract.ExtractMcpBlock(dual).Contains("B"), "双 marker 取文档序首个");

            // ④ 行数据解析
            Console.WriteLine("-- ④ ParseMcpRows --");
            string mcpBlock =
                "- id: dseam-mcp-abc123\n" +
                "  serverName: my-server\n" +
                "  transport: streamable-http\n" +
                "  url: https://x.example/api\n" +
                "- id: dseam-mcp-def456\n" +
                "  command: node\n" +
                "  args: [cli.js, --foo]\n" +
                "  disabled: true\n";
            List<Dictionary<string, object>> rows = PanelContract.ParseMcpRows(mcpBlock);
            Check(rows.Count == 2, "两行条目");
            Check((string)rows[0]["id"] == "my-server" && (string)rows[0]["name"] == "my-server", "serverName 覆盖 id");
            Check((string)rows[0]["transport"] == "streamable-http", "transport 解析");
            Check((string)rows[0]["url"] == "https://x.example/api", "url 解析");
            Check((bool)rows[0]["enabled"], "无 disabled → enabled");
            Check(rows[1]["id"] is string && ((string)rows[1]["id"]).StartsWith("dseam-mcp-def"), "无 serverName 回退条目 id");
            Check(!(bool)rows[1]["enabled"], "disabled: true → disabled");
            Check((string)rows[1]["command"] == "node", "command 解析");
            Check(((List<string>)rows[1]["args"]).Count == 2, "args 数组");
            Check((string)rows[1]["transport"] == "stdio", "无 transport 默认 stdio");
            Check((string)rows[0]["command"] == "", "无 command 空串");
            Check(PanelContract.ParseMcpRows(null).Count == 0, "null 块空表");
            Check(PanelContract.ParseMcpRows("").Count == 0, "空块空表");
            Check(PanelContract.ParseMcpRows("- id: not-mcp-prefix\n").Count == 0, "非 mcp 前缀条目跳过");
            // autoStart 恒 false（页面契约）
            Check(!(bool)rows[0]["autoStart"], "autoStart 恒 false");

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }
    }
}
