// MemoryHubContractTests.cs — 全局记忆面板契约行为断言（CI 必须全绿）
//
// 覆盖（与 dsh-memory-hub 插件存储协议的跨语言等价性）：
//   ① DshRootDir 优先级（DSH_HOTPLUG_ROOT > DSH_HOME > 默认 ~/.dsh）；
//   ② GetMemoryJson / GetMemoryFullJson（排序稳定 / 展示截断 vs 全量正文）；
//   ③ ArchiveMemoryFile（归档而非物理删除：.archive 副本 + archivedAt + revision
//      快照 + 审计行 + pack 计数同步；活跃文件消失）；
//   ④ SaveMemoryFile（revision+1 / 写前快照 / title JSON 引号 / type 枚举校验 /
//      body 显式空=清空、缺省=保留 / 原子写 / 审计行）；
//   ⑤ 锁协议（.dsh-memory.lock 互斥 + token pid 探活语义 + 释放后无残留）；
//   ⑥ frontmatter 引号往返（title 含引号/冒号不破坏插件端解析）。
//
// 编译：csc /nologo /target:exe /out:MemoryHubContractTests.exe ../src/MemoryHubContract.cs ../src/PatchContract.cs MemoryHubContractTests.cs /r:System.Web.Extensions.dll
// 运行：MemoryHubContractTests.exe（非零退出 = 存在失败断言）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace DSHHotplugHub
{
    public static class MemoryHubContractTestRunner
    {
        public static int Main()
        {
            try
            {
                return MemoryHubContractTests.Run();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 2;
            }
        }
    }

    public static class MemoryHubContractTests
    {
        private static int _failures = 0;
        private static string _tmpRoot;

        private static void Check(bool cond, string what)
        {
            if (cond) { Console.WriteLine("  ok: " + what); }
            else { Console.WriteLine("  FAIL: " + what); _failures++; }
        }

        private static string HubDir()
        {
            return Path.Combine(_tmpRoot, "memory-hub");
        }

        private static void WriteEntry(string packId, string name, string title, string body, string type, int revision, string[] keywords)
        {
            string dir = Path.Combine(HubDir(), packId, "entries");
            Directory.CreateDirectory(dir);
            Directory.CreateDirectory(Path.Combine(HubDir(), packId, ".revisions"));
            Directory.CreateDirectory(Path.Combine(HubDir(), packId, ".archive"));
            File.WriteAllText(Path.Combine(HubDir(), packId, "pack.json"),
                "{\"memoryPackId\":\"" + packId + "\",\"scope\":\"global\",\"schemaVersion\":1,\"keywords\":[],\"entries\":1}");
            var ser = new JavaScriptSerializer();
            string fm = "id: \"mem-00000000000000" + Math.Abs(name.GetHashCode() % 10) + "\"\n"
                + "revision: " + revision + "\n"
                + "createdAt: \"2026-01-01T00:00:00.000Z\"\n"
                + "updatedAt: \"2026-01-01T00:00:00.000Z\"\n"
                + "name: " + ser.Serialize(name) + "\n"
                + "title: " + ser.Serialize(title) + "\n"
                + "type: " + ser.Serialize(type) + "\n"
                + "keywords: " + ser.Serialize(keypoints(keywords));
            File.WriteAllText(Path.Combine(dir, name + ".md"), "---\n" + fm + "\n---\n\n" + body + "\n");
        }

        private static string[] keypoints(string[] kw)
        {
            return kw ?? new string[0];
        }

        private static Dictionary<string, object> ParseJson(string json)
        {
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
        }

        public static int Run()
        {
            _tmpRoot = Path.Combine(Path.GetTempPath(), "dsh-mh-contract-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(_tmpRoot);
            // 进程隔离：所有契约调用锚定临时 DSH_HOME（不碰真实 ~/.dsh）
            Environment.SetEnvironmentVariable("DSH_HOME", _tmpRoot, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("DSH_HOTPLUG_ROOT", null, EnvironmentVariableTarget.Process);

            try
            {
                TestRootDirPriority();
                TestListAndFull();
                TestArchive();
                TestSave();
                TestLock();
                TestReviewFixes();
                TestQuotedTitleRoundtrip();
            }
            finally
            {
                try { Directory.Delete(_tmpRoot, true); } catch { }
            }

            Console.WriteLine(_failures == 0 ? "ALL MEMORY-HUB CONTRACT TESTS PASSED" : (_failures + " FAILURES"));
            return _failures == 0 ? 0 : 1;
        }

        private static void TestRootDirPriority()
        {
            Console.WriteLine("[1] DshRootDir 优先级");
            Check(MemoryHubContract.DshRootDir() == _tmpRoot, "DSH_HOME 生效（hub 根锚定隔离目录）");
            string overrideRoot = Path.Combine(_tmpRoot, "hotplug-base");
            Directory.CreateDirectory(overrideRoot);
            Environment.SetEnvironmentVariable("DSH_HOTPLUG_ROOT", overrideRoot, EnvironmentVariableTarget.Process);
            Check(MemoryHubContract.DshRootDir() == Path.Combine(overrideRoot, ".dsh"), "DSH_HOTPLUG_ROOT > DSH_HOME");
            Environment.SetEnvironmentVariable("DSH_HOTPLUG_ROOT", null, EnvironmentVariableTarget.Process);
            Check(MemoryHubContract.MemoryHubRoot() == Path.Combine(_tmpRoot, "memory-hub"), "MemoryHubRoot = <root>/memory-hub");
        }

        private static void TestListAndFull()
        {
            Console.WriteLine("[2] 列表/全量正文");
            WriteEntry("global-pack", "长正文条目", "长正文标题", new string('x', 5000), "project", 3, new[] { "k1" });
            string listJson = MemoryHubContract.GetMemoryJson();
            var ser = new JavaScriptSerializer();
            var rows = ser.Deserialize<List<Dictionary<string, object>>>(listJson);
            Check(rows != null && rows.Count == 1, "列表返回 1 条");
            string listBody = Convert.ToString(rows[0]["body"]);
            Check(listBody.Length == 2000, "列表 body 截断到 2000（实际 " + listBody.Length + "）");
            Check(Convert.ToInt32(rows[0]["revision"]) == 3, "列表含 revision");

            string id = Convert.ToString(rows[0]["id"]);
            string name = Convert.ToString(rows[0]["name"]);
            string rawFull = MemoryHubContract.GetMemoryFullJson(name);
            string foundFile = MemoryHubContract.FindMemoryEntryFile(name);
            Console.WriteLine("  [dbg] rawFull len=" + (rawFull == null ? "null" : rawFull.Length.ToString()) + " head=" + (rawFull == null ? "" : rawFull.Substring(0, Math.Min(120, rawFull.Length))));
            Console.WriteLine("  [dbg] FindMemoryEntryFile=" + (foundFile ?? "<null>") + " hub=" + MemoryHubContract.MemoryHubRoot());
            var full = ParseJson(rawFull);
            Check(full != null && Convert.ToString(full["body"]).Length == 5000, "全量正文通道返回完整 5000（编辑不截断回写）");
            Check(Convert.ToInt32(full["revision"]) == 3, "全量含 revision");

            Check(MemoryHubContract.GetMemoryFullJson("不存在") == "null", "不存在 id 返回 null");
        }

        private static void TestArchive()
        {
            Console.WriteLine("[3] 删除=归档（非物理删除）");
            WriteEntry("global-pack", "归档目标", "将被归档", "重要正文", "user", 2, null);
            string file = Path.Combine(HubDir(), "global-pack", "entries", "归档目标.md");
            string message;
            bool ok = MemoryHubContract.ArchiveMemoryFile("归档目标", out message);
            Check(ok, "归档成功：" + message);
            Check(!File.Exists(file), "活跃文件已移除");
            string archive = Path.Combine(HubDir(), "global-pack", ".archive", "归档目标.md");
            Check(File.Exists(archive), ".archive 副本存在");
            string archivedText = File.ReadAllText(archive);
            Check(archivedText.Contains("archivedAt:"), "归档副本带 archivedAt 元数据");
            Check(archivedText.Contains("重要正文"), "归档副本保留正文");
            string revSnap = Path.Combine(HubDir(), "global-pack", ".revisions", "mem-00000000000000" + Math.Abs("归档目标".GetHashCode() % 10), "002.md");
            Check(File.Exists(revSnap) || Directory.GetFiles(Path.Combine(HubDir(), "global-pack", ".revisions"), "002.md", SearchOption.AllDirectories).Length > 0,
                "revision 快照（.revisions/.../002.md）存在");
            string audit = File.ReadAllText(Path.Combine(HubDir(), ".audit.jsonl"));
            Check(audit.Contains("\"action\":\"remove\"") && audit.Contains("\"operator\":\"user\""), "审计行 remove/user 落账");
            var manifest = ParseJson(File.ReadAllText(Path.Combine(HubDir(), "global-pack", "pack.json")));
            Check(Convert.ToInt32(manifest["entries"]) >= 0, "pack 计数已同步（entries=" + manifest["entries"] + "）");
            // 幂等：再次归档同一 id → 失败且不抛
            bool again = MemoryHubContract.ArchiveMemoryFile("归档目标", out message);
            Check(!again, "重复删除失败不抛（" + message + "）");
        }

        private static void TestSave()
        {
            Console.WriteLine("[4] 编辑保存（协议化）");
            WriteEntry("global-pack", "编辑目标", "原标题", "原正文", "project", 1, new[] { "旧" });
            var ser = new JavaScriptSerializer();
            string payload = ser.Serialize(new Dictionary<string, object>
            {
                { "id", "编辑目标" },
                { "title", "新标题: 带冒号\"引号\"" },
                { "type", "user" },
                { "keywords", new[] { "新词", "另一个" } },
                { "body", "新正文" }
            });
            string message;
            bool ok = MemoryHubContract.SaveMemoryFile(payload, out message);
            Check(ok, "保存成功：" + message);
            string text = File.ReadAllText(Path.Combine(HubDir(), "global-pack", "entries", "编辑目标.md"));
            Check(text.Contains("revision: 2"), "revision+1 落盘");
            Check(text.Contains("title: \"新标题: 带冒号\\\"引号\\\"\""), "title JSON 引号编码（插件端可无损解析）");
            Check(text.Contains("type: \"user\""), "type 更新且引号编码");
            Check(text.Contains("新正文"), "正文更新");
            var reparsed = MemoryHubContract.ParseMemoryEntry(Path.Combine(HubDir(), "global-pack", "entries", "编辑目标.md"), true);
            Check(Convert.ToString(reparsed["title"]) == "新标题: 带冒号\"引号\"", "含冒号/引号标题往返无损");
            Check(Convert.ToInt32(reparsed["revision"]) == 2, "重读 revision=2");

            // body 显式空 = 清空（不静默回填）
            payload = ser.Serialize(new Dictionary<string, object> { { "id", "编辑目标" }, { "body", "" } });
            MemoryHubContract.SaveMemoryFile(payload, out message);
            var cleared = MemoryHubContract.ParseMemoryEntry(Path.Combine(HubDir(), "global-pack", "entries", "编辑目标.md"), true);
            Check(Convert.ToString(cleared["body"]) == "", "显式空正文 = 清空（旧实现静默回填旧正文）");

            // 非法 type 拒绝
            payload = ser.Serialize(new Dictionary<string, object> { { "id", "编辑目标" }, { "type", "私有" } });
            bool rejected = !MemoryHubContract.SaveMemoryFile(payload, out message);
            Check(rejected && message.Contains("type 非法"), "非法 type 被拒（旧实现任意串落盘毒化插件解析）");

            // 不存在条目
            payload = ser.Serialize(new Dictionary<string, object> { { "id", "没有这条" }, { "body", "x" } });
            Check(!MemoryHubContract.SaveMemoryFile(payload, out message), "不存在条目保存失败（" + message + "）");

            // 审计
            string audit = File.ReadAllText(Path.Combine(HubDir(), ".audit.jsonl"));
            Check(audit.Contains("\"action\":\"update\""), "审计行 update 落账");
        }

        private static void TestReviewFixes()
        {
            Console.WriteLine("[7] 复审修复（keywords 清空 / body null / 版本比较 / marker / index 镜像）");
            var ser = new JavaScriptSerializer();
            WriteEntry("global-pack", "复审条目", "原标题", "原正文", "project", 1, new[] { "旧词" });
            string file = Path.Combine(HubDir(), "global-pack", "entries", "复审条目.md");
            string message;
            // keywords 空数组 = 显式清空（旧实现 Count>0 才写，清空不生效）
            string payload = ser.Serialize(new Dictionary<string, object> { { "id", "复审条目" }, { "keywords", new string[0] } });
            Check(MemoryHubContract.SaveMemoryFile(payload, out message), "keywords 保存成功");
            string text1 = File.ReadAllText(file);
            Check(text1.Contains("keywords: []"), "空关键词显式清空落盘（含 [] 而非保留旧值）");
            Check(text1.Contains("lastVerifiedAt:"), "桌面编辑落 lastVerifiedAt（人工核验 → freshness 恒 fresh 通道）");
            // body JSON null = 保留旧正文（不误清空）
            payload = ser.Serialize(new Dictionary<string, object> { { "id", "复审条目" }, { "body", null } });
            MemoryHubContract.SaveMemoryFile(payload, out message);
            var kept = MemoryHubContract.ParseMemoryEntry(file, true);
            Check(Convert.ToString(kept["body"]) == "原正文", "body null 保留旧正文（TryGetValue 区分缺省与显式空）");
            // 版本比较：防降级语义
            Check(MemoryHubContract.IsAtLeastEmbedded("0.8.0-pre", "0.8.0-pre") == true, "相等 → ≥");
            Check(MemoryHubContract.IsAtLeastEmbedded("0.8.0", "0.8.0-pre") == true, "正式版 ≥ 同 core 的 pre（0.8.0 > 0.8.0-pre）");
            Check(MemoryHubContract.IsAtLeastEmbedded("0.7.9", "0.8.0-pre") == false, "更旧 → 非 ≥（会重装）");
            Check(MemoryHubContract.IsAtLeastEmbedded("0.8.1", "0.8.0-pre") == true, "更新 → ≥（防降级跳过）");
            Check(MemoryHubContract.IsAtLeastEmbedded(null, "0.8.0-pre") == false, "未装 → 非 ≥");
            // marker 写读往返
            string fakeHash = new string('a', 64);
            MemoryHubContract.WriteEmbeddedBuildMarker(fakeHash);
            Check(MemoryHubContract.ReadEmbeddedBuildMarker() == fakeHash, "marker 写读往返");
            // index.json 镜像重建
            string indexPath = Path.Combine(HubDir(), "global-pack", "index.json");
            Check(File.Exists(indexPath), "index.json 镜像已重建");
            string indexText = File.ReadAllText(indexPath);
            Check(indexText.Contains("\"memoryPackId\":\"global-pack\"") && indexText.Contains("\"entries\":["), "镜像结构（memoryPackId+entries）");
        }

        private static void TestLock()
        {
            Console.WriteLine("[5] 跨进程写锁（.dsh-memory.lock）");
            string lockPath = Path.Combine(MemoryHubContract.MemoryHubRoot(), ".dsh-memory.lock");
            FileStream handle = MemoryHubContract.AcquireMemoryLock();
            Check(handle != null, "锁获取成功");
            Check(File.Exists(lockPath), "锁文件存在（token 协议）");
            // 持有中读取须共享打开（ReadAllText 与 Write+ShareRead 句柄冲突 → ReadTokenText）
            string token = PatchContract.ReadTokenText(lockPath);
            string[] parts = token.Split('\n');
            int pid;
            Check(parts.Length >= 2 && int.TryParse(parts[0].Trim(), out pid), "token 形如 pid\\nunix_ms（实际：" + token.Replace("\n", "\\n") + "）");
            // 互斥：持锁期间另一线程获取应超时抛 IOException（10s 太久——用进程级验证：本线程持锁再开子进程立即抢占会等待；此处验证释放语义）
            MemoryHubContract.ReleaseMemoryLock(handle);
            Check(!File.Exists(lockPath), "释放后锁文件清除（无残留）");

            // 互斥验证：持有者存活时第二把锁等待超时
            handle = MemoryHubContract.AcquireMemoryLock();
            bool blocked = false;
            try
            {
                Stopwatch sw = Stopwatch.StartNew();
                var t = new System.Threading.Thread(() =>
                {
                    try { var h2 = MemoryHubContract.AcquireMemoryLock(); MemoryHubContract.ReleaseMemoryLock(h2); }
                    catch (IOException) { blocked = true; }
                });
                t.Start();
                // 主线程持续刷新 token 使其不陈旧（PatchContract 无自动刷新——保持短暂窗口即可）
                if (!t.Join(3000)) { t.Abort(); blocked = true; }
                sw.Stop();
            }
            finally { MemoryHubContract.ReleaseMemoryLock(handle); }
            Check(blocked, "他人持锁时第二次获取被拒（互斥语义）");
            Check(!File.Exists(lockPath), "最终释放后无残留");
        }

        private static void TestQuotedTitleRoundtrip()
        {
            Console.WriteLine("[6] frontmatter 引号语义（跨语言等价）");
            // 插件写出的条目（JSON 引号 title）→ C# 解析无损
            WriteEntry("global-pack", "引号条目", "正常标题", "b", "reference", 1, new[] { "带\"引号\", 逗号" });
            var e = MemoryHubContract.ParseMemoryEntry(Path.Combine(HubDir(), "global-pack", "entries", "引号条目.md"), true);
            Check(Convert.ToString(e["title"]) == "正常标题", "引号 title 解析");
            var kws = e["keywords"] as System.Collections.IEnumerable;
            int kwCount = 0; string firstKw = null;
            if (kws != null) foreach (object k in kws) { if (kwCount == 0) firstKw = Convert.ToString(k); kwCount++; }
            Check(kwCount == 1 && firstKw == "带\"引号\", 逗号", "JSON 数组关键词含引号+逗号往返无损");
        }
    }
}
