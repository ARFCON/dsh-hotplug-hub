// PatchContractTests.cs — 跨语言契约行为等价断言（v5 阶段 4；CI 必须全绿）
//
// 覆盖（CONTRACT.md §1/§4/§5/§7）：
//   ① ValidPluginLoaderId（IsValidLoaderId）≡ PACK_ID_RE（先红后修：前导 . _ - 拒、
//      65 字符拒、字母数字开头收）；
//   ② CMD_SPECIAL_RE 注入向量矩阵；
//   ③ MergePatchSection 分节保留合并（JS 块/注释原样保留、替换、追加、移除）；
//   ④ 锁协议：文件名 .dsh-patch.lock、token `pid\nunix_ms`、互斥、pid 探活接管；
//   ⑤ AssertShellSafeArg/Url 白名单。
//
// 编译：csc /nologo /target:exe /out:PatchContractTests.exe PatchContract.cs PatchContractTests.cs
// 运行：PatchContractTests.exe（非零退出 = 存在失败断言）
using System;
using System.IO;
using System.Text;
using System.Diagnostics;

namespace DSHHotplugHub
{
    public static class PatchContractTestRunner
    {
        public static int Main()
        {
            try
            {
                return PatchContractTests.Run();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("UNHANDLED: " + ex.GetType().FullName + ": " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 2;
            }
        }
    }

    public static class PatchContractTests
    {
        private static int _failures = 0;
        private static int _passes = 0;

        private static void Check(bool cond, string name)
        {
            if (cond) { _passes++; Console.WriteLine("  PASS " + name); }
            else { _failures++; Console.WriteLine("  FAIL " + name); }
        }

        private static string TmpDir(string prefix)
        {
            return Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N").Substring(0, 8));
        }

