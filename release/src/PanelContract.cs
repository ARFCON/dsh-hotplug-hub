// PanelContract.cs — Skill/MCP 面板（dseam-skillmcp）数据面的纯逻辑契约
//
// v1.1（桌面壳审计 PC24）：Main.cs 中 MCP 块解析（cordis.patch.yml 的 mcp 分节）、
// YAML 标量/内联数组提取、服务器名净化此前私有内联零测试。本契约收敛为可测真源：
//   · SanitizeServerName：MCP 服务器名净化（A-Za-z0-9_-，≤32，空回退 mcp）；
//   · ExtractYamlValue / ExtractYamlStringList：行级 YAML 标量 / [a, b] 内联数组；
//   · ExtractMcpBlock：契约 marker（## dseam-skillmcp:mcp）优先、旧 begin/end 兼容；
//   · ParseMcpRows：块内 `- id:` 条目 → 行数据（serverName/transport/command/url/args/enabled）。
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace DSHHotplugHub
{
    /// <summary>面板（skill/mcp）数据面纯逻辑单一真源（Main.cs 薄委托到此）。</summary>
    public static class PanelContract
    {
        /// <summary>MCP 服务器名净化：非 [A-Za-z0-9_-] 压缩为 '-'，截 32，空回退 mcp。</summary>
        public static string SanitizeServerName(string id)
        {
            string s = Regex.Replace(id ?? "", "[^A-Za-z0-9_-]", "-");
            if (s.Length > 32) s = s.Substring(0, 32);
            return s.Length == 0 ? "mcp" : s;
        }

        /// <summary>行级 YAML 标量提取：首个 `key: value` 行的值（引号成对剥离）；未命中/null 文本返回 null。</summary>
        public static string ExtractYamlValue(string text, string key)
        {
            if (string.IsNullOrEmpty(text)) return null;
            string pattern = "^\\s*" + key + ":\\s*(.*)$";
            foreach (string line in text.Replace("\r\n", "\n").Split('\n'))
            {
                Match m = Regex.Match(line, pattern);
                if (m.Success)
                {
                    string v = m.Groups[1].Value.Trim();
                    if (v.Length >= 2 && ((v[0] == '\'' && v[v.Length - 1] == '\'') || (v[0] == '"' && v[v.Length - 1] == '"'))) v = v.Substring(1, v.Length - 2);
                    return v;
                }
            }
            return null;
        }

        /// <summary>行级 YAML 内联数组提取：`key: [a, b]` → {a, b}（引号剥离）；未命中返回空表。</summary>
        public static List<string> ExtractYamlStringList(string text, string key)
        {
            List<string> list = new List<string>();
            if (string.IsNullOrEmpty(text)) return list;
            string pattern = "^\\s*" + key + ":\\s*\\[(.*)\\]\\s*$";
            foreach (string line in text.Replace("\r\n", "\n").Split('\n'))
            {
                Match m = Regex.Match(line, pattern);
                if (m.Success)
                {
                    string inner = m.Groups[1].Value;
                    foreach (string part in inner.Split(','))
                    {
                        string p = part.Trim().Trim('\'', '"');
                        if (p.Length > 0) list.Add(p);
                    }
                    break;
                }
            }
            return list;
        }

        // MCP 分节起始 marker（两个历史前缀都认）；结束边界 = 任意 `## owner:id` marker 行
        private static readonly string[] McpStartMarkers = new string[] { "## dseam-skillmcp:mcp", "## dsh-skill-mcp-panel:mcp" };
        // 通用契约 marker 行（与 PatchContract 的 PatchMarkerRe 同语义）：任何 owner 的分节都终止当前块
        private static readonly System.Text.RegularExpressions.Regex MarkerLineRe =
            new System.Text.RegularExpressions.Regex("^#{1,2}\\s+[A-Za-z0-9._-]+:[A-Za-z0-9._-]+\\s*$");

        /// <summary>cordis.patch.yml 里的 MCP 分节：契约单行 marker（## dseam-skillmcp:mcp /
        /// ## dsh-skill-mcp-panel:mcp）优先（文本序首个命中）；无 marker 回退旧 begin/end 形态
        /// （迁移期读兼容）。块边界 = 下一个【任意 owner】的 marker 行——此前只认两个 mcp 前缀，
        /// 其他 owner 的分节内容会泄漏进 MCP 块。未找到返回 null。</summary>
        public static string ExtractMcpBlock(string patchText)
        {
            if (string.IsNullOrEmpty(patchText)) return null;
            string text = patchText.Replace("\r\n", "\n");
            string[] lines = text.Split('\n');
            int start = -1;
            for (int i = 0; i < lines.Length; i++)
            {
                foreach (string marker in McpStartMarkers)
                {
                    if (lines[i].Trim() == marker) { start = i; break; }
                }
                if (start >= 0) break;
            }
            if (start >= 0)
            {
                int end = lines.Length;
                for (int i = start + 1; i < lines.Length; i++)
                {
                    if (MarkerLineRe.IsMatch(lines[i])) { end = i; break; }
                }
                return string.Join("\n", lines, start + 1, end - start - 1);
            }
            // 旧 begin/end 形态（迁移期读兼容）
            string begin = "# >>> dseam-skillmcp:mcp:begin";
            string endMarker = "# <<< dseam-skillmcp:mcp:end";
            int b = text.IndexOf(begin);
            int e = text.IndexOf(endMarker);
            if (b < 0 || e <= b)
            {
                begin = "# >>> dsh-skill-mcp-panel:mcp:begin";
                endMarker = "# <<< dsh-skill-mcp-panel:mcp:end";
                b = text.IndexOf(begin);
                e = text.IndexOf(endMarker);
            }
            if (b >= 0 && e > b)
                return text.Substring(b + begin.Length, e - b - begin.Length);
            return null;
        }

        /// <summary>MCP 分节行数据：`- id: ((dseam|panel)-mcp-xxx)` 条目 →
        /// {id, name, enabled, transport, command, url, args[]}（serverName 缺省回退条目 id）。
        /// 与 Main.cs GetMcpsJson 的解析行为逐字一致（迁移自该处，行为锁定）。</summary>
        public static List<Dictionary<string, object>> ParseMcpRows(string mcpBlock)
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            if (string.IsNullOrEmpty(mcpBlock)) return list;
            MatchCollection rows = Regex.Matches(mcpBlock, @"- id:\s*((?:dseam-mcp|panel-mcp)-[A-Za-z0-9_-]+)[\s\S]*?(?=\n\s*- id:|\z)");
            foreach (Match rowMatch in rows)
            {
                string rowText = rowMatch.Value;
                string id = rowMatch.Groups[1].Value;
                string serverName = ExtractYamlValue(rowText, "serverName") ?? id;
                string transport = ExtractYamlValue(rowText, "transport") ?? "stdio";
                Dictionary<string, object> item = new Dictionary<string, object>();
                item["id"] = serverName;
                item["name"] = serverName;
                item["enabled"] = !rowText.Contains("disabled: true");
                item["transport"] = transport;
                item["command"] = ExtractYamlValue(rowText, "command") ?? "";
                item["url"] = ExtractYamlValue(rowText, "url") ?? "";
                item["args"] = ExtractYamlStringList(rowText, "args");
                item["autoStart"] = false;
                list.Add(item);
            }
            return list;
        }
    }
}
