# 热插拔包格式（hotpack v1）

状态：Draft（dsh-hotplug-hub 1.0.2 配套）。热插拔包是「下载路径 + 调用流程」的声明文件，
本身不含插件代码；插件实体由热插拔中枢按路径解析：已有直接调用（复用），缺失才下载。

## 文件

单个 JSON 文件（建议扩展名 `.hotpack.json`），UTF-8，顶层为对象。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `hotpack` | 是 | 固定 `"1.0"` |
| `id` | 是 | 包唯一 id：`[a-z0-9][a-z0-9._-]*`，建议 `pack.<场景>` |
| `name` | 是 | 展示名 |
| `version` | 是 | 包版本（展示与覆盖判断用） |
| `description` | 否 | 一句话说明 |
| `tags` | 否 | 字符串数组 |
| `plugins` | 是 | 插件引用数组（顺序即 patch insert 顺序） |

### plugins[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 包内唯一短 id，用于生成 patch 实例 id |
| `name` | 是 | 合法 npm 包名（也是 profile node_modules 路径） |
| `version` | npm 必填 | 精确版本（不接受 range/tag） |
| `source.type` | 是 | `npm` / `github` / `path` |
| `source.repo` | github 必填 | `owner/repo` |
| `source.ref` | 否 | tag 或分支名（默认 `main`），字符集 `[0-9A-Za-z._-/]`（`/` 用于 `feature/x` 类分支；`..`/空白/元字符拒绝） |
| `source.path` | path 必填 | 本地插件目录；必须是绝对路径（`~`、`$DSH_HOME` 前缀不做展开，请写完整绝对路径） |
| `config` | 否 | 传给 cordis insert 的 config 对象 |

## 解析与调用流程（中枢行为）

1. `npm`：profile node_modules 里已有相同版本【且内部包名一致】→ 直接调用；否则 `pnpm add <name>@<version>`（只下缺失的，pnpm store 全局共享）。
2. `path`：目录存在且内部 package.json 的包名与清单声明一致 → 直接 link 调用；不存在/不一致 → 导入失败并提示路径。
3. `github`：`$DSH_HOME/hotplug-store/<name>@<ref>` 已有（内部包名一致）→ 直接调用；否则从 codeload（含国内镜像）下载 zip 解压入库，再 link 调用。
4. 挂载：link 源写 profile `dependencies[name] = link:<路径>` + node_modules junction；插件包自身 package.json 声明 `dsh.bundle.patch: true`（显式 true，false/缺省不登记）的登记进 `dsh.profile.bundles`；所有插件写入 cordis.patch.yml 的契约标记块 `## hotplug:<packId>`（分节保留合并，四写者锁保护；旧内联 `- insert:  # hotplug:<packId>` 形态仅读兼容移除）。
5. 无损替换：任一时刻只有一个激活包。切换时先移除旧包标记块、bundles 与 link 依赖（只 `pnpm remove` 旧包【本次挂载实际安装】的 npm 包，挂载前已复用的预存依赖保留），再挂新包；新包挂载失败时按序尝试恢复旧包或清空激活状态（state 与磁盘保持一致）；全局记忆、会话、hotplug-store 一律不动。

## 安全边界

- 中枢不执行热插拔包或插件里的任何脚本/命令字段；包文件只是数据。
- 磁盘上的 `packs/<id>/hotpack.json` 在每个消费点（status/preview/activate/deactivate）都经权威 `parseHotpack` 复验——篡改的 plugin name/version/repo 在进入 pnpm 命令与 profile 产物之前即被拒绝。
- `state.json` 损坏（半截写/坏 JSON）时中枢拒绝一切变更操作（导入/激活/停用/删除），status 显式 `stateOk:false`，绝不把损坏状态当全新状态静默覆盖。
- npm 源只接受精确版本；github/path 源只下载与 link，不跑安装脚本。
- 下载/解压工具可用 `DSH_CURL_BIN` / `DSH_TAR_BIN` 环境变量指名（嵌入式宿主与进程隔离测试用；缺省用系统 curl/tar）。
- 插件激活后以用户权限作为本地代码运行，导入前请自行确认来源可信（与 dsh-community-market 同一信任模型）。
