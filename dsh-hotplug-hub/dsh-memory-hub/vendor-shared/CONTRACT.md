# DSH-Hotplug-Hub 共享内核契约（CONTRACT.md）

> 本文档是 **跨语言必须一致** 的常量与规则的唯一真源（v5 重构计划 §4.2）。
> 适用语言/运行时：JavaScript（CJS/ESM，`packages/shared-core`）、C#（.NET Framework，
> `release/src/PatchContract.cs` 等价实现）、静态 HTML（`dsh-pack-hub/prototype.html` 内联副本）、
> PowerShell（`scripts/`）。
>
> 规则：**任何跨语言改动必须先改本文档与 `packages/shared-core` 实现，再同步各语言副本，
> 并由 CI 的跨语言断言测试锁定（非 allow-failure）。**

---

## 1. 标识符与正则

| 常量 | 值 | 语义 |
|---|---|---|
| `PACK_ID_RE` | `^[a-z0-9][a-z0-9._-]{0,63}$`（大小写不敏感） | 包 id / CLI id：字母数字开头，允许 `. _ -`，1..64 字符 |
| `PLUGIN_NAME_RE` | `^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$` | npm 包名（可 scoped） |
| `EXACT_VERSION_RE` | `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$` | 精确版本号（**须再经 semver 双检**：`semver.valid(v) !== null`，拒绝 `1.02.3` 等） |
| `REPO_RE` | `^[0-9A-Za-z][0-9A-Za-z._-]*\/[0-9A-Za-z][0-9A-Za-z._-]*$` | GitHub 仓库 `owner/repo`（两段、字母数字开头；拒绝前导 `. -` 与 `..` 段，防 URL/git clone 路径穿越） |
| `RESERVED_WIN_NAMES` | `CON PRN AUX NUL COM1..COM9 LPT1..LPT9` | Windows 保留设备名（任何单段名均拒绝，含首段匹配） |
| 长度预算 | id ≤ 64；patch id ≤ 64；source.path ≤ 4096；source.repo ≤ 512；source.ref ≤ 256 | |

校验规则（与 `ids.js` 一致）：
- 控制字符（`[\u0000-\u001f\u007f\u0080-\u009f]`）一律拒绝；
- 尾随 `.` 或空格拒绝；
- 插件名每个 `/` 段均过 Windows 安全名检查；
- `source.path` 必须绝对、拒绝 UNC、拒绝 `.`/`..` 段；
- `source.repo` 必须匹配 `REPO_RE`（`owner/repo` 两段、字母数字开头；拒绝空白/元字符/`..` 段）；
- `source.ref` 拒绝 `..`、纯点、控制字符、超长（阶段 2 起允许合法 `/`）。

## 2. 错误码与结果契约

- CLI 域错误码 `ERR_*`（32 码）与退出码映射（`ERR_ARG_`=2 … `ERR_ENV_`=12）见
  `contracts/errors.js`；`makeError(code, message, extra)` 构造统一错误，
  `isDshError(err)` 判定；**exitCode 只由 code 前缀推导，调用方 extra 中的 exitCode 一律忽略**。
- 命令结果 `CommandResult{ok, code, message, data, exitCode}`；hotplug 网关 RPC 序列化为
  `{ok, code, message, exitCode}`（`error` 字符串字段已废弃，client 渲染适配）。
- memory 域保留类型化 `MemoryHubError`（语义码），跨域边界仅映射 `{code, message}`。

## 3. 根目录解析（resolveDshRoot）

优先级：`DSH_HOTPLUG_ROOT` > `DSH_HOME` > `~/.dsh`。

| 环境 | dshRoot（.dsh 域目录） | home |
|---|---|---|
| `DSH_HOTPLUG_ROOT` 非空 | `<root>/.dsh`（整个根域落其下） | `<root>` |
| `DSH_HOME` 非空 | `<DSH_HOME>`（本身即 .dsh 域目录） | dirname |
| 缺省 | `<homedir>/.dsh` | `<homedir>` |

子目录（一律由 dshRoot 派生，禁止另行拼接 home）：

| 常量 | 值 |
|---|---|
| `PROFILES_DIR` | `profiles` |
| `STORE_DIR` | `hotplug-store` |
| `MEMORY_DIR` | `memory-hub` |
| `HOTPLUG_DIR` | `hotplug-hub` |

## 4. cordis.patch.yml 分节合并契约

- **marker 行**：`## <owner>:<id>`（读兼容单 `#`：`# <owner>:<id>` 同样识别）；
  owner/id 字符集 `[A-Za-z0-9._-]`。
- **块**：marker 行起，至下一个 marker 行（或 EOF）止；内容为**单个 YAML 顶层数组项**
  （缩进 0，内层 4/2 空格）。示例：

  ```yaml
  ## hotplug:pack.research
  - insert:
      - id: hp-pack-research-literature
        name: '@dsh-community/dsh-tool-literature'
        config: {}
  ```

