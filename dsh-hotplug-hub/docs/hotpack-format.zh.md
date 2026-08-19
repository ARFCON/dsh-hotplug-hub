# 热插拔包格式（hotpack v1）

状态：Draft（dsh-hotplug-hub 0.1.0 配套）。热插拔包是「下载路径 + 调用流程」的声明文件，
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
| `source.ref` | 否 | tag 或分支名（默认 `main`），限 `[0-9A-Za-z._-]` |
| `source.path` | path 必填 | 本地插件目录；支持绝对路径、`~`、`$DSH_HOME` 前缀 |
| `config` | 否 | 传给 cordis insert 的 config 对象 |

## 解析与调用流程（中枢行为）

1. `npm`：profile node_modules 里已有相同版本 → 直接调用；否则 `pnpm add <name>@<version>`（只下缺失的，pnpm store 全局共享）。
2. `path`：目录存在 → 直接 link 调用；不存在 → 导入失败并提示路径。
3. `github`：`$DSH_HOME/hotplug-store/<name>@<ref>` 已有 → 直接调用；否则从 codeload（含国内镜像）下载 zip 解压入库，再 link 调用。
4. 挂载：link 源写 profile `dependencies[name] = link:<路径>` + node_modules junction；带 `dsh.bundle.patch` 的包登记进 `dsh.profile.bundles`；所有插件写入 cordis.patch.yml 的同一个标记块 `- insert:  # hotplug:<packId>`。
5. 无损替换：任一时刻只有一个激活包。切换时先移除旧包标记块、bundles 与 link 依赖（npm 包执行 `pnpm remove`），再挂新包；全局记忆、会话、hotplug-store 一律不动。

## 安全边界

- 中枢不执行热插拔包或插件里的任何脚本/命令字段；包文件只是数据。
- npm 源只接受精确版本；github/path 源只下载与 link，不跑安装脚本。
- 插件激活后以用户权限作为本地代码运行，导入前请自行确认来源可信（与 dsh-community-market 同一信任模型）。
