# DSH-Hotplug-Hub 开发文档（独立启动器版）

版本：0.2.0-draft（launcher 架构）
适用：独立于 DSH 的插件拼装启动器
更新日期：2026-08-19

> 本文档已按 `dsh-launcher-spec.md` 的修改意见重写定位：从「DSH 内部插件说明书」改为「独立拼装启动器说明书」。
> 目标架构：在 DSH 进程之外读取插件组合 → 拼装临时 profile → 冲突预检 → 拉起 DSH → 捕获日志 → 自愈闭环。

## 1. 项目概述

dsh-hotplug-hub 是一个**独立于 DSH 的插件拼装启动器**。

- 它在 DSH 进程之外读取插件组合（hotpack v1 / assembly）。
- 在 sandbox 工作区拼装临时 profile。
- 做冲突预检与错误自愈。
- 再拉起官方 DSH（DSH Desktop / CLI）运行。

它不是跑在 DSH 里面的插件，也不再以 `dsh plugin add link:` 方式装进 DSH。

技术栈：

- Node.js ≥ 22（ESM）
- pnpm（npm 源插件安装 / 卸载）
- 跨平台：Windows / macOS / Linux
- 桌面 GUI：WebView2（Windows EXE）或浏览器打开 `dsh-pack-hub/prototype.html`
- 官方 DSH：作为被启动的外部进程，启动器读取/生成 `~/.dsh/profiles/<id>` 并用 `DSH_PROFILE` 拉起

## 2. 目录结构

```text
dsh-hotplug-hub/
  assembly/                  # 组合描述：用户意图 / resolvedAssembly（AI 修坑后索引）
    <id>/assembly.json
    <id>/resolvedAssembly.json
  sandbox/                   # 临时 profile 工作区（编辑/自愈期）
    .sandbox/<id>/
  launcher/                  # 启动器入口（node launcher / EXE）
  lib/
    index.js                 # 底层原语：mount / unmount / ensureEntry / 自检（供启动器内部调用）
    client.js                # 启动器 GUI（不再是 DSH settings.section）
    typert.js                # 仅历史兼容，新架构弃用（保留文件避免旧 RPC 404）
  docs/
    hotpack-format.zh.md     # hotpack v1 格式规范
  examples/                  # 示例 hotpack / assembly
  dsh-pack-hub/
    prototype.html           # 启动器 GUI 壳，对应五大模块页签
    README.md
  release/
    DSH-Hotplug-Hub.exe      # Windows 桌面启动器 EXE（WebView2）
    src/Main.cs              # EXE 源码
    build-exe.ps1            # EXE 编译脚本
    make-docs.ps1            # 说明文档生成脚本
    document-content.md      # 说明文档内容源
  开发文档/
    dev-doc-content.md       # 本开发文档内容源
    make-dev-docs.ps1        # 生成开发文档 TXT / DOCX
```

## 3. 架构设计：五大模块

启动器按 SPEC 拆成五大模块：

| 模块 | 职责 |
|---|---|
| Market（插件包市场） | 浏览 / 搜索 / 导入 hotpack 或 assembly |
| Assembler（组装器） | 读 assembly → 解析依赖 → 生成 sandbox profile |
| Check（检测器） | 静态冲突矩阵 + 预检闸门 + 自愈复检闸门 |
| Launcher（启动器） | 同步 sandbox 到 `~/.dsh/profiles/<id>` → 以 `DSH_PROFILE` 拉起 DSH → 捕获日志 |
| Standard + Adapter（标准与兼容层） | hotpack v1 标准化 + 与 DSH 真实字段的兼容映射 |

### 3.1 与旧「DSH 插件」架构的关系

旧架构是 host / client / typert 三层：

- `lib/typert.js`：7 个 invocation 定义。**新架构下不再需要 RPC 调用**，保留仅为历史兼容；启动器直接调用 `lib/index.js` 原语并拉起 DSH 子进程。
- `lib/client.js`：不再注册 DSH `settings.section`，改为启动器自己的窗口/页面。
- `lib/index.js`：mount / unmount / ensureEntry / checkAsync 保留为启动器内部库。

### 3.2 核心数据流

