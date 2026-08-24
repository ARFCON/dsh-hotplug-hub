// RepairContract.cs — 「修复配置」契约的单一真源（与 Main.cs RepairDshConfig 对齐）
//
// 把 ~/.dsh 配置修复的两段纯逻辑（settings.yaml 重复键 / .credentials.yaml 包裹层）
// 抽离为无 I/O 的纯函数，供 csc 契约测试直接断言，并让 Main.cs 复用同一真源：
//   · RemoveDuplicateYamlKeys —— 移除同一父作用域下重复的键（保留第一个）
//   · FlattenCredentialsYaml —— 把 version/refs 包裹层扁平化为「凭证名 → 字符串」映射
//
// 修复的缺陷（由 tests/RepairContractTests.cs 先红后修锁定）：
//   · 旧实现 `key = line.Split(':')[0]` 把列表项 `- foo` / `- name: a` 也当成「键」，
//     导致两个合法列表项被误判为「重复键」而删除第二个 → 数据丢失；
//   · 旧实现只与「紧邻的上一行」比较，重复键被空行/注释隔开即漏检（真重复仍在）；
//   · 旧实现把块标量（`key: |`/`key: >`）的字面内容行当「键」去重 → 破坏正文；
//   · 旧实现 `StartsWith("version:")` 漏判 `version :`（冒号前空格，合法 YAML），
//     且把「仅 version 无 refs」的合法扁平凭证误判为包裹层 → 销毁名为 version 的凭证。
using System;
using System.Collections.Generic;

namespace DSHHotplugHub
{
    public static class RepairContract
    {
        /// <summary>移除同一父作用域下重复的键（保留第一个）。
        /// 以「缩进层级 → 已见键集合」跟踪：同一缩进层级重复出现的键视为重复（YAML 禁止同层重复键），
        /// 出现更浅缩进的新键即进入新的父作用域（清空更深层级），故不同父下的同键不受影响。
        /// 列表项（`-`）、无冒号标量、块标量字面内容（`|`/`>` 正文）不参与去重。
        /// `---` / `...` 文档分隔符视为作用域重置。
        /// 返回去重后的行数组；removed = 实际移除的重复键数量。</summary>
        public static string[] RemoveDuplicateYamlKeys(string[] lines, out int removed)
        {
            removed = 0;
            if (lines == null) return new string[0];
            List<string> kept = new List<string>();
            // 缩进层级 → 该层级已出现的键集合（浅缩进新键会清空更深层级，模拟 YAML 嵌套作用域）
            Dictionary<int, List<string>> seen = new Dictionary<int, List<string>>();
            int blockScalarIndent = -1; // ≥0 表示当前处于块标量（|/>）字面内容中
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i] ?? "";
                string trimmed = line.TrimEnd();
                string ts = trimmed.TrimStart();
                int indent = trimmed.Length - ts.Length;
                if (string.IsNullOrWhiteSpace(trimmed) || ts.StartsWith("#"))
                {
                    kept.Add(line); // 空行/注释：原样保留，不改变作用域
                    continue;
                }
                if (trimmed == "---" || trimmed == "...")
                {
                    kept.Add(line); // 文档分隔符：重置全部作用域
                    seen.Clear();
                    blockScalarIndent = -1;
                    continue;
                }
                if (blockScalarIndent >= 0)
                {
                    if (indent > blockScalarIndent)
                    {
                        kept.Add(line); // 块标量字面内容：原样保留，不去重
                        continue;
                    }
                    blockScalarIndent = -1; // 缩进回退：块结束
                }

                string key;
                if (!TryExtractMapKey(ts, out key))
                {
                    kept.Add(line); // 列表项 / 无冒号标量：不参与去重
                    continue;
                }