- **合并语义**（`mergePatchFile`，C# 侧等价实现）：按 marker 切分 → 替换目标块 →
  其余块/注释/空行**原样保留**；目标块不存在则追加；**永不整文件覆盖**。
- **迁移规则**：旧无 marker 文件视为 `desktop` owner 整体保留；旧 `# hotplug:<id>` 块
  （单 `#`）读取时识别、下次写时清理为 `## hotplug:<id>`；旧 C# `# 插件管理…` 块
  读取时识别、下次写时清理为 `## desktop:<id>`；删除用 **marker 匹配**而非 id 内容匹配。
- 写盘走原子写（随机 tmp + `wx` + fsync + rename）。

## 5. 锁协议（四写者：launcher / hotplug / dseam / C#）

- **锁文件名**：`<profile>/.dsh-patch.lock`（cordis.patch.yml 所在 profile 目录）。
- **获取**：`FileMode.CreateNew`（= `openSync('wx')`）独占创建，权限 0600；EEXIST = 他人持有。
- **token 格式**：两行文本 `pid\nunix_ms\n`（十进制 pid + unix 毫秒时间戳）。
- **探活**：`process.kill(pid, 0)`（C#：`Process.GetProcessById(pid)` 捕获异常）——
  ESRCH/无效进程 = 已死（可立即接管）；EPERM/拒绝访问 = 存活但无权限（**保守不接管**）。
- **过期**：token 年龄 > 30s 视为陈旧可接管；持锁方每 10s 经已打开 fd 重写 token 时间戳
  （防长任务误判陈旧）。
- **他用户锁**：EACCES/EPERM（锁文件属于他人）→ 等待至超时（10s），**绝不接管**。
- **释放**：校验 token pid == 自己 → 关闭 fd → unlink。
- **v1 目录锁迁移**：检测到 `<lockPath>` 为目录形态 → 读 `owner` 文件（JSON
  `{owner:"pid-<pid>", at}`）：pid 存活且未过期 → 等待；否则清理目录重建为文件锁。
- 锁等待上限 10s、轮询 100ms。

## 6. TLS 与网络

- 所有出站 HTTPS **默认校验证书**（`rejectUnauthorized: true` 恒成立，合并末位，
  不可经调用方选项/环境变量绕过）；内网自签环境通过显式 `ca` 钉 CA。
- 子进程 env 净化清单（spawn 前删除）：`NODE_TLS_REJECT_UNAUTHORIZED`、
  `NODE_OPTIONS`、`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR`。
- 下载完整性：node/pnpm/tgz/raw 统一 SHA256 校验。
- zip 解包安全：成员路径拒绝绝对/盘符/UNC/`..`/反斜杠；解包后整树 realpath 校验
  在目标根内，拒绝符号链接成员逃逸（zip slip + 符号链接，M-39）。

## 7. 命令安全（CMD_SPECIAL_RE）

- **原则**：不构造 shell 字符串；一律 `spawn(command, argsArray, {shell:false})`。
- `CMD_SPECIAL_RE = /[\u0000-\u001f\u007f&|;`$()<>"'\\]/`（C# 等价正则）。
- 自由形态值（git ref/tag/profile/tarballUrl）进 argv 前过
  `assertShellSafe`（严格 `^[0-9A-Za-z][0-9A-Za-z._-]*$`，可放宽如 repo 的 `/`）
  或 `assertShellSafeUrl`（http(s) URL、无空白/元字符）。

## 8. 镜像主集

`GITHUB_MIRRORS` 契约主集 = 3 个（顺序即优先级）：
`https://ghfast.top/`、`https://gh-proxy.com/`、`https://ghproxy.net/`。
prototype.html / hotplug 市场的 +3（`mirror.ghproxy.com`、`ghproxy.cc`、`gh-proxy.net`）
为**原型/实验源**，不进契约；UI 标注来源域名。

## 9. 测试隔离（P5）

任何进程级测试/脚本必须显式隔离：`DSH_HOTPLUG_ROOT`/`HOME`/`USERPROFILE`/
`LOCALAPPDATA`/`ProgramFiles`/`ProgramFiles(x86)`/`DSH_HOME`/`PATH` 全部指向临时目录，
删除 `NODE_OPTIONS`；生产侧 spawn 显式透传净化 env；**真实 `~/.dsh` 零写入**
（统一 afterEach 断言 mtime/条目数不变）。

## 10. 同步纪律

- `packages/shared-core` 是唯一编辑点；`dsh-hotplug-hub/vendor-shared/` 与
  `dsh-hotplug-hub/dsh-memory-hub/vendor-shared/` 由 `scripts/sync-vendored-shared.mjs`
  字节复制生成并随 git 提交；CI 逐文件 sha256 断言零漂移。
- ESM 垫片 `index.mjs` 再导出集合 == CJS `index.js` 全导出（单测断言）。
