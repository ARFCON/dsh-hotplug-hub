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

            Directory.Delete(dir, true);

            Console.WriteLine("== 结果：PASS=" + _passes + " FAIL=" + _failures + " ==");
            return _failures == 0 ? 0 : 1;
        }

        private static bool SafeArg(string value, string what)
        {
            try { PatchContract.AssertShellSafeArg(value, what); return true; }
            catch (ArgumentException) { return false; }
        }
    }
}