```text
读 assembly / hotpack
        ↓
Assembler：生成 sandbox/<id>/ profile（依赖解析 + 版本 pin）
        ↓
Check：静态冲突矩阵 + 预检（失败则回 sandbox 编辑）
        ↓
Launcher：sandbox 同步为 ~/.dsh/profiles/<id>
        ↓
以 DSH_PROFILE=<id> 拉起 DSH
        ↓
捕获日志（DSH 内部日志 + stdout/stderr tee）
        ↓
自愈循环：错误分类 → AI 建议 → 受限动作 → 重启复检
```

### 3.3 旧 7 个 RPC 方法 → 启动器内部函数

| 旧 RPC 方法 | 新架构定位 |
|---|---|
| status | 启动器内部状态查询 |
| importPack | 导入 hotpack / assembly 到本地工作区 |
| preview | 预演激活计划（reused / download / error） |
| activate | 组装并挂载到 sandbox profile |
| deactivate | 卸载 sandbox profile |
| removePack | 移除组合记录 |
| check | 预检 / 自愈复检闸门 |

## 4. 核心模块

### 4.1 保留的底层原语（lib/index.js）

- 路径与状态：`homeDir()` / `hotplugRoot()` / `packsDir()` / `storeRoot()` / `statePath()` / `profileName()` / `profileDir()` / `manifestPath()` / `patchPath()`
- 原子写：`writeTextSafe()` / `writeJsonSafe()`
- hotpack 校验：`parseHotpack()`（白名单正则：`PACK_ID_RE` / `PLUGIN_NAME_RE` / `EXACT_VERSION_RE` / `REF_RE` / `REPO_RE`）
- 插件确保：`ensureNpm()` / `ensurePath()` / `ensureGithub()`
- 挂载 / 卸载：`mountPack()` / `unmountPack()` / `buildPatchBlock()` / `appendPatchBlock()` / `removePatchBlock()` / `linkEntryIntoProfile()` / `addBundles()` / `removeBundles()`
- 串行化：`HotplugGateway.serialize()`（改为本地任务队列）

### 4.2 新增启动器函数

| 函数 | 职责 |
|---|---|
| `assemble(assemblyJson)` | 读 assembly → 在 `sandbox/<id>/` 生成 profile（对应 SPEC §5.2） |
| `checkConflicts(manifests)` | 静态依赖图 + 冲突矩阵（对应 SPEC §5.3 静态层） |
| `launchAndCapture(id)` | 以 `DSH_PROFILE=<id>` 拉起 DSH，tee 日志到 `sandbox/<id>/logs/run.jsonl` |
| `selfHeal(id)` | 错误分类 → 调 AI → 受限动作集 → 重启复检 |

### 4.3 自检 checkAsync

保留 `checkAsync()`，并明确它是双重闸门：

- **预检闸门**：启动 DSH 前检查 Node/pnpm、profile 清单、patch 状态、冲突矩阵。
- **自愈复检闸门**：自愈动作执行后再次检查，确认可启动。

## 5. 数据布局

### 5.1 保留的 DSH 侧缓存

```text
~/.dsh/hotplug-hub/
  state.json
  packs/<pack-id>/hotpack.json
~/.dsh/hotplug-store/         # github 源插件缓存（跨包复用）
  <name>@<ref>/
```

### 5.2 新增启动器工作区

```text
launcher工作区/
  assembly/<id>/
    assembly.json             # 用户意图（原始组合）
    resolvedAssembly.json     # AI 修过的坑 + 版本 pin
  .sandbox/<id>/              # 临时 profile（编辑/自愈期）
    package.json
    cordis.patch.yml
    logs/run.jsonl            # 结构化错误日志
```

### 5.3 真实 profile 边界

- `~/.dsh/profiles/<id>` 是**真正被 DSH 启动的 profile**。
- 启动时由 sandbox 同步而来。
- **用户原有的 `desktop` profile 不被改动**。

## 6. 格式：hotpack v1 复用 + manifest 索引

- 优先复用 **hotpack v1** 作为组合载体，避免另起一套 `assembly.json` 造成格式分裂。
- 启动器侧叠加 `resolvedAssembly.json` 索引，存放：
  - 依赖图（apiLevel / provides / requires / conflicts）
  - 版本 pin
  - AI 修正记录
