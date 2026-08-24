// InstallUninstallContract.cs — 安装/卸载契约的单一真源（PATH 条目操作 + 名称匹配）
//
// 把安装器（installer/Setup.cs AddToUserPath）与卸载器（uninstaller/hotplug-hub）共用的
// PATH 条目操作、名称匹配抽为无 I/O 纯函数，供 csc 契约测试直接断言：
//   · MergePathEntry      —— 把条目加到 PATH 最前（不区分大小写 + 尾随反斜杠归一去重）
//   · RemovePathEntry     —— 从 PATH 移除指定条目（同上归一语义）
//   · IsPathEntryUnderDir —— 判断 PATH 条目是否位于某目录下（支持 %VAR% 展开）
//   · MatchesExactName    —— 精确名称匹配（不区分大小写；杜绝「DSH Desk ⊂ DSH Desktop」误命中）
//
// 修复的缺陷（由 tests/InstallUninstallContractTests.cs 先红后修锁定）：
//   · 旧 AddToUserPath 用 `parts.Contains(p)`（区分大小写、不归一尾随反斜杠）去重，
//     重装时大小写/尾斜杠差异会注入重复 PATH 条目；
//   · 旧卸载器 IsDshPathEntry 用子串匹配，会把无关 PATH 条目（如 dsh-client-sdk）误删。
using System;
using System.Collections.Generic;

namespace DSHHotplugHub
{
    public static class InstallUninstallContract
    {
        /// <summary>把 entry 加到 PATH 最前（去重：忽略大小写 + 归一尾随反斜杠 + 展开 %VAR%）。
        /// entry 为空 → 原样返回 path；已存在等价条目 → 原样返回 path（不注入重复）。</summary>
        public static string MergePathEntry(string path, string entry)
        {
            if (string.IsNullOrEmpty(entry)) return path ?? "";
            string key = CompareKey(entry);
            List<string> parts = SplitPath(path);
            foreach (string p in parts)
            {
                if (CompareKey(p).Equals(key, StringComparison.OrdinalIgnoreCase)) return path ?? "";
            }
            List<string> merged = new List<string>();
            merged.Add(entry.Trim());
            merged.AddRange(parts);
            return string.Join(";", merged.ToArray());
        }

        /// <summary>从 PATH 移除 entry（忽略大小写 + 归一尾随反斜杠 + 展开 %VAR%）。
        /// 返回移除后的新 PATH 串（无匹配则原样）。</summary>
        public static string RemovePathEntry(string path, string entry)
        {
            if (string.IsNullOrEmpty(entry)) return path ?? "";
            string key = CompareKey(entry);
            List<string> kept = new List<string>();
            foreach (string p in SplitPath(path))
            {
                if (CompareKey(p).Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
                kept.Add(p);
            }
            return string.Join(";", kept.ToArray());
        }

        /// <summary>判断 PATH 条目是否位于 dir 下（忽略大小写；两者都先展开 %VAR% 并归一尾随反斜杠）。
        /// dir 为空 → false。用于卸载时删除安装目录下注入的所有 PATH 条目（runtime\node、runtime\pnpm 等）。</summary>
        public static bool IsPathEntryUnderDir(string pathEntry, string dir)
        {
            if (string.IsNullOrEmpty(pathEntry) || string.IsNullOrEmpty(dir)) return false;
            string entryKey = CompareKey(pathEntry);
            string dirKey = CompareKey(dir);
            if (entryKey.Length == 0 || dirKey.Length == 0) return false;
            return entryKey.Equals(dirKey, StringComparison.OrdinalIgnoreCase) ||
                   entryKey.StartsWith(dirKey.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>精确名称匹配（不区分大小写）：value 与 names 中任一项完全相等。
        /// 用于变体定向清理（uninstall key / Run 项）：「DSH Desk」绝不等于「DSH Desktop」，
        /// 「DSH Desktop」绝不等于「DSH Desktop Hub」——避免卸载一个变体时误删另一变体的注册项。</summary>
        public static bool MatchesExactName(string value, string[] names)
        {
            if (string.IsNullOrEmpty(value) || names == null || names.Length == 0) return false;
            foreach (string n in names)
            {
                if (!string.IsNullOrEmpty(n) && value.Equals(n, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        // ---------- 内部工具 ----------

        /// <summary>切分 PATH 串：按 ';' 分隔，丢弃空段（保留其余原样）。</summary>
        private static List<string> SplitPath(string path)
        {
            List<string> parts = new List<string>();
            if (string.IsNullOrEmpty(path)) return parts;
            foreach (string p in path.Split(';'))
            {
                if (!string.IsNullOrEmpty(p)) parts.Add(p);
            }
            return parts;
        }

        /// <summary>归一化比较键：trim + 展开 %VAR% + 去尾随反斜杠（不去空格字符之外的空白）。</summary>
        private static string CompareKey(string p)
        {
            if (p == null) return "";
            string s = p.Trim();
            try { s = Environment.ExpandEnvironmentVariables(s); } catch { /* 展开失败按原样 */ }
            return s.TrimEnd('\\');
        }
    }
}
