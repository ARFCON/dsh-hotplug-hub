// PatchContract.cs — DSH-Hotplug-Hub 跨语言契约的 C# 等价实现（CONTRACT.md §1/§4/§5/§7）
//
// 与 packages/shared-core 保持一致（release/tests/PatchContractTests.cs 行为等价断言）：
//   - PACK_ID_RE：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（字母数字开头，1..64，允许 . _ -）
//   - CMD_SPECIAL_RE：可进入 shell 解释的元字符 + 控制字符
//   - 锁协议：`<profile>/.dsh-patch.lock`，FileMode.CreateNew(=wx)，token `pid\nunix_ms`，
//     pid 探活（Process.GetProcessById），30s 过期接管，他用户保守不接管
//   - cordis.patch.yml 分节合并：marker `## <owner>:<id>`（读兼容单 #），替换目标块、
//     其余块/注释原样保留，永不整文件覆盖
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

namespace DSHHotplugHub
{
    /// <summary>跨语言契约的 C# 侧等价实现（单一真源 = packages/shared-core/CONTRACT.md）。</summary>
    public static class PatchContract
    {
        // PACK_ID_RE：与 shared-core 逐字等价（首字符字母数字；1..64；允许 . _ -）
        public const string PACK_ID_RE_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
        public const int MAX_ID_LENGTH = 64;

        // CMD_SPECIAL_RE：可进入 shell 解释的元字符 + 控制字符（shared security/shell）
        public const string CMD_SPECIAL_RE_SOURCE = "[\\u0000-\\u001f\\u007f&|;`$()<>\"'\\\\]";
        private static readonly Regex CmdSpecialRe = new Regex(CMD_SPECIAL_RE_SOURCE);

        // 契约 marker 行：`# <owner>:<id>` 或 `## <owner>:<id>`（读兼容单 #）
        private static readonly Regex PatchMarkerRe = new Regex("^#{1,2}\\s+([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)\\s*$");

        // 锁协议常量（CONTRACT.md §5）
        public const string PatchLockFileName = ".dsh-patch.lock";
        private const int LockWaitMs = 10000;
        private const int LockStaleMs = 30000;
        private const int LockPollMs = 100;

        /// <summary>loader id 白名单：与 PACK_ID_RE 对齐（R-v5-2 / §4.2①）。
        /// 曾为 `^[A-Za-z0-9_.-]+$`（允许前导 . _ -、无 64 上限）——一次性破坏性收紧。</summary>
        public static bool IsValidLoaderId(string id)
        {
            if (string.IsNullOrEmpty(id) || id.Length > MAX_ID_LENGTH) return false;
            return Regex.IsMatch(id, PACK_ID_RE_SOURCE);
        }

        /// <summary>命令注入防护：值含 shell 元字符/控制字符 → true（H-7 端口）。</summary>
        public static bool HasCmdSpecialChars(string value)
        {
            return !string.IsNullOrEmpty(value) && CmdSpecialRe.IsMatch(value);
        }

        // m6（安全审计）：与 JS assertShellSafe 对齐的严格单段字符集
        // （`^[0-9A-Za-z][0-9A-Za-z._-]*$`；首字符必须字母数字）——C# 侧此前只查
        // 元字符/空白，'/' 等非法字符会放行而 JS 拒绝，属契约分歧。
        private static readonly Regex ShellSafeRe = new Regex("^[0-9A-Za-z][0-9A-Za-z._-]*$");

        /// <summary>把值安全地作为单个 argv 参数使用（拒绝含元字符/空白/字符集外字符的值）。</summary>
        public static string AssertShellSafeArg(string value, string what)
        {
            if (string.IsNullOrEmpty(value)) throw new ArgumentException(what + " 必须是非空字符串");
            if (value.Length > 256) throw new ArgumentException(what + " 过长");
            if (HasCmdSpecialChars(value) || Regex.IsMatch(value, "\\s")) throw new ArgumentException(what + " 含 shell 元字符或空白");
            if (!ShellSafeRe.IsMatch(value)) throw new ArgumentException(what + " 含非法字符（允许 [0-9A-Za-z._-]，首字符须字母数字）");
            return value;
        }

