// SkillContract.cs — Skill 管理（~/.dsh/skills）的纯逻辑契约
//
// v1.1（桌面壳审计 PC3/PC24）：Main.cs 中 skill 相关的 id 语法、路径安全、
// SKILL.md 前置事项解析此前私有内联在 WinForms 类中零测试。其中 DeleteSkillFile
// 的 id 来自 WebView IPC 消息且未经校验，直接 Path.Combine + Directory.Delete(true)，
// 存在路径穿越（deleteSkill:..\..）删除任意目录的面。本契约收敛：
//   · ValidSkillId / SafeSkillPath：id 语法（SanitizeSkillName 产出集）+ 路径不逃逸；
//   · SanitizeSkillName：创建/安装/探测共用同一净化（单一真源）；
//   · ReadSkillFrontmatter：--- 块解析（name/description，引号剥离）+ 无块标题回退。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace DSHHotplugHub
{
    /// <summary>Skill 目录/前置事项/id 语法的单一真源（Main.cs 薄委托到此）。</summary>
    public static class SkillContract
    {
        /// <summary>skill id 语法：小写字母/数字/连字符，字母数字开头结尾（SanitizeSkillName 产出集）。</summary>
        public const string SKILL_ID_RE_SOURCE = "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$";
        private static readonly Regex SkillIdRe = new Regex(SKILL_ID_RE_SOURCE);

        /// <summary>skill id 是否合法（长度 1..64；语法集与 SanitizeSkillName 产出一致）。</summary>
        public static bool ValidSkillId(string id)
        {
            return !string.IsNullOrEmpty(id) && id.Length <= 64 && SkillIdRe.IsMatch(id);
        }

        /// <summary>把显示名净化为 skill id：小写化、非 [a-z0-9] 压缩为 '-'、去首尾 '-'、截 64。</summary>
        public static string SanitizeSkillName(string name)
        {
            string s = Regex.Replace((name ?? "").ToLowerInvariant(), "[^a-z0-9]+", "-");
            s = s.Trim('-');
            if (s.Length > 64) s = s.Substring(0, 64);
            return s;
        }

        /// <summary>IPC id → 目标目录的路径安全契约：id 必须通过 ValidSkillId（拒绝分隔符/
        /// 穿越/绝对段——Path.Combine 对 "..\x" 的逃逸在此被语法白名单挡死），
        /// 返回 &lt;root&gt;/&lt;id&gt;；非法 id 返回 null（调用方按不存在处理，绝不触碰文件系统）。</summary>
        public static string SafeSkillDir(string skillsRoot, string id)
        {
            if (string.IsNullOrEmpty(skillsRoot) || !ValidSkillId(id)) return null;
            string combined = Path.Combine(skillsRoot, id);
            // 双保险：即便语法通过，组合结果也必须仍位于 root 之内（防御未来语法调整回归）
            string fullRoot = Path.GetFullPath(skillsRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            string full = Path.GetFullPath(combined);
            if (!full.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)) return null;
            return combined;
        }

        /// <summary>解析 SKILL.md 前置事项：`---` 块内 name:/description:（引号剥离）；
        /// 无前置事项块时回退取正文首个标题行作为 name。返回 {name, desc}（键恒存在）。
        /// 与 Main.cs ReadSkillFrontmatter 行为逐字一致（迁移自该处，行为锁定）。</summary>
        public static Dictionary<string, string> ReadSkillFrontmatter(string file)
        {
            Dictionary<string, string> m = new Dictionary<string, string>();
            m["name"] = Path.GetFileNameWithoutExtension(file);
            m["desc"] = "本地 Skill";
            try
            {
                string text = File.ReadAllText(file);
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0)
                    {
                        string fm = text.Substring(3, end - 3);
                        foreach (string line in fm.Split('\n'))
                        {
                            string t = line.TrimEnd('\r');
                            if (t.StartsWith("name:"))
                            {
                                string v = t.Substring("name:".Length).Trim().Trim('\'', '"');
                                if (v.Length > 0) m["name"] = v;
                            }
                            else if (t.StartsWith("description:"))
                            {
                                string v = t.Substring("description:".Length).Trim().Trim('\'', '"');
                                if (v.Length > 0) m["desc"] = v;
                            }
                        }
                    }
                }
                else
                {
                    string first = text.TrimStart('#', ' ', '\t', '\r', '\n');
                    if (first.Length > 0)
                    {
                        int nl = first.IndexOf('\n');
                        string n = (nl > 0 ? first.Substring(0, nl) : first).Trim();
                        if (n.Length > 0) m["name"] = n;
                    }
                }
            }
            catch { /* 读取失败返回文件名兜底 */ }
            return m;
        }

        /// <summary>新建 skill 的 SKILL.md 内容（frontmatter：name/description + 正文描述）。</summary>
        public static string BuildSkillMarkdown(string id, string desc)
        {
            return
                "---\n" +
                "name: " + id + "\n" +
                "description: " + desc + "\n" +
                "disable-model-invocation: false\n" +
                "---\n\n" +
                desc + "\n";
        }
    }
}