- 这些索引字段**只存于 resolvedAssembly / 内部 manifest，不写回插件 package.json**。
- 若未来采用 `assembly.json + manifest.json`，必须与 hotpack 建立明确映射，并复用 `parseHotpack()` 白名单校验。

## 7. 跨平台处理

### 7.1 Windows

- `IS_WIN = process.platform === 'win32'`
- `CURL_BIN = 'curl.exe'`，`TAR_BIN = 'tar.exe'`
- curl 增加 `--ssl-no-revoke`
- `runCli` 使用 `shell: IS_WIN`、`windowsHide: true`
- link 使用 junction

### 7.2 macOS / Linux

- `tar` 优先，Linux 下 tar 失败回退 `unzip`
- GitHub 官方 codeload + 国内镜像兜底
- 安装不再依赖 `install.sh` 把插件装进 DSH

### 7.3 Windows EXE（启动器 GUI）

- `release/DSH-Hotplug-Hub.exe`：C# WinForms + WebView2 桌面启动器
- 内嵌 `dsh-pack-hub/prototype.html`，作为启动器自身 GUI
- 左侧栏包含：DSH API 配置 / 启动 DSH 官方启动器 / 选择桌面端
- 系统自检展示真实环境检测；DSH 内部状态在启动器架构下由 `checkAsync()` 预检提供

### 7.4 拉起 DSH

- Windows：以 `DSH_PROFILE=<id>` 启动 `DSH Desktop.exe`
- macOS / Linux：启动对应桌面启动器或 CLI
- 日志捕获：
  - 读取 DSH 内部日志文件
  - 子进程 stdout/stderr tee 到 `sandbox/<id>/logs/run.jsonl`
  - 不依赖 GUI 进程吐结构化 stdout

## 8. 开发环境搭建

独立运行，不再装进 DSH：

```bash
# 启动器入口（未来）
node launcher/index.js

# 或直接运行 EXE
release/DSH-Hotplug-Hub.exe
```

- 仅在真正启动 DSH 时生成/同步 profile 并拉起 DSH。
- 开发热更新：修改 `lib/` 后重启**启动器**，不是重启 DSH。
- 浏览器调试：直接打开 `dsh-pack-hub/prototype.html`。

## 9. 扩展开发指南

### 9.1 新增启动器内部函数

不再三处同步 typert / client / methods。新函数只需：

1. 在 `lib/index.js` 或 `launcher/` 实现。
2. 在 GUI（`lib/client.js` / `prototype.html`）暴露入口。
3. 在文档 `核心模块` 表登记。

### 9.2 子页签对应五大模块

| 页签 | 模块 |
|---|---|
| 插件包市场 | Market |
| AI 组装 | Assembler |
| 插件中枢 | Assembler + Check |
| 自检更新 | Check + Launcher |
| 记忆中枢 | 全局记忆（保留） |

### 9.3 新增 hotpack / assembly 源类型

- 扩展 `parseHotpack()` 的白名单校验
- 新增 `ensureXxx(entry)` 并接入 `ensureEntry`
- `resolvedAssembly.json` 同步索引

### 9.4 EXE 逻辑

- 编辑 `release/src/Main.cs`
- 运行 `pwsh -File release/build-exe.ps1` 重新编译
- 启动按钮逻辑：`LaunchOfficialHarness()` 自动检测 / 手动选择 DSH 桌面端
- API 配置直接读取官方 DSH 配置：`LoadApiConfig()` 解析 `~/.dsh/settings.yaml` + `.credentials.yaml`

## 10. 文档与构建脚本

| 脚本 | 作用 |
|---|---|
| release/build-exe.ps1 | 编译启动器 EXE，内嵌 prototype.html |
| release/make-docs.ps1 | 由 release/document-content.md 生成说明 TXT / DOCX |
| 开发文档/make-dev-docs.ps1 | 由 dev-doc-content.md 生成本开发文档 TXT / DOCX |

修改文档时只改 `dev-doc-content.md`，然后运行：

```powershell
pwsh -File 开发文档/make-dev-docs.ps1
```

