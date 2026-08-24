// MemoryHubContract.cs — 桌面壳「全局记忆」数据面契约（与 dsh-memory-hub 插件同一存储协议）
//
// 职责（对齐插件 lib/store.mjs + lib/protocol.mjs 的落盘语义）：
//   ① 根目录单一真源：DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh（≡ vendor-shared resolveDshRoot）；
//   ② 读面：GetMemoryJson（稳定排序 + 展示截断）/ GetMemoryFullJson（编辑用全量正文）；
//   ③ 删面：ArchiveMemoryFile = 归档语义（revision 快照 → .archive 带 archivedAt →
//      删活跃 → 审计 → pack 计数同步），与插件 memory.forget 等价——绝不物理删除；
//   ④ 写面：SaveMemoryFile = 更新语义（revision+1、写前快照、JSON 引号编码、
//      type 枚举校验、原子写、审计），与插件 updateDirect 等价；
//   ⑤ 跨进程互斥：复用 PatchContract 文件锁协议（.dsh-memory.lock，token pid\nunix_ms）。
//
// 独立成契约（而非埋在 Main.cs）的动机：与 InstallUninstall/Patch/Shell/Repair 契约同构，
// 可被 release/tests/MemoryHubContractTests.cs 直接编译验证（行为契约 CI 全绿铁律）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace DSHHotplugHub
{
    public static class MemoryHubContract
    {
        /// <summary>条目正文展示截断（仅列表展示；编辑经 GetMemoryFullJson 取全量）。</summary>
        public const int ListBodyChars = 2000;
        /// <summary>列表条数上限（排序后稳定截断）。</summary>
        public const int ListMaxRows = 50;
        /// <summary>合法 type 枚举（与插件 TYPES 一致）。</summary>
        public static readonly string[] ValidTypes = new[] { "user", "feedback", "project", "reference" };

        // ---------- 根目录（单一真源，D-1） ----------

        /// <summary>DSH 根域目录：DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh（≡ resolveDshRoot）。</summary>
        public static string DshRootDir()
        {
            try
            {
                string hotplugRoot = Environment.GetEnvironmentVariable("DSH_HOTPLUG_ROOT");
                if (!string.IsNullOrEmpty(hotplugRoot) && hotplugRoot.Trim().Length > 0)
                    return Path.Combine(Path.GetFullPath(hotplugRoot.Trim()), ".dsh");
                string dshHome = Environment.GetEnvironmentVariable("DSH_HOME");
                if (!string.IsNullOrEmpty(dshHome) && dshHome.Trim().Length > 0)
                    return Path.GetFullPath(dshHome.Trim());
            }
            catch { /* 非法路径值：回退默认 */ }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        }

        /// <summary>记忆中枢根目录（&lt;dshRoot&gt;/memory-hub）。</summary>
        public static string MemoryHubRoot()
        {
            return Path.Combine(DshRootDir(), "memory-hub");
        }

        // ---------- 内置包安装 marker（B-4：内容指纹传播，同版本零重装） ----------

        /// <summary>web profile 安装目标目录（安装与探测的同一真源）。</summary>
        public static string InstalledPackageDir()
        {
            return Path.Combine(DshRootDir(), "profiles", "web", "node_modules", "dsh-memory-hub");
        }

        public static string Sha256File(string path)
        {
            try
            {
                using (var sha = SHA256.Create())
                using (FileStream fs = File.OpenRead(path))
                {
                    byte[] hash = sha.ComputeHash(fs);
                    var sb = new StringBuilder(hash.Length * 2);
                    foreach (byte b in hash) sb.Append(b.ToString("x2"));
                    return sb.ToString();
                }
            }
            catch { return null; }
        }

        /// <summary>读安装 marker（.embedded-build，内容 = 内置 tgz SHA256）；无 marker 返回 null。</summary>
        public static string ReadEmbeddedBuildMarker()
        {
            try { return File.ReadAllText(Path.Combine(InstalledPackageDir(), ".embedded-build")).Trim(); }
            catch { return null; }
        }

        public static void WriteEmbeddedBuildMarker(string hash)
        {
            try
            {
                // 安装目录可能尚未被 dsh CLI 建出（或被清理）——先确保存在
                Directory.CreateDirectory(InstalledPackageDir());
                File.WriteAllText(Path.Combine(InstalledPackageDir(), ".embedded-build"), hash + "\n");
            }
            catch { /* marker 失败只影响下次启动多重装一次，不影响功能 */ }
        }

        /// <summary>已装版本是否 ≥ 内置版本（防降级）。Core 段相等时：已装无 -pre 后缀而内置
        /// 有 → 已装是正式版，视为更新（semver 0.8.0 &gt; 0.8.0-pre）；其余交给数值段比较。</summary>
        public static bool IsAtLeastEmbedded(string installed, string embedded)
        {
            if (string.IsNullOrEmpty(installed)) return false;
            if (string.Equals(installed, embedded, StringComparison.Ordinal)) return true;
            string coreInstalled = installed.Split('-')[0];
            string coreEmbedded = embedded.Split('-')[0];
            if (string.Equals(coreInstalled, coreEmbedded, StringComparison.Ordinal))
            {
                return !installed.Contains("-");
            }
            return PatchContract.IsNewerVersion(installed, embedded);
        }

        // ---------- 读面 ----------

        /// <summary>记忆条目列表（JSON；包名/文件名稳定排序，展示截断 body）。</summary>
        public static string GetMemoryJson()
        {
            try
            {
                List<Dictionary<string, object>> rows = ReadRows(fullBody: false);
                return new JavaScriptSerializer().Serialize(rows);
            }
            catch { return "[]"; }
        }

        /// <summary>单条全量正文（JSON 对象；找不到返回 "null"）。</summary>
        public static string GetMemoryFullJson(string id)
        {
            try
            {
                string file = FindMemoryEntryFile(id);
                if (file == null) return "null";
                Dictionary<string, object> m = ParseMemoryEntry(file, fullBody: true);
                string packDir = Path.GetDirectoryName(Path.GetDirectoryName(file));
                Dictionary<string, object> row = RowFromEntry(m, Path.GetFileName(packDir), file, fullBody: true);
                return new JavaScriptSerializer().Serialize(row);
            }
            catch { return "null"; }
        }

        private static List<Dictionary<string, object>> ReadRows(bool fullBody)
        {
            var rows = new List<Dictionary<string, object>>();
            string hubDir = MemoryHubRoot();
            if (!Directory.Exists(hubDir)) return rows;
            foreach (string packDir in Directory.GetDirectories(hubDir).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
            {
                if (!File.Exists(Path.Combine(packDir, "pack.json"))) continue;
                string packId = Path.GetFileName(packDir);
                string entriesDir = Path.Combine(packDir, "entries");
                if (!Directory.Exists(entriesDir)) continue;
                foreach (string entryFile in Directory.GetFiles(entriesDir, "*.md").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                {
                    rows.Add(RowFromEntry(ParseMemoryEntry(entryFile, fullBody), packId, entryFile, fullBody));
                    if (rows.Count >= ListMaxRows) return rows;
                }
            }
            return rows;
        }

        private static Dictionary<string, object> RowFromEntry(Dictionary<string, object> entry, string packId, string entryFile, bool fullBody)
        {
            return new Dictionary<string, object>
            {
                { "packId", packId },
                { "id", entry.ContainsKey("id") ? entry["id"] : Path.GetFileNameWithoutExtension(entryFile) },
                { "name", entry.ContainsKey("name") ? entry["name"] : Path.GetFileNameWithoutExtension(entryFile) },
                { "title", entry.ContainsKey("title") ? entry["title"] : Path.GetFileNameWithoutExtension(entryFile) },
                { "type", entry.ContainsKey("type") ? entry["type"] : "" },
                { "body", entry.ContainsKey("body") ? entry["body"] : "" },
                { "keywords", entry.ContainsKey("keywords") ? entry["keywords"] : new List<string>() },
                { "updatedAt", entry.ContainsKey("updatedAt") ? entry["updatedAt"] : "" },
                { "revision", entry.ContainsKey("revision") ? entry["revision"] : 1 },
            };
        }

        /// <summary>解析 entries/*.md（frontmatter 键值 + body；truncate 控制展示截断）。</summary>
        public static Dictionary<string, object> ParseMemoryEntry(string file, bool fullBody)
        {
            var m = new Dictionary<string, object>();
            string body = "";
            try
            {
                string text = File.ReadAllText(file);
                body = text;
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0)
                    {
                        string fm = text.Substring(3, end - 3);
                        body = text.Substring(end + 4).Trim();
                        var keywords = new List<string>();
                        foreach (string raw in fm.Split('\n'))
                        {
                            string line = raw.TrimEnd('\r');
                            int ci = line.IndexOf(':');
                            if (ci <= 0) continue;
                            string k = line.Substring(0, ci).Trim();
                            string v = line.Substring(ci + 1).Trim();
                            if (k == "keywords")
                            {
                                if (v.StartsWith("["))
                                {
                                    try
                                    {
                                        object[] arr = new JavaScriptSerializer().Deserialize<object[]>(v);
                                        if (arr != null)
                                            foreach (object o in arr)
                                            {
                                                string p = Convert.ToString(o).Trim().Trim('\'', '"');
                                                if (p.Length > 0) keywords.Add(p);
                                            }
                                    }
                                    catch
                                    {
                                        foreach (string part in v.Trim('[', ']').Split(','))
                                        {
                                            string p = part.Trim().Trim('\'', '"');
                                            if (p.Length > 0) keywords.Add(p);
                                        }
                                    }
                                }
                                else if (v.Length > 0)
                                {
                                    foreach (string part in v.Split(','))
                                    {
                                        string p = part.Trim().Trim('\'', '"');
                                        if (p.Length > 0) keywords.Add(p);
                                    }
                                }
                            }
                            else if (k == "id") m["id"] = UnQuote(v);
                            else if (k == "name") m["name"] = UnQuote(v);
                            else if (k == "title") m["title"] = UnQuote(v);
                            else if (k == "type") m["type"] = UnQuote(v);
                            else if (k == "updatedAt") m["updatedAt"] = UnQuote(v);
                            else if (k == "revision")
                            {
                                int rev;
                                if (int.TryParse(v, out rev) && rev > 0) m["revision"] = rev;
                            }
                        }
                        if (keywords.Count == 0)
                        {
                            bool inKwList = false;
                            foreach (string raw in fm.Split('\n'))
                            {
                                string line = raw.TrimEnd('\r');
                                if (line.StartsWith("keywords:")) { inKwList = true; continue; }
                                if (inKwList && line.StartsWith("- "))
                                {
                                    string p = line.Substring(2).Trim().Trim('\'', '"');
                                    if (p.Length > 0) keywords.Add(p);
                                }
                                else if (inKwList && line.Length > 0 && !line.StartsWith(" ")) inKwList = false;
                            }
                        }
                        m["keywords"] = keywords;
                    }
                }
            }
            catch { /* 损坏文件：尽量返回已解析字段 */ }
            if (!m.ContainsKey("title")) m["title"] = Path.GetFileNameWithoutExtension(file);
            string bodyText = string.IsNullOrEmpty(body) ? "" : body;
            m["body"] = (!fullBody && bodyText.Length > ListBodyChars) ? bodyText.Substring(0, ListBodyChars) : bodyText;
            return m;
        }

        /// <summary>JSON 引号解码：插件 stringifyScalar 以 JSON 引号写标量（name/id/type/
        /// updatedAt 等），读取须去引号并反转义——否则带引号字面量参与比较/展示
        /// （id 查找失配、UI 显示引号），此前靠文件名兜底掩盖。</summary>
        public static string UnQuote(string v)
        {
            if (v == null) return null;
            string t = v.Trim().TrimEnd('\r');
            if (t.Length >= 2 && t.StartsWith("\"") && t.EndsWith("\""))
            {
                try { return new JavaScriptSerializer().Deserialize<string>(t); }
                catch { return t.Substring(1, t.Length - 2); }
            }
            return v.Trim().TrimEnd('\r');
        }

        /// <summary>按 id（或文件名）定位条目文件；排序保证命中稳定。</summary>
        public static string FindMemoryEntryFile(string id)
        {
            try
            {
                string hubDir = MemoryHubRoot();
                if (!Directory.Exists(hubDir)) return null;
                foreach (string packDir in Directory.GetDirectories(hubDir).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
                {
                    string entriesDir = Path.Combine(packDir, "entries");
                    if (!Directory.Exists(entriesDir)) continue;
                    foreach (string entryFile in Directory.GetFiles(entriesDir, "*.md").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                    {
                        if (Path.GetFileNameWithoutExtension(entryFile) == id) return entryFile;
                        // id 定位只需 frontmatter 字段——不读全量正文（大库扫描降载）
                        Dictionary<string, object> entry = ParseMemoryEntry(entryFile, false);
                        if (entry.ContainsKey("id") && Convert.ToString(entry["id"]) == id) return entryFile;
                    }
                }
            }
            catch { /* 查找失败按不存在处理 */ }
            return null;
        }

        // ---------- 写面（与插件协议等价） ----------

        /// <summary>记忆写锁（.dsh-memory.lock；复用 PatchContract 文件锁协议）。</summary>
        public static FileStream AcquireMemoryLock()
        {
            return PatchContract.AcquireLockAtPath(Path.Combine(MemoryHubRoot(), ".dsh-memory.lock"));
        }

        public static void ReleaseMemoryLock(FileStream handle)
        {
            PatchContract.ReleaseLockAtPath(handle, Path.Combine(MemoryHubRoot(), ".dsh-memory.lock"));
        }

        /// <summary>审计行追加（operator=user；与插件同一账本 .audit.jsonl）。</summary>
        public static void AppendMemoryAudit(string action, string packId, string entryId, string outcome, string detail)
        {
            try
            {
                string path = Path.Combine(MemoryHubRoot(), ".audit.jsonl");
                string row = new JavaScriptSerializer().Serialize(new Dictionary<string, object>
                {
                    { "at", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") },
                    { "action", action },
                    { "packId", packId },
                    { "entryId", entryId },
                    { "operator", "user" },
                    { "source", "dsh-desktop-shell" },
                    { "outcome", outcome },
                    { "via", "user" },
                    { "detail", detail ?? "" }
                });
                File.AppendAllText(path, row + "\n");
            }
            catch { /* 审计失败不阻断主流程 */ }
        }

        /// <summary>原子写（tmp + replace/move；崩溃不写半截）。</summary>
        public static void AtomicWriteText(string path, string content)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = path + "." + Process.GetCurrentProcess().Id + "." + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ".tmp";
            File.WriteAllText(tmp, content);
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        /// <summary>pack.json entries 计数同步（权威 = entries/*.md 实数）。</summary>
        public static void SyncMemoryPackCount(string packDir)
        {
            try
            {
                string packFile = Path.Combine(packDir, "pack.json");
                if (!File.Exists(packFile)) return;
                var manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(packFile));
                if (manifest == null) return;
                int count = 0;
                string entriesDir = Path.Combine(packDir, "entries");
                if (Directory.Exists(entriesDir)) count = Directory.GetFiles(entriesDir, "*.md").Length;
                if (manifest.ContainsKey("entries") && Convert.ToInt32(manifest["entries"]) == count) return;
                manifest["entries"] = count;
                AtomicWriteText(packFile, new JavaScriptSerializer().Serialize(manifest));
            }
            catch { /* 插件侧下次写自愈 */ }
        }

        /// <summary>重建 pack 的 index.json 检索镜像（与插件 rebuildIndex 同构——C# 写路径
        /// 此前不碰镜像，条目被桌面壳删除/改题后镜像陈旧成幽灵条目）。</summary>
        public static void RebuildMemoryIndex(string packDir, string packId)
        {
            try
            {
                string entriesDir = Path.Combine(packDir, "entries");
                var rows = new List<Dictionary<string, object>>();
                if (Directory.Exists(entriesDir))
                {
                    foreach (string entryFile in Directory.GetFiles(entriesDir, "*.md").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                    {
                        Dictionary<string, object> e = ParseMemoryEntry(entryFile, false);
                        rows.Add(new Dictionary<string, object>
                        {
                            { "id", e.ContainsKey("id") ? e["id"] : Path.GetFileNameWithoutExtension(entryFile) },
                            { "name", e.ContainsKey("name") ? e["name"] : Path.GetFileNameWithoutExtension(entryFile) },
                            { "title", e.ContainsKey("title") ? e["title"] : "" },
                            { "type", e.ContainsKey("type") ? e["type"] : "project" },
                            { "activation", "relevant" },
                        });
                    }
                }
                var ser = new JavaScriptSerializer();
                string json = "{\"memoryPackId\":" + ser.Serialize(packId)
                    + ",\"schemaVersion\":1,\"entries\":" + ser.Serialize(rows)
                    + ",\"rebuiltAt\":" + ser.Serialize(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")) + "}";
                AtomicWriteText(Path.Combine(packDir, "index.json"), json);
            }
            catch { /* 镜像非权威（可重建）：失败不阻断主流程，插件下次写自愈 */ }
        }

        /// <summary>frontmatter 单行替换/追加（value 须已编码：JSON 引号/裸数字）。</summary>
        public static string SetFmValue(string fm, string key, string value)
        {
            string[] lines = fm.Replace("\r\n", "\n").Split('\n');
            var next = new List<string>();
            bool replaced = false;
            foreach (string line in lines)
            {
                string t = line.TrimEnd('\r');
                if (t.StartsWith(key + ":")) { next.Add(key + ": " + value); replaced = true; }
                else next.Add(t);
            }
            if (!replaced) next.Add(key + ": " + value);
            return string.Join("\n", next);
        }

        /// <summary>JSON 引号编码（≡ 插件 stringifyScalar：杜绝裸值被解析成数组/布尔）。</summary>
        public static string JsonQuote(string value)
        {
            return new JavaScriptSerializer().Serialize(value ?? "");
        }

        /// <summary>删除 = 归档（≡ memory.forget）。返回 (ok, message)。</summary>
        public static bool ArchiveMemoryFile(string id, out string message)
        {
            message = "";
            FileStream memoryLock = null;
            try
            {
                string file = FindMemoryEntryFile(id);
                if (file == null) { message = "条目不存在（可能已被删除）"; return false; }
                memoryLock = AcquireMemoryLock();
                if (!File.Exists(file)) { message = "条目不存在（进锁前被并发删除）"; return false; }
                string text = File.ReadAllText(file);
                Dictionary<string, object> entry = ParseMemoryEntry(file, true);
                string name = Path.GetFileNameWithoutExtension(file);
                string entryId = entry.ContainsKey("id") ? Convert.ToString(entry["id"]) : name;
                int revision = entry.ContainsKey("revision") ? Convert.ToInt32(entry["revision"]) : 1;
                string packDir = Path.GetDirectoryName(Path.GetDirectoryName(file));
                string packId = Path.GetFileName(packDir);
                // 1) revision 快照
                string revDir = Path.Combine(packDir, ".revisions", entryId);
                Directory.CreateDirectory(revDir);
                File.WriteAllText(Path.Combine(revDir, revision.ToString().PadLeft(3, '0') + ".md"), text);
                // 2) 归档副本（带 archivedAt）
                string fm = "";
                string body = text; // 无 frontmatter/未闭合 → 全文即正文（与 ParseMemoryEntry 口径一致）
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0) { fm = text.Substring(3, end - 3); body = text.Substring(end + 4).Trim(); }
                }
                fm = SetFmValue(fm, "archivedAt", JsonQuote(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")));
                string archivePath = Path.Combine(packDir, ".archive", name + ".md");
                Directory.CreateDirectory(Path.GetDirectoryName(archivePath));
                AtomicWriteText(archivePath, "---\n" + fm + "\n---\n\n" + body + "\n");
                // 3) 删活跃 + 计数 + 审计
                File.Delete(file);
                SyncMemoryPackCount(packDir);
                RebuildMemoryIndex(packDir, packId);
                AppendMemoryAudit("remove", packId, entryId, "allowed", "desktop-shell archive");
                message = "已归档：" + name;
                return true;
            }
            catch (Exception ex)
            {
                message = "归档失败：" + ex.Message;
                try { AppendMemoryAudit("remove", null, id, "failed", ex.Message); } catch { }
                return false;
            }
            finally
            {
                if (memoryLock != null) ReleaseMemoryLock(memoryLock);
            }
        }

        /// <summary>编辑保存（≡ updateDirect：revision+1 / 快照 / JSON 引号 / type 校验 / 原子写 / 审计）。
        /// body 显式空串 = 清空正文（与插件 GUI 一致）；body 缺省（null）= 保留旧正文。</summary>
        public static bool SaveMemoryFile(string payload, out string message)
        {
            message = "";
            FileStream memoryLock = null;
            string entryIdForAudit = null;
            try
            {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(payload);
                if (data == null) { message = "载荷不可解析"; return false; }
                string id = data.ContainsKey("id") ? Convert.ToString(data["id"]) : "";
                entryIdForAudit = id;
                string file = FindMemoryEntryFile(id);
                if (file == null) { message = "条目不存在（可能已被删除）"; return false; }
                string title = data.ContainsKey("title") ? Convert.ToString(data["title"]).Trim() : "";
                // body 显式传 JSON null ≠ 缺省：TryGetValue 区分（null=保留旧正文，""=清空）
                object rawBody;
                data.TryGetValue("body", out rawBody);
                string body = rawBody == null ? null : Convert.ToString(rawBody);
                string type = data.ContainsKey("type") ? Convert.ToString(data["type"]).Trim() : "";
                if (type.Length > 0 && Array.IndexOf(ValidTypes, type) < 0)
                {
                    message = "type 非法（允许 user/feedback/project/reference）：" + type;
                    return false;
                }
                var kw = new List<string>();
                object[] keywords = data.ContainsKey("keywords") ? data["keywords"] as object[] : null;
                if (keywords != null)
                    foreach (object k in keywords)
                    {
                        string p = Convert.ToString(k).Trim();
                        if (p.Length > 0) kw.Add(p);
                    }
                // 与插件 sanitize 对齐：title ≤200、keywords ≤24 个 × 每个 ≤60 字符
                if (title.Length > 200) title = title.Substring(0, 200);
                if (kw.Count > 24) kw.RemoveRange(24, kw.Count - 24);
                for (int i = 0; i < kw.Count; i++) if (kw[i].Length > 60) kw[i] = kw[i].Substring(0, 60);
                memoryLock = AcquireMemoryLock();
                if (!File.Exists(file)) { message = "条目不存在（进锁前被并发删除）"; return false; }
                string text = File.ReadAllText(file);
                string fm = "";
                string oldBody = text; // 未闭合 → 全文兜底
                if (text.StartsWith("---"))
                {
                    int end = text.IndexOf("\n---", 3);
                    if (end > 0) { fm = text.Substring(3, end - 3); oldBody = text.Substring(end + 4).Trim(); }
                }
                Dictionary<string, object> entry = ParseMemoryEntry(file, true);
                string entryId = entry.ContainsKey("id") ? Convert.ToString(entry["id"]) : Path.GetFileNameWithoutExtension(file);
                entryIdForAudit = entryId;
                int revision = entry.ContainsKey("revision") ? Convert.ToInt32(entry["revision"]) : 1;
                string packDir = Path.GetDirectoryName(Path.GetDirectoryName(file));
                string packId = Path.GetFileName(packDir);
                string revDir = Path.Combine(packDir, ".revisions", entryId);
                Directory.CreateDirectory(revDir);
                File.WriteAllText(Path.Combine(revDir, revision.ToString().PadLeft(3, '0') + ".md"), text);
                var ser = new JavaScriptSerializer();
                if (title.Length > 0) fm = SetFmValue(fm, "title", JsonQuote(title));
                if (type.Length > 0) fm = SetFmValue(fm, "type", JsonQuote(type));
                // keywords 键存在即覆盖（含空数组 = 显式清空，与插件 mergeEntry 语义一致）
                if (data.ContainsKey("keywords")) fm = SetFmValue(fm, "keywords", ser.Serialize(kw));
                fm = SetFmValue(fm, "revision", Convert.ToString(revision + 1));
                fm = SetFmValue(fm, "updatedAt", JsonQuote(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")));
                // 桌面编辑 = 人工核验（与插件 updateDirect 同语义）：lastVerifiedAt 刷新，
                // 条目 freshness 回到 fresh 快速通道
                fm = SetFmValue(fm, "lastVerifiedAt", JsonQuote(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")));
                string finalBody = body != null ? body : oldBody;
                AtomicWriteText(file, "---\n" + fm + "\n---\n\n" + finalBody + "\n");
                RebuildMemoryIndex(packDir, packId);
                AppendMemoryAudit("update", packId, entryId, "allowed", "desktop-shell edit r" + (revision + 1));
                message = "已保存（revision " + (revision + 1) + "）";
                return true;
            }
            catch (Exception ex)
            {
                message = "保存失败：" + ex.Message;
                try { AppendMemoryAudit("update", null, entryIdForAudit, "failed", ex.Message); } catch { }
                return false;
            }
            finally
            {
                if (memoryLock != null) ReleaseMemoryLock(memoryLock);
            }
        }
    }
}