        /// <summary>URL 级安全校验（tarballUrl 等）：http(s)、无空白/元字符。</summary>
        public static string AssertShellSafeUrl(string value, string what)
        {
            if (string.IsNullOrEmpty(value)) throw new ArgumentException(what + " 必须是非空字符串");
            if (value.Length > 4096) throw new ArgumentException(what + " 过长");
            if (HasCmdSpecialChars(value) || Regex.IsMatch(value, "\\s")) throw new ArgumentException(what + " 含 shell 元字符或空白");
            if (!value.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !value.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException(what + " 必须是 http(s) URL");
            return value;
        }

        // ---------- 锁协议（CONTRACT.md §5；与 JS shared fs/lock 等价） ----------

        /// <summary>锁路径：<profile>/.dsh-patch.lock（四写者共用）。</summary>
        public static string PatchLockPath(string profileDir)
        {
            return Path.Combine(profileDir, PatchLockFileName);
        }

        /// <summary>获取补丁锁（CreateNew=wx 独占 + token `pid\nunix_ms` + pid 探活 + 过期接管）。
        /// C1（兼容性审计）：含 v1 目录锁迁移——lockPath 为目录形态（v1 旧锁）时读
        /// <lockPath>/owner（JSON {owner:"pid-<pid>", at}）判定：持有者存活且未过期则
        /// 等待；否则清理目录重建为 v2 文件锁（与 JS checkV1DirectoryLock 语义一致）。</summary>
        public static FileStream AcquirePatchLock(string profileDir)
        {
            string lockPath = PatchLockPath(profileDir);
            Directory.CreateDirectory(profileDir);
            long deadline = Environment.TickCount + LockWaitMs;
            for (;;)
            {
                if (IsDirectoryLock(lockPath))
                {
                    if (CheckV1DirectoryLock(lockPath, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
                    {
                        // v1 锁仍被持有：等待（与 JS acquireLock 的 held 分支一致）
                        if (Environment.TickCount >= deadline) break;
                        Thread.Sleep(LockPollMs);
                        continue;
                    }
                    // 已清理：继续走 v2 文件锁创建
                }
                try
                {
                    // FileShare.Read：他人可读 token 判陈旧（与 JS openSync('wx') 的
                    // 共享读语义一致）；写独占
                    FileStream fs = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                    byte[] token = Encoding.UTF8.GetBytes(Process.GetCurrentProcess().Id + "\n" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "\n");
                    fs.Write(token, 0, token.Length);
                    fs.Flush();
                    return fs;
                }
                catch (IOException) { /* EEXIST：他人持有，进入判定 */ }
                catch (UnauthorizedAccessException)
                {
                    // 他用户锁：保守不接管，等待至超时
                    if (Environment.TickCount >= deadline) break;
                    Thread.Sleep(LockPollMs);
                    continue;
                }
                if (IsStaleLock(lockPath))
                {
                    try { File.Delete(lockPath); } catch { /* 竞态：他人已接管 */ }
                    continue;
                }
                if (Environment.TickCount >= deadline) break;
                Thread.Sleep(LockPollMs);
            }
            throw new IOException("等待 cordis.patch.yml 写锁超时（" + LockWaitMs + "ms）：" + lockPath);
        }

        /// <summary>v1 目录锁形态检测（C1：lockPath 是目录即旧锁）。</summary>
        private static bool IsDirectoryLock(string lockPath)
        {
            try { return Directory.Exists(lockPath); } catch { return false; }
        }

        /// <summary>v1 目录锁迁移判定：owner 存活且未过期 → held=true（应等待）；
        /// 否则清理目录（owner 文件 + rmdir）→ held=false。与 JS checkV1DirectoryLock 一致。</summary>
        private static bool CheckV1DirectoryLock(string lockPath, long nowMs)
        {
            string ownerPath = Path.Combine(lockPath, "owner");
            string ownerText = null;
            try { ownerText = ReadTokenText(ownerPath); } catch { ownerText = null; }
            if (!string.IsNullOrEmpty(ownerText))
            {
                try
                {
                    Match mPid = Regex.Match(ownerText, "\"owner\"\\s*:\\s*\"pid-(\\d+)\"");
                    Match mAt = Regex.Match(ownerText, "\"at\"\\s*:\\s*(\\d+)");
                    if (mPid.Success && mAt.Success)
                    {
                        int pid = int.Parse(mPid.Groups[1].Value);
                        long at = long.Parse(mAt.Groups[1].Value);
                        bool alive = IsProcessAlive(pid);
                        bool fresh = nowMs - at <= LockStaleMs;
                        if (alive && fresh) return true; // 持有者存活且未过期
                    }
                }
                catch { /* owner 解析失败：按未持有清理 */ }
            }
            try { File.Delete(ownerPath); Directory.Delete(lockPath); } catch { /* 竞态：他人已接管 */ }
            return false;
        }

        /// <summary>读取锁 token（FileStream + FileShare.ReadWrite——net48 的 ReadAllText
        /// 在文件被持有（Write+ShareRead）时反而失败，显式打开则成功）。</summary>
        public static string ReadTokenText(string lockPath)
        {
            using (FileStream fs = new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                {
                    return sr.ReadToEnd();
                }
            }
        }

        /// <summary>释放补丁锁（校验 token pid == 自己；仅当拥有该锁时才删除锁文件）。
        /// m7（安全审计）：此前把 File.Delete 放在 finally 里，导致"拒绝释放他人锁"
        /// 的 return 分支仍会执行删除——进程 A 的陈旧锁被 B 接管后，A 若再调用本方法
        /// 会误删 B 的有效锁，破坏跨进程互斥。现改为：token pid 不匹配时仅关闭自己
        /// 的 fd，绝不删除锁文件（与 JS releaseLock 的"不匹配即拒绝 unlink"一致）。</summary>
        public static void ReleasePatchLock(FileStream handle, string profileDir)
        {
            string lockPath = PatchLockPath(profileDir);
            bool refuse = false;
            try
            {
                if (File.Exists(lockPath))
                {
                    string token = ReadTokenText(lockPath);
                    string[] parts = token.Split('\n');
                    if (parts.Length >= 2)
                    {
                        int pid;
                        if (int.TryParse(parts[0].Trim(), out pid) && pid != Process.GetCurrentProcess().Id)
                            refuse = true; // token pid 不匹配：拒绝释放他人锁
                    }
                }
            }
            catch { /* 读取失败按可释放处理 */ }
            try { if (handle != null) handle.Close(); } catch { }
            if (!refuse)
            {
                try { File.Delete(lockPath); } catch { }
            }
        }

        /// <summary>pid 探活 + token 过期判定（决策矩阵与 CONTRACT.md §5 一致）。</summary>
        private static bool IsStaleLock(string lockPath)
        {
            try
            {
                string token = ReadTokenText(lockPath);
                string[] parts = token.Split('\n');
                if (parts.Length < 2) return false;
                int pid;
                long at;
                if (!int.TryParse(parts[0].Trim(), out pid) || !long.TryParse(parts[1].Trim(), out at)) return false;
                if (!IsProcessAlive(pid)) return true; // pid 已死：立即接管
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return now - at > LockStaleMs;
            }
            catch { return false; }
        }

        private static bool IsProcessAlive(int pid)
        {
            try
            {
                using (Process p = Process.GetProcessById(pid)) { return true; }
            }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch { return true; } // 无权限（他用户）按存活处理：保守不接管
        }

        // ---------- cordis.patch.yml 分节保留合并（CONTRACT.md §4） ----------

        /// <summary>构造契约 marker 行：`## <owner>:<id>`。</summary>
        public static string PatchMarker(string owner, string id)
        {
            return "## " + owner + ":" + id;
        }

        /// <summary>定位目标块：返回 {found, start, end}（end = 下一个 marker 行或行数）。</summary>
        public static void FindPatchBlock(string[] lines, string owner, string id, out bool found, out int start, out int end)
        {
            found = false;
            start = -1;
            end = lines.Length;
            for (int i = 0; i < lines.Length; i++)
            {
                Match m = PatchMarkerRe.Match(lines[i]);
                if (m.Success && m.Groups[1].Value == owner && m.Groups[2].Value == id)
                {
                    start = i;
                    found = true;
                    break;
                }
            }
            if (!found) return;
            for (int i = start + 1; i < lines.Length; i++)
            {
                if (PatchMarkerRe.IsMatch(lines[i])) { end = i; break; }
            }
        }

        /// <summary>分节保留合并：替换/追加 `## <owner>:<id>` 块；其余块/注释原样保留。
        /// blockYaml 为空串 = 仅移除目标块。</summary>
        public static string MergePatchSection(string text, string owner, string id, string blockYaml)
        {
            if (text == null) text = "";
            text = text.Replace("\r\n", "\n");
            string marker = PatchMarker(owner, id);
            string blockText = string.IsNullOrEmpty(blockYaml) ? "" : marker + "\n" + blockYaml + "\n";
            string[] lines = text.Split('\n');
            bool found;
            int start;
            int end;
            FindPatchBlock(lines, owner, id, out found, out start, out end);
            if (found)
            {
                string head = string.Join("\n", lines, 0, start);
                string tail = string.Join("\n", lines, end, lines.Length - end);
                string headText = head.Length == 0 ? "" : head + "\n";
                return headText + blockText + tail;
            }
            if (string.IsNullOrEmpty(blockText)) return text;
            string baseText = text.Length == 0 ? "" : (text.EndsWith("\n") ? text : text + "\n");
            return baseText + blockText;
        }

        /// <summary>密钥文件 owner-only ACL（M-48）：移除继承 + 仅当前用户完全控制。
        /// 非 Windows / 非 NTFS / 无权限时静默跳过（尽力而为）。</summary>
        public static void ApplyOwnerOnlyAcl(string path)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
                if (Environment.OSVersion.Platform != PlatformID.Win32NT) return;
                FileSecurity sec = File.GetAccessControl(path);
                sec.SetAccessRuleProtection(true, false); // 禁用继承
                sec.AddAccessRule(new FileSystemAccessRule(
                    WindowsIdentity.GetCurrent().Name,
                    FileSystemRights.FullControl,
                    AccessControlType.Allow));
                File.SetAccessControl(path, sec);
            }
            catch { /* 尽力而为：ACL 设置失败不影响主流程 */ }
        }
    }
}