## 10.1 启动器 CLI（已实现）

```bash
node launcher/index.js assemble <id>       # 组装 sandbox profile
node launcher/index.js check <id>          # 冲突预检
node launcher/index.js launch <id>         # 同步 ~/.dsh/profiles/<id> 并拉起 DSH
node launcher/index.js heal <id> [--yes]   # 自愈（默认预览，--yes 写入建议）
node launcher/index.js status <id>         # 查看状态
```

- `assembly/<id>/assembly.json`：组合输入（hotpack v1 或 dshpack 结构）
- 组装后生成 `sandbox/.sandbox/<id>/package.json` + `cordis.patch.yml`
- 启动时同步到 `~/.dsh/profiles/<id>` 并以 `DSH_PROFILE=<id>` 拉起官方 DSH
- 日志写入 `sandbox/.sandbox/<id>/logs/run.jsonl`
## 10.2 安装程序（已实现）

- `installer/Setup.exe`：Windows 安装程序（C# WinForms）。
- 默认安装目录：`C:\DSH-Hotplug-Hub`，可手动更改。
- 安装内容：
  - `release` 运行文件（EXE + WebView2 DLL + 说明文档）
  - `launcher`（独立启动器）
  - `assembly`（组合示例）
  - `sandbox`（临时 profile 工作区）
  - `开发文档`
- 自动创建桌面快捷方式和开始菜单快捷方式。
- 编译：`pwsh -File installer/build-installer.ps1`。
## 11. 测试与验证（启动器全流程）

1. 浏览器或 EXE 打开启动器 GUI，检查五大模块页签。
2. 勾选 / AI 组包 → 生成 `assembly.json`。
3. 点「预检」看冲突报告。
4. 点「启动」→ 启动器生成 sandbox profile 并拉起 DSH。
5. 故意塞一个坏插件 → 验证自愈循环（降级 / 禁用 / 重分类）与 `run.jsonl` 落盘。
6. 检查 `~/.dsh/profiles/<id>` 的 package.json / cordis.patch.yml 增删正确，**原 desktop profile 未被改**。

## 12. 安全红线

保留：

- 不执行 hotpack / 下载内容里的任何脚本；npm 走 pnpm，github/path 只 link。
- 白名单正则 + argv 传参。
- profile 文件原子写，失败回滚。
- 用户确认安装。

新增 AI 自愈场景边界：

- 「禁用插件 / 降级版本」等改变交付物的动作需用户确认。
- 自愈只改 sandbox，不碰用户现有 profile。
- 来源哈希 pin（对应 SPEC §13 Q3）。

## 13. 已知限制 / TODO

当前实现处于「DSH 插件形态（P0 之前）」，需向启动器路线图演进：

- P0：Assembler + 静态检测
- P1：日志捕获 + 自愈
- P2：市场 + AI 组包
- P3：兼容层 + 热插拔

开放问题（TODO）：

- 市场托管位置
- AI 本地 / 云端
- 插件签名
- 自检复用
- 运行时 load 接口

## 附录：实现 SPEC 时必须顺手修正的硬伤

开发文档在采用 SPEC 设计时，不要照抄以下错误：

1. 字段名 `bundlePatch` → 应为 `dsh.bundle.patch`。真实 DSH 只认 `dsh.bundle.patch`。
2. `apiLevel` / `provides` / `requires` / `conflicts` 不写回插件 `package.json`，只存 resolvedAssembly / 内部 manifest。
3. 优先复用 hotpack v1 作为组合载体；若另起格式需建立映射并复用 `parseHotpack()` 白名单校验。
4. 补「bundle ↔ cordis 重分类」为最高优先级自愈动作：把只有 `dsh.client` 的插件误塞进 `dsh.profile.bundles` 会让 DSH 启动崩溃。
5. 补「获取失败」错误分类（ACQUIRE_FAIL / LINK_FAIL / NETWORK_FAIL）与「换镜像源重试」动作。
6. 明确沙箱如何被 DSH 加载：sandbox 仅在编辑/自愈期存在；启动时同步为 `~/.dsh/profiles/<id>` 并以 `DSH_PROFILE` 拉起。