        public static int Run()
        {
            Console.WriteLine("== PatchContract 契约测试 ==");

            // ① IsValidLoaderId ≡ PACK_ID_RE（R-v5-2 先红后修）
            Console.WriteLine("-- ① ValidPluginLoaderId ≡ PACK_ID_RE --");
            string[] accept = { "abc", "my-pack", "pack.one", "A1_b-c.d", "x".PadRight(64, 'x') };
            foreach (string v in accept) Check(PatchContract.IsValidLoaderId(v), "accept " + v);
            string[] reject = { "", "-abc", ".abc", "_abc", "abc ", "a/b", "a\\b", "a b", "x".PadRight(65, 'x'), null };
            foreach (string v in reject) Check(!PatchContract.IsValidLoaderId(v), "reject " + (v ?? "<null>"));

            // ② CMD_SPECIAL_RE 注入向量
            Console.WriteLine("-- ② CMD_SPECIAL_RE 注入向量 --");
            string[] special = { "a&b", "a|b", "a;b", "a`b", "a$(id)", "a(b)", "a<b", "a>b", "a\"b", "a'b", "a\\b", "a\u0000b", "a\nb" };
            foreach (string v in special) Check(PatchContract.HasCmdSpecialChars(v), "special " + v.Replace("\n", "\\n"));
            string[] safe = { "main", "v1.0.0", "feature/x", "owner/repo", "https://github.com/a/b.tgz" };
            foreach (string v in safe) Check(!PatchContract.HasCmdSpecialChars(v), "safe " + v);
            Check(PatchContract.AssertShellSafeUrl("https://github.com/a/b.tgz", "url") == "https://github.com/a/b.tgz", "AssertShellSafeUrl ok");
            bool urlRejected = false;
            try { PatchContract.AssertShellSafeUrl("javascript:alert(1)", "url"); }
            catch (ArgumentException) { urlRejected = true; }
            Check(urlRejected, "AssertShellSafeUrl reject javascript:");
            bool argRejected = false;
            try { PatchContract.AssertShellSafeArg("a&b", "profile"); }
            catch (ArgumentException) { argRejected = true; }
            Check(argRejected, "AssertShellSafeArg reject metachar");

            // ⑤b AssertShellSafeLocalFile（审计修复：内嵌 tgz 安装链静默失败回归的契约锁定）
            Console.WriteLine("-- ⑤b AssertShellSafeLocalFile 内嵌资源路径 --");
            string embeddedDir = PatchContract.EmbeddedTgzDir();
            Directory.CreateDirectory(embeddedDir);
            string goodPath = Path.Combine(embeddedDir, "dsh-memory-hub-0.8.0.tgz");
            File.WriteAllText(goodPath, "stub");
            Check(PatchContract.AssertShellSafeLocalFile(goodPath, "tarballUrl") == goodPath, "AssertShellSafeLocalFile accept 嵌入目录内 tgz");
            string[] localRejects =
            {
                null, "",
                embeddedDir + "\\no such file.tgz",                   // 文件名空白（文件名白名单拒；目录段空白放行——引号内安全）
                embeddedDir + "\\a&b.tgz",                             // & 元字符（文件名白名单拒）
                embeddedDir + "\\a|b.tgz",                             // | 元字符
                embeddedDir + "\\a^b.tgz",                             // ^ 元字符
                Path.Combine(Path.GetTempPath(), "evil.tgz"),          // 目录不在嵌入目录
                embeddedDir + "\\..\\evil.tgz",                        // .. 逃逸（解析后目录不匹配）
                "dsh-memory-hub-0.8.0.tgz",                            // 相对路径
                @"\\server\share\evil.tgz",                            // UNC 路径
            };
            foreach (string v in localRejects)
            {
                bool rejected = false;
                try { PatchContract.AssertShellSafeLocalFile(v, "tarballUrl"); }
                catch (ArgumentException) { rejected = true; }
                Check(rejected, "AssertShellSafeLocalFile reject " + (v == null ? "<null>" : v.Length > 48 ? v.Substring(0, 48) + "…" : v));
            }

            // ③ MergePatchSection 分节保留合并
            Console.WriteLine("-- ③ MergePatchSection 分节保留合并 --");
            string seeded = "# 顶部注释\n## hotplug:pack.a\n- insert:\n    - id: hp-old\n      name: 'old'\n      config: {}\n## desktop:keep\n- insert:\n    - id: keep\n      name: 'k'\n      config: {}\n";
            string merged = PatchContract.MergePatchSection(seeded, "desktop", "myplugin", "- id: myplugin\n  name: 'pkg'\n  disabled: true");
            Check(merged.Contains("# 顶部注释"), "注释保留");
            Check(merged.Contains("## hotplug:pack.a"), "JS 块保留");
            Check(merged.Contains("hp-old"), "JS 块内容保留");
            Check(merged.Contains("## desktop:keep"), "其它 desktop 块保留");
            Check(merged.Contains("## desktop:myplugin"), "新块已写入");
            Check(merged.Contains("    - id: keep"), "keep 块未被破坏");
            // 替换已有块
            string again = PatchContract.MergePatchSection(merged, "desktop", "myplugin", "- id: myplugin\n  name: 'pkg2'\n  disabled: true");
            Check(again.Split(new[] { "## desktop:myplugin" }, StringSplitOptions.None).Length == 2, "替换而非重复");
            Check(again.Contains("pkg2"), "内容已替换");
            // 移除块（空 blockYaml）
            string removed = PatchContract.MergePatchSection(again, "desktop", "myplugin", "");
            Check(!removed.Contains("desktop:myplugin"), "块已移除");
            Check(removed.Contains("## hotplug:pack.a"), "移除后 JS 块仍保留");
            // 旧单 # marker 读兼容
            string legacy = "# 顶部注释\n# desktop:myplugin\n- id: myplugin\n  name: 'x'\n  disabled: true\n## hotplug:pack.a\n- insert: []\n";
            string migrated = PatchContract.MergePatchSection(legacy, "desktop", "myplugin", "- id: myplugin\n  name: 'y'\n  disabled: true");
            Check(migrated.Contains("\n## desktop:myplugin\n"), "旧单 # marker 升级为 ##");
            Check(!migrated.Contains("\n# desktop:myplugin"), "旧单 # marker 已替换");
            Check(migrated.Contains("## hotplug:pack.a"), "迁移保留 JS 块");

            // ④ 锁协议
            Console.WriteLine("-- ④ 锁协议（.dsh-patch.lock / token / 互斥 / 探活接管） --");
            string dir = TmpDir("pc-lock-");
            Directory.CreateDirectory(dir);
            FileStream h1 = PatchContract.AcquirePatchLock(dir);
            string lockPath = Path.Combine(dir, ".dsh-patch.lock");
            Check(File.Exists(lockPath), "锁文件已创建（.dsh-patch.lock）");
            string token = PatchContract.ReadTokenText(lockPath);
            string[] tokenParts = token.Split('\n');
            int pid;
            long at;
            Check(tokenParts.Length >= 2 && int.TryParse(tokenParts[0].Trim(), out pid) && pid == Process.GetCurrentProcess().Id, "token 首行 = pid");
            Check(long.TryParse(tokenParts[1].Trim(), out at) && at > 0, "token 次行 = unix_ms");
            // 互斥：他人 pid 获取 → 超时抛错
            bool blocked = false;
            try { PatchContract.AcquirePatchLock(dir); }
            catch (IOException) { blocked = true; }
            Check(blocked, "持锁期间二次获取超时");
            PatchContract.ReleasePatchLock(h1, dir);
            Check(!File.Exists(lockPath), "释放后锁文件删除");
            // 已死 pid token → 立即接管
            File.WriteAllText(lockPath, "99999999\n" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "\n");
            FileStream h2 = PatchContract.AcquirePatchLock(dir);
            Check(h2 != null, "已死 pid 锁被接管");
            PatchContract.ReleasePatchLock(h2, dir);
            // 陈旧 token（pid 存活但超 30s）→ 接管
            File.WriteAllText(lockPath, Process.GetCurrentProcess().Id + "\n1\n");
            FileStream h3 = PatchContract.AcquirePatchLock(dir);
            Check(h3 != null, "陈旧 token 被接管");
            PatchContract.ReleasePatchLock(h3, dir);

            // C1（兼容性审计）：v1 目录锁迁移——已死持有者的 v1 目录锁被清理并重建为文件锁
            string v1Dir = Path.Combine(dir, ".dsh-patch.lock");
            Directory.CreateDirectory(v1Dir);
            File.WriteAllText(Path.Combine(v1Dir, "owner"),
                "{\"owner\":\"pid-99999999\",\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}\n");
            FileStream h4 = PatchContract.AcquirePatchLock(dir);
            Check(h4 != null, "v1 目录锁（已死 pid）被迁移接管");
            Check(File.Exists(lockPath) && !Directory.Exists(lockPath), "v1 目录锁已清理为 v2 文件锁");
            PatchContract.ReleasePatchLock(h4, dir);

            // C1：owner 损坏/缺失的 v1 目录锁 → 同样清理迁移（不闷等超时）
            Directory.CreateDirectory(v1Dir);
            File.WriteAllText(Path.Combine(v1Dir, "owner"), "not-json");
            FileStream h5 = PatchContract.AcquirePatchLock(dir);
            Check(h5 != null, "v1 目录锁（owner 损坏）被清理迁移");
            PatchContract.ReleasePatchLock(h5, dir);

            // C1：存活且新鲜的 v1 持有者 → 不迁移（等超时抛错）——无法在测试内造
            // 10s 等待，此处验证 held 判定本身：以本进程 pid + 当前时间构造
            Directory.CreateDirectory(v1Dir);
            File.WriteAllText(Path.Combine(v1Dir, "owner"),
                "{\"owner\":\"pid-" + Process.GetCurrentProcess().Id + "\",\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}\n");
            bool heldBlocked = false;
            try { PatchContract.AcquirePatchLock(dir); }
            catch (IOException) { heldBlocked = true; }
            Check(heldBlocked, "v1 目录锁（存活持有者）不迁移，等待至超时");
            Directory.Delete(v1Dir, true);

            // m7（安全审计）：ReleasePatchLock 不得删除他人锁（token pid != 自己）
            // 此前 finally 无条件 File.Delete，跨进程互斥可被误删打破
            Console.WriteLine("-- ⑥ ReleasePatchLock 拒绝释放他人锁（m7） --");
            string foreignDir = TmpDir("pc-release-foreign-");
            Directory.CreateDirectory(foreignDir);
            File.WriteAllText(Path.Combine(foreignDir, ".dsh-patch.lock"),
                (Process.GetCurrentProcess().Id + 1) + "\n" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "\n");
            PatchContract.ReleasePatchLock(null, foreignDir);
            Check(File.Exists(Path.Combine(foreignDir, ".dsh-patch.lock")),
                "ReleasePatchLock 拒绝释放他人锁（token pid != 自己 → 锁文件保留）");
            Directory.Delete(foreignDir, true);

            // m6（安全审计）：AssertShellSafeArg 字符集与 JS assertShellSafe 对齐
            Console.WriteLine("-- ⑤ 参数安全字符集（m6：≡ JS assertShellSafe） --");
            Check(SafeArg("my-tag_1", "tag"), "接受 my-tag_1");
            Check(SafeArg("v1.0.0", "tag"), "接受 v1.0.0");
            Check(!SafeArg("a/b", "tag"), "拒绝 a/b（含 /）");
            Check(!SafeArg("-abc", "tag"), "拒绝 -abc（首字符非字母数字）");
            Check(!SafeArg("a b", "tag"), "拒绝 a b（空白）");
            Check(!SafeArg("a&b", "tag"), "拒绝 a&b（元字符）");
            Check(!SafeArg("", "tag"), "拒绝空串");
            Check(!SafeArg(new string('x', 257), "tag"), "拒绝超长");

            // ⑦ 版本比较契约（自检/更新检测单一真源）
            Console.WriteLine("-- ⑦ CompareVersions / IsNewerVersion（自检/更新检测单一真源） --");
            Check(PatchContract.CompareVersions("1.0.0", "1.0.0") == 0, "1.0.0 == 1.0.0");
            Check(PatchContract.CompareVersions("0.9.8", "0.9.7") > 0, "0.9.8 > 0.9.7");
            Check(PatchContract.CompareVersions("0.9.7", "0.9.8") < 0, "0.9.7 < 0.9.8");
            Check(PatchContract.CompareVersions("v1.2.3", "1.2.3") == 0, "前导 v 视为相同");
            Check(PatchContract.CompareVersions("1.0.10", "1.0.9") > 0, "多位数段 10 > 9（非字符串比较）");
            Check(PatchContract.CompareVersions("1", "1.0.0") == 0, "缺失段按 0");
            Check(PatchContract.CompareVersions("1.0.0-alpha.1", "1.0.0") == 0, "pre 后缀整版本剥离（alpha.1 不再当第 4 段）");
            Check(PatchContract.CompareVersions("1.0.0+build.5", "1.0.0") == 0, "build 元数据剥离");
            Check(PatchContract.IsNewerVersion("0.9.8", "0.9.7"), "IsNewer 0.9.8>0.9.7");
            Check(!PatchContract.IsNewerVersion("1.0.0-alpha.1", "1.0.0"), "IsNewer pre 不误判 > release");
            Check(!PatchContract.IsNewerVersion("1.0.0", "1.0.0"), "IsNewer 相等 false");
            Check(!PatchContract.IsNewerVersion("0.9.7", "0.9.8"), "IsNewer 落后 false");
            Check(!PatchContract.IsNewerVersion("", "1.0.0"), "IsNewer 空 candidate false");
            Check(!PatchContract.IsNewerVersion("1.0.0", ""), "IsNewer 空 current false");
            Check(!PatchContract.IsNewerVersion(null, "1.0.0"), "IsNewer null candidate false");

            // ⑧ 内嵌资源目录族（PC1：进程隔离 PID 目录 vs 安全校验对齐——断裂回归锁定）
            Console.WriteLine("-- ⑧ EmbeddedTgzDirForProcess / IsEmbeddedTgzDir / AssertShellSafeLocalFile（PC1） --");
            string embBase = PatchContract.EmbeddedTgzDir();
            string embPid = PatchContract.EmbeddedTgzDirForProcess(4242);
            Check(PatchContract.IsEmbeddedTgzDir(embBase), "固定目录在族内");
            Check(PatchContract.IsEmbeddedTgzDir(embPid), "PID 后缀目录在族内（PC1 断裂点）");
            Check(PatchContract.IsEmbeddedTgzDir(embBase.TrimEnd('\\') + "\\"), "尾随分隔符容忍");
            Check(!PatchContract.IsEmbeddedTgzDir(Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-embedded-abc")), "非数字后缀拒绝");
            Check(!PatchContract.IsEmbeddedTgzDir(Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-embeddedx")), "前缀延展拒绝");
            Check(!PatchContract.IsEmbeddedTgzDir(Path.Combine(Path.GetTempPath(), "sub", "dsh-hotplug-hub-embedded")), "非 Temp 直接子目录拒绝");
            Check(!PatchContract.IsEmbeddedTgzDir(Path.Combine(Path.GetTempPath(), "..", "dsh-hotplug-hub-embedded")), "穿越目录拒绝");
            Check(!PatchContract.IsEmbeddedTgzDir(null), "null 拒绝");
            Check(!PatchContract.IsEmbeddedTgzDir(""), "空串拒绝");
            // ExtractEmbeddedTgz 的真实落盘形态（PID 目录 + 白名单文件名）必须过 AssertShellSafeLocalFile
            string pidTgz = Path.Combine(embPid, "dsh-memory-hub-0.8.0-pre.tgz");
            Check(SafeLocalFile(pidTgz), "PID 目录 + 合法文件名 → AssertShellSafeLocalFile 放行（PC1 主断言）");
            Check(SafeLocalFile(Path.Combine(embBase, "dseam-skillmcp-0.8.1-pre.tgz")), "固定目录 + 合法文件名放行");
            Check(!SafeLocalFile(Path.Combine(embPid, "evil name.tgz")), "文件名含空白拒绝");
            Check(!SafeLocalFile(Path.Combine(embPid, "ev;il.tgz")), "文件名含元字符拒绝");
            Check(!SafeLocalFile(Path.Combine(embPid, "ev&il.tgz")), "文件名含 & 拒绝");
            Check(!SafeLocalFile(Path.Combine(embPid, "../escape.tgz")), "相对穿越拒绝");
            Check(!SafeLocalFile(Path.Combine(Path.GetTempPath(), "dsh-hotplug-hub-embedded-999999999", "..", "..", "x.tgz")), "目录段穿越拒绝");
            Check(PatchContract.EmbeddedTgzDirForProcess(Process.GetCurrentProcess().Id).EndsWith(Convert.ToString(Process.GetCurrentProcess().Id)), "PID 拼接正确");

            // ⑨ 内嵌插件安装决策（PC2：三个内置插件统一防降级）
            Console.WriteLine("-- ⑨ ShouldInstallEmbedded / IsAtLeastVersion（PC2 防降级） --");
            Check(PatchContract.ShouldInstallEmbedded(null, "0.8.1-pre"), "未装 → 装");
            Check(PatchContract.ShouldInstallEmbedded("", "0.8.1-pre"), "空版本 → 装");
            Check(PatchContract.ShouldInstallEmbedded("0.8.0", "0.8.1-pre"), "更旧 → 装");
            Check(PatchContract.ShouldInstallEmbedded("0.8.1-pre2", "0.8.1-pre"), "同 core 不同 pre → 重装（无 marker 插件的同 core 传播语义）");
            Check(!PatchContract.ShouldInstallEmbedded("0.8.1-pre", "0.8.1-pre"), "完全相等 → 跳过");
            Check(!PatchContract.ShouldInstallEmbedded("0.8.2", "0.8.1-pre"), "已装更新 → 跳过（防降级主断言）");
            Check(!PatchContract.ShouldInstallEmbedded("1.0.0", "0.9.9"), "大版本已装更新 → 跳过");
            Check(!PatchContract.ShouldInstallEmbedded("0.8.0", "0.8.0-pre"), "已装正式版 vs 内置 pre → 跳过（semver 0.8.0 > 0.8.0-pre）");
            Check(PatchContract.ShouldInstallEmbedded("0.8.0-pre", "0.8.0"), "已装 pre vs 内置正式 → 装（升级）");
            Check(PatchContract.IsAtLeastVersion("0.8.1-pre", "0.8.1-pre"), "IsAtLeast 相等 true");
            Check(PatchContract.IsAtLeastVersion("0.8.0", "0.8.0-pre"), "IsAtLeast 正式 ≥ pre true");
            Check(!PatchContract.IsAtLeastVersion("0.8.0-pre", "0.8.0"), "IsAtLeast pre < 正式 false");
            Check(PatchContract.IsAtLeastVersion("0.9.0", "0.8.9"), "IsAtLeast 数值段 true");
            Check(!PatchContract.IsAtLeastVersion(null, "1.0.0"), "IsAtLeast null false");
            Check(!PatchContract.IsAtLeastVersion("", "1.0.0"), "IsAtLeast 空 false");

            // ⑩ 插件源白名单（PC24：IsValidPluginSpec 迁移行为锁定）
            Console.WriteLine("-- ⑩ IsValidPluginSpec（PC24 迁移） --");
            Check(PatchContract.IsValidPluginSpec("@dsh-community/pkg"), "scoped 包名放行");
            Check(PatchContract.IsValidPluginSpec("pkg@1.2.3"), "精确版本 spec 放行");
            Check(!PatchContract.IsValidPluginSpec("pkg@^1.2.3"), "^ 拒绝（cmd 转义元字符，防御性拒绝）");
            Check(PatchContract.IsValidPluginSpec("https://github.com/o/r@v1"), "GitHub URL 放行");
            Check(PatchContract.IsValidPluginSpec("a:b"), "冒号放行");
            Check(!PatchContract.IsValidPluginSpec(""), "空拒绝");
            Check(!PatchContract.IsValidPluginSpec(null), "null 拒绝");
            Check(!PatchContract.IsValidPluginSpec("a b"), "空白拒绝");
            Check(!PatchContract.IsValidPluginSpec("a&b"), "& 拒绝");
            Check(!PatchContract.IsValidPluginSpec("a|b"), "| 拒绝");
            Check(!PatchContract.IsValidPluginSpec("a\"b"), "引号拒绝");
            Check(!PatchContract.IsValidPluginSpec("a'b"), "单引号拒绝");
            Check(!PatchContract.IsValidPluginSpec("a%b"), "% 拒绝（cmd 变量展开）");
            Check(!PatchContract.IsValidPluginSpec("a`b"), "反引号拒绝");
            Check(!PatchContract.IsValidPluginSpec("a\\b"), "反斜杠拒绝");
            Check(!PatchContract.IsValidPluginSpec("a;b"), "分号拒绝");

            // ⑪ 插件启停手术（PC24：TogglePluginSection / HasDisabledEntry / loader id 决议）
            Console.WriteLine("-- ⑪ TogglePluginSection / HasDisabledEntry / ResolveLoaderId（PC24） --");
            // 关闭（无既有条目）→ 追加 ## desktop:<id> 契约块
            string basePatch = "# 保留注释\n- insert:\n  - id: memory-hub\n    name: dsh-memory-hub\n";
            string disabled = PatchContract.TogglePluginSection(basePatch, "memory-hub", false, "dsh-memory-hub");
            Check(disabled.Contains("## desktop:memory-hub"), "关闭追加契约 marker");
            Check(disabled.Contains("- id: memory-hub\n  name: 'dsh-memory-hub'\n  disabled: true"), "关闭写入 disabled:true 块");
            Check(disabled.Contains("# 保留注释"), "无关注释保留");
            Check(!disabled.Contains("- insert:\n  - id: memory-hub"), "insert 内层条目移除");
            Check(PatchContract.HasDisabledEntry(disabled, "memory-hub"), "HasDisabledEntry 命中");
            Check(!PatchContract.HasDisabledEntry(disabled, "other-hub"), "HasDisabledEntry 不误命中");
            // 再启用 → 契约块清除、insert 恢复由插件自带 patch 提供（本手术只移除 disabled）
            string reEnabled = PatchContract.TogglePluginSection(disabled, "memory-hub", true, "dsh-memory-hub");
            Check(!reEnabled.Contains("## desktop:memory-hub"), "启用移除契约块");
            Check(!PatchContract.HasDisabledEntry(reEnabled, "memory-hub"), "启用后无 disabled");
            Check(reEnabled.Contains("# 保留注释"), "启用保留无关注释");
            // 官方壳语义条目（无 marker、顶层 - id + disabled:true）双向兼容
            string officialPatch = "- id: ui-guard\n  name: dsh-ui-guard\n  disabled: true\n";
            Check(PatchContract.HasDisabledEntry(officialPatch, "ui-guard"), "官方壳条目识别");
            string officialEnabled = PatchContract.TogglePluginSection(officialPatch, "ui-guard", true, "dsh-ui-guard");
            Check(!PatchContract.HasDisabledEntry(officialEnabled, "ui-guard"), "官方壳条目可启用");
            // 含 config: 的官方条目启用时保留条目本身（只去 disabled 行）
            string officialConfig = "- id: modlens\n  config:\n    foo: bar\n  disabled: true\n";
            string ocEnabled = PatchContract.TogglePluginSection(officialConfig, "modlens", true, "@liustack/modlens");
            Check(ocEnabled.Contains("config:"), "含 config 条目保留");
            Check(!PatchContract.HasDisabledEntry(ocEnabled, "modlens"), "含 config 条目去 disabled");
            // 非法 id 抛 ArgumentException
            bool threw = false;
            try { PatchContract.TogglePluginSection("", "../evil", false, "x"); }
            catch (ArgumentException) { threw = true; }
            Check(threw, "非法 id 抛 ArgumentException");
            Check(!PatchContract.HasDisabledEntry(officialPatch, "../evil"), "HasDisabledEntry 非法 id false");
            // 幂等：关闭两次结果稳定
            string twice = PatchContract.TogglePluginSection(disabled, "memory-hub", false, "dsh-memory-hub");
            Check(PatchContract.HasDisabledEntry(twice, "memory-hub"), "重复关闭仍 disabled");
            Check((twice.Split(new[] { "## desktop:memory-hub" }, StringSplitOptions.None).Length - 1) == 1, "重复关闭不追加第二个契约块");
            // CRLF 输入兼容
            string crlfPatch = officialPatch.Replace("\n", "\r\n");
            Check(PatchContract.HasDisabledEntry(crlfPatch, "ui-guard"), "CRLF 输入识别");
            // loader id 决议三源
            string bundlePatch = "- insert:\n  - id: dsh-market\n    name: dshmarket\n";
            Check(PatchContract.ResolveLoaderId(bundlePatch, null, "dshmarket") == "dsh-market", "bundle patch 优先");
            string profilePatch = "- insert:\n  - id: legacy-hub\n    name: dsh-hub\n";
            Check(PatchContract.ResolveLoaderId(null, profilePatch, "dsh-hub") == "legacy-hub", "profile patch 反查次之");
            Check(PatchContract.ResolveLoaderId(null, null, "@scope/pkg") == "pkg", "净化名兜底");
            Check(PatchContract.ResolveLoaderId(null, null, "全中文") != "全中文", "非 ASCII 包名净化");
            Check(PatchContract.FirstInsertIdFromPatch(null) == null, "FirstInsertId null 输入 null");
            Check(PatchContract.YamlSingleQuote("it's") == "'it''s'", "YamlSingleQuote 单引号转义");

            // ⑫ SpecSatisfiedBy 宽松 semver range（PC24 迁移 + 扩充）
            Console.WriteLine("-- ⑫ SpecSatisfiedBy（PC24） --");
            Check(PatchContract.SpecSatisfiedBy("^1.2.3", "1.2.3"), "^1.2.3 ⊇ 1.2.3");
            Check(PatchContract.SpecSatisfiedBy("^1.2.3", "1.9.0"), "^1.2.3 ⊇ 1.9.0");
            Check(!PatchContract.SpecSatisfiedBy("^1.2.3", "2.0.0"), "^1.2.3 ⊉ 2.0.0");
            Check(!PatchContract.SpecSatisfiedBy("^1.2.3", "1.1.9"), "^1.2.3 ⊉ 1.1.9");
            Check(PatchContract.SpecSatisfiedBy("^0.4.1", "0.4.9"), "^0.4.1 ⊇ 0.4.9（0.x 锁 minor）");
            Check(!PatchContract.SpecSatisfiedBy("^0.4.1", "0.5.0"), "^0.4.1 ⊉ 0.5.0");
            Check(PatchContract.SpecSatisfiedBy("~1.2.3", "1.2.9"), "~1.2.3 ⊇ 1.2.9");
            Check(!PatchContract.SpecSatisfiedBy("~1.2.3", "1.3.0"), "~1.2.3 ⊉ 1.3.0");
            Check(PatchContract.SpecSatisfiedBy(">=1.0.0", "3.2.1"), ">=1.0.0 ⊇ 3.2.1");
            Check(PatchContract.SpecSatisfiedBy("1.2.3", "1.2.3"), "精确匹配");
            Check(!PatchContract.SpecSatisfiedBy("1.2.3", "1.2.4"), "精确不匹配");
            Check(PatchContract.SpecSatisfiedBy("*", "9.9.9"), "* 恒满足");
            Check(PatchContract.SpecSatisfiedBy("", "1.0.0"), "空 spec 恒满足");
            Check(PatchContract.SpecSatisfiedBy("latest", "1.0.0"), "latest 恒满足");
            Check(PatchContract.SpecSatisfiedBy("file:../local", "1.0.0"), "file: 形式恒满足");
            Check(PatchContract.SpecSatisfiedBy("https://x/y.tgz", "1.0.0"), "URL 形式恒满足");
            Check(PatchContract.SpecSatisfiedBy("not-a-version", "1.0.0"), "无法解析 spec 恒满足（防误报）");
            Check(PatchContract.SpecSatisfiedBy("v1.2.3", "v1.2.3"), "v 前缀归一");
            Check(PatchContract.NormalizeVersionString("v0.8.0-pre") == "0.8.0-pre", "NormalizeVersionString 剥 v");
            Check(PatchContract.NormalizeVersionString(" 1.2 ") == "1.2", "NormalizeVersionString 剥空白");
            Check(PatchContract.NormalizeVersionString(null) == null, "NormalizeVersionString null");

            Directory.Delete(dir, true);

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }

        private static bool SafeArg(string value, string what)
        {
            try { PatchContract.AssertShellSafeArg(value, what); return true; }
            catch (ArgumentException) { return false; }
        }

        private static bool SafeLocalFile(string value)
        {
            try { PatchContract.AssertShellSafeLocalFile(value, "tarballUrl"); return true; }
            catch (ArgumentException) { return false; }
        }
    }
}
