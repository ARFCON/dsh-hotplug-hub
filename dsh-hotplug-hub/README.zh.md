> ⚠️ AI 必读：`AI_AGENTS.md` 工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。

# dsh-hotplug-hub — DSH 热插拔中枢

DeepSeek Harness（dsh）是插座，这个插件是插在插座上的**空排插**：本体不含任何原生插件，只负责导入外部**热插拔包（hotpack）**。不同场景切不同的包：科研包、视频包、考研包……切换是无损替换，全局记忆与会话不受影响。

基于 [dsh-hub](https://github.com/ARFCON/dsh-hub-DSH) 插件中枢的同一套机制：typert Remote 网关 + 设置页 + profile 原子写 + link 装配。可以和 dsh-hub 并存（设置页独立、数据目录独立）。

## 三条设计原则

| 原则 | 实现 |
|---|---|
| 空插座 | 中枢不注册任何工具 / 预设 / 插件；`apply()` 只起一个 Remote 网关 |
| 路径调用 | 包内插件按路径挂载：profile `node_modules` 或 `hotplug-store` 里已有同版本 → 直接调用（复用）；缺失才下载（缺失哪下哪） |
| 无损替换 | 同一时刻只有一个激活包；换包只替换 profile 的 patch 块 / bundles / link 依赖；`~/.dsh/memory`、会话、store 缓存全部保留 |

## 5 个子页签

安装后在 DSH 设置页出现「热插拔中枢」独立设置页（`settings.section` slot），内含 5 个子页签：

| 页签 | 功能 |
|---|---|
| 插件中枢 | 导入 hotpack JSON（粘贴或选文件）、包列表、预览（复用/待下载）、激活/停用/移除、store 缓存展示 |
| 插件包市场 | **真实 GitHub 市场**：按标签（topic）搜索项目（官方 API + 多镜像全并发测速取最快），对比文件（README.zh.md/README.md、package.json、hotpack.json/.dshpack.json）提取介绍与安装方法，生成可导入 manifest；支持搜索/标签筛选/来源切换/分页/本地缓存 |
| AI 组装 | 输入需求描述 → 关键词匹配场景 → 5 步日志动画 → 生成 hotpack manifest + README → 复制 JSON 或一键导入 |
| 记忆中枢 | 展示 `~/.dsh/memory` 全局记忆目录路径与 store 缓存条目 |
| 自检更新 | 调用 `check()` 远程方法，展示 Node/pnpm 版本、profile 状态、patch 状态、插件冲突矩阵、包数/store 数 |

## 安装

依赖：Node.js ≥ 22、pnpm、dsh CLI（`@deepseek-ai/dsh-typert-protocol` 用 DSH 自带的，无第三方依赖）。

```bash
./install.sh            # 自动探测 desktop / web / headless profile
./install.sh web        # 或指定 profile
```

手动安装等价于：

```bash
mkdir -p ~/.dsh/plugin-src
cp -R dsh-hotplug-hub ~/.dsh/plugin-src/
dsh plugin --profile desktop add "link:$HOME/.dsh/plugin-src/dsh-hotplug-hub"
```

安装完重启 DSH，打开 **设置 → 热插拔中枢**。

## 使用

1. **导入包**：把 hotpack JSON 粘进插件中枢页签（或选 `.hotpack.json` 文件）。示例在 `examples/`。
2. **预览**：列出包内每个插件是 `复用`（绿）还是 `待下载`（黄），不动任何文件。
3. **激活**：缺的插件按需下载（npm 精确版本 / GitHub zip + 国内镜像 / 本地路径），挂进当前 profile；如果已有别的激活包，先无损卸载再挂载。
4. **停用 / 移除**：停用卸载当前包（保留 store 缓存，下次激活秒复用）；移除只删包记录。
5. 挂载变更在 **重启 DSH 后生效**（dsh profile 机制决定）。

也可以从**插件包市场**页签选示例包一键导入，或在 **AI 组装**页签用自然语言描述需求自动生成 manifest。

## Remote 服务 `dshHotplug`（7 个方法）

| 方法 | 参数 | 功能 |
|---|---|---|
| `status` | — | 中枢状态：profile / 激活包 / 已导入包 / store 缓存 |
| `importPack` | `text` | 导入 hotpack JSON（字符串或对象），只落盘不挂载 |
| `preview` | `packId` | 预演激活计划：每个插件 reused / download / error |
| `activate` | `packId` | 解析缺失插件并挂载（无损替换当前激活包） |
| `deactivate` | — | 卸载当前激活包（保留 store 缓存） |
| `removePack` | `packId` | 移除未激活的包记录 |
| `check` | — | 自检：Node/pnpm 版本、profile 状态、patch 状态、插件冲突矩阵、包数/store 数 |
| `marketList` | `params` | 插件包市场：按标签搜索 GitHub 项目（`topic` 默认 `dsh-plugin`，`source` 可选 `auto/github/mirror`，`page` 分页，`refresh` 强制重抓），返回条目含 star/作者/许可/介绍（README 首段）/安装方法（README 安装节）/生成好的 hotpack manifest |

## 热插拔包格式（hotpack v1）

```json
{
  "hotpack": "1.0",
  "id": "pack.research",
  "name": "科研热插拔包",
  "version": "1.0.0",
  "description": "文献检索 + 思维导图 + 笔记同步",
  "tags": ["科研", "文献"],
  "plugins": [
    { "id": "literature", "name": "@dsh-community/dsh-tool-literature", "version": "1.2.3", "source": { "type": "npm" } },
    { "id": "mine", "name": "my-plugin", "source": { "type": "path", "path": "~/dev/my-plugin" } },
    { "id": "team", "name": "team-tool", "source": { "type": "github", "repo": "owner/team-tool", "ref": "v1.0.0" } }
  ]
}
```

三种源：

- `npm`：必须精确版本（禁止 range）。缺失时 `pnpm add --save-exact` 装进 profile（走 pnpm 全局 store，装过的版本离线秒复用）。
- `path`：本地目录直接 link 挂载（同 graph-memory 模式），不下载。支持 `~` 和 `$DSH_HOME` 前缀展开。
- `github`：下载 zip 到 `~/.dsh/hotplug-store/<name>@<ref>` 再 link；官方 codeload 优先，ghfast.top / gh-proxy / ghproxy 镜像兜底。**包内 package.json 的 name 必须与清单一致**。

完整字段表见 [docs/hotpack-format.zh.md](docs/hotpack-format.zh.md)。

## 数据布局

```
~/.dsh/hotplug-hub/
  state.json                  # 激活包 + 操作历史
  packs/<pack-id>/hotpack.json
~/.dsh/hotplug-store/         # github 源插件缓存（跨包复用）
  <name>@<ref>/
~/.dsh/profiles/<name>/
  package.json                # 中枢写入 link 依赖 + bundles 列表
  cordis.patch.yml            # 中枢写入 # hotplug:<packId> 块
```

## 项目结构

```
dsh-hotplug-hub/
  package.json          # 插件配置（ESM, peerDeps cordis + typert-protocol）
  lib/
    index.js            # host 插件：HotplugGateway + 7 个 Remote 方法 + hotpack 解析 + 挂载/卸载
    client.js           # client UI：5 子页签设置页（settings.section slot）
    typert.js           # TYPERT manifest：7 个 invocation 定义
  docs/
    hotpack-format.zh.md  # hotpack v1 格式规范
  examples/
    research.hotpack.json
    video.hotpack.json
  install.sh            # 自动安装脚本
```

## 边界与红线

- profile 的 `package.json` / `cordis.patch.yml` 一律原子写（.tmp + .bak + rename），挂载失败自动回滚 patch 块与 bundles，不留半挂载状态。
- 绝不执行 hotpack 或下载内容里的任何脚本；npm 插件走 pnpm 正常依赖解析，github/path 源只做 link 挂载。
- 换包时 npm 源的旧插件会 `pnpm remove`（profile 保持干净，不与 dsh-hub 的 bundle 校对打架）；复用靠 pnpm store 缓存，重装不重新下载。
- 进 shell 的名字 / ref / repo 必须过白名单正则（`PACK_ID_RE` / `PLUGIN_NAME_RE` / `EXACT_VERSION_RE` / `REF_RE` / `REPO_RE`），参数走 argv，不做字符串拼接。
- 插件以用户权限作为本地代码运行，导入前请自行确认来源可信；本插件不做安全审核。

## 维护铁律

新增 Remote 方法必须同步三处：`lib/index.js` 的 methods 列表、`lib/typert.js` 的 invocations、`lib/client.js` 的 REMOTE.descriptors；`lib/typert.js` 不可删除（否则 RPC 404）。

Client 端通过 `settings.section` slot 注册独立设置页（需 inject `@deepseek-ai/dsh-client-ui-slots`，不是 `dsh-client-ui-settings`）。

## License

MIT