                bool block = IsBlockScalarOpener(trimmed);
                List<string> level;
                if (!seen.TryGetValue(indent, out level))
                {
                    level = new List<string>();
                    seen[indent] = level;
                }
                bool dup = level.Contains(key);
                if (dup)
                {
                    removed++;
                }
                else
                {
                    kept.Add(line);
                    level.Add(key);
                    // 清空更深层级（进入新的父作用域）
                    List<int> deeper = new List<int>();
                    foreach (int k in seen.Keys) if (k > indent) deeper.Add(k);
                    foreach (int k in deeper) seen.Remove(k);
                }
                blockScalarIndent = block ? indent : -1;
            }
            return kept.ToArray();
        }

        /// <summary>提取映射条目的键。仅接受形如 `key: ...` 的映射行；
        /// 列表项（`-` 开头）、注释、无冒号、空键一律返回 false（不参与去重）。</summary>
        private static bool TryExtractMapKey(string trimmedStart, out string key)
        {
            key = null;
            if (trimmedStart.Length == 0) return false;
            char c0 = trimmedStart[0];
            if (c0 == '#' || c0 == '-') return false; // 注释 / 列表项（含 `- key: v` 列表内映射）
            int colon = trimmedStart.IndexOf(':');
            if (colon <= 0) return false; // 无冒号或空键
            key = trimmedStart.Substring(0, colon).Trim();
            return key.Length > 0;
        }

        /// <summary>判断是否为块标量开启行（`key: |` / `key: >` 及带 chomping 指示符的变体）。</summary>
        private static bool IsBlockScalarOpener(string trimmed)
        {
            int colon = trimmed.IndexOf(':');
            if (colon < 0) return false;
            string value = trimmed.Substring(colon + 1).TrimStart();
            return value.Length > 0 && (value[0] == '|' || value[0] == '>');
        }

        /// <summary>把 version/refs 包裹层扁平化为「凭证名 → 字符串」扁平映射。
        /// 仅当存在顶层 `refs` 块头（`refs:` 后无内容）时才视为包裹：丢弃 version/refs 头行，
        /// 把缩进（≥2）条目提升到顶层；其余非空行与注释原样保留。flattened = 是否执行了扁平化。
        /// 若存在更深嵌套（缩进 ≥4，超出「扁平凭证」契约）则保守不改写，避免破坏结构。</summary>
        public static string[] FlattenCredentialsYaml(string[] lines, out bool flattened)
        {
            flattened = false;
            if (lines == null) return new string[0];

            // 1. 检测包裹：顶层 `refs:` 块头（冒号后无内容）
            bool hasWrap = false;
            foreach (string l in lines)
            {
                string t = (l ?? "").TrimEnd();
                string ts = t.TrimStart();
                if (t.Length - ts.Length == 0 && IsBlockHeader(ts, "refs"))
                {
                    hasWrap = true;
                    break;
                }
            }
            if (!hasWrap) return lines;

            // 2. 更深嵌套（缩进 ≥4）超出「扁平凭证」契约 → 保守不改写，避免破坏有效结构
            foreach (string l in lines)
            {
                string t = (l ?? "").TrimEnd();
                string ts = t.TrimStart();
                if (string.IsNullOrWhiteSpace(t) || ts.StartsWith("#")) continue;
                if (t.Length - ts.Length >= 4) return lines;
            }

            // 3. 扁平化
            flattened = true;
            List<string> outLines = new List<string>();
            foreach (string l in lines)
            {
                string t = (l ?? "").TrimEnd();
                string ts = t.TrimStart();
                if (IsKeyHeader(ts, "version") || IsKeyHeader(ts, "refs")) continue; // 丢弃包裹头
                if (string.IsNullOrWhiteSpace(t)) continue;                          // 跳过空行
                if (ts.StartsWith("#")) { outLines.Add(ts); continue; }              // 保留注释
                int indent = t.Length - ts.Length;
                outLines.Add(ts); // 缩进 ≥2 的凭证条目提升到顶层；其余原样
            }
            return outLines.ToArray();
        }

        /// <summary>判断去除前导空白后的行是否为 `key:` 头行（容忍 `key :` / `key\t:` 等冒号前空白，
        /// 冒号后允许有值，用于识别并丢弃 version/refs 头）。</summary>
        private static bool IsKeyHeader(string trimmedStart, string key)
        {
            if (!trimmedStart.StartsWith(key, StringComparison.OrdinalIgnoreCase)) return false;
            int i = key.Length;
            while (i < trimmedStart.Length && char.IsWhiteSpace(trimmedStart[i])) i++;
            return i < trimmedStart.Length && trimmedStart[i] == ':';
        }

        /// <summary>判断是否为 `key:` 块头（冒号后无内容，即 `refs:` 而非 `refs: {}`）。</summary>
        private static bool IsBlockHeader(string trimmedStart, string key)
        {
            if (!trimmedStart.StartsWith(key, StringComparison.OrdinalIgnoreCase)) return false;
            int i = key.Length;
            while (i < trimmedStart.Length && char.IsWhiteSpace(trimmedStart[i])) i++;
            if (i >= trimmedStart.Length || trimmedStart[i] != ':') return false;
            i++;
            while (i < trimmedStart.Length && char.IsWhiteSpace(trimmedStart[i])) i++;
            return i >= trimmedStart.Length; // 冒号后无内容 → 块头
        }
    }
}
