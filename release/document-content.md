# DSH 热插拔中枢（dsh-hotplug-hub）说明文档

## 1. 项目简介

DeepSeek Harness（dsh）是插座，这个插件是插在插座上的“空排插”：本体不含任何原生插件，只负责导入外部热插拔包（hotpack）。不同场景切不同的包：科研包、视频包、考研包……切换是无损替换，全局记忆与会话不受影响。

本插件基于 dsh-hub 插件中枢的同一套机制：typert Remote 网关 + 设置页 + profile 原子写 + link 装配。可以和 dsh-hub 并存（设置页独立、数据目录独立）。

## 2. 三条设计原则

- 空插座：中枢不注册任何工具 / 预设 / 插件；apply() 只起一个 Remote 网关。
- 路径调用：包内插件按路径挂载：profile node_modules 或 hotplug-store 里已有同版本 → 直接调用（复用）；缺失才下载（缺失哪下哪）。
- 无损替换：同一时刻只有一个激活包；换包只替换 profile 的 patch 块 / bundles / link 依赖；~/.dsh/memory、会话、store 缓存全部保留。

## 3. 5 个子页签

安装后在 DSH 设置页出现“热插拔中枢”独立设置页（settings.section slot），内含 5 个子页签：

| 页签 | 功能 |
|---|---|
| 插件中枢 | 导入 hotpack JSON（粘贴或选文件）、包列表、预览（复用/待下载）、激活/停用/移除、store 缓存展示 |
| 插件包市场 | 6 个内置示例包目录（科研/视频/社交/考研/全栈/笔记），搜索 + 标签筛选 + 一键导入 |
| AI 装配间 | 人设化对话式装配（小织女仆/执事管家/咪咪猫娘/标准助手可切换）：自然语言需求 → 真实 LLM（DeepSeek / OpenCode / OpenRouter / 硅基流动 / Moonshot / 智谱 / MiniMax 或任意 OpenAI 兼容端点）→ 权威校验的 hotpack manifest + README → 复制 JSON 或一键导入；装配完成后可继续对话增量修改，会话本地续接，每轮展示新增/移除/调整 diff |
| 记忆中枢 | 展示 ~/.dsh/memory 全局记忆目录路径与 store 缓存条目 |
| 自检更新 | 调用 check() 远程方法，展示 Node/pnpm 版本、profile 状态、patch 状态、插件冲突矩阵、包数/store 数 |

## 4. 安装（Windows / macOS / Linux）

依赖：Node.js ≥ 22、pnpm、dsh CLI（@deepseek-ai/dsh-typert-protocol 用 DSH 自带的，无第三方依赖）。

### 4.1 macOS / Linux

```bash
./install.sh            # 自动探测 desktop / web / headless profile
./install.sh web        # 或指定 profile
```

install.sh 会自动：备份旧插件 → 复制 lib/package.json/examples/docs 到 ~/.dsh/plugin-src/dsh-hotplug-hub → 用 dsh plugin 注册 link 插件 → 向 cordis.patch.yml 写入激活行。

### 4.2 Windows

仓库内的 lib/index.js 已包含 Windows 分支：IS_WIN 时使用 curl.exe / tar.exe，curl 增加 --ssl-no-revoke，spawn 使用 shell 模式并 windowsHide。Windows 下手动安装等价于：

```text
mkdir %USERPROFILE%\.dsh\plugin-src
xcopy /E /I dsh-hotplug-hub %USERPROFILE%\.dsh\plugin-src\dsh-hotplug-hub
dsh plugin --profile desktop add "link:%USERPROFILE%\.dsh\plugin-src\dsh-hotplug-hub"
```

### 4.3 手动安装（macOS / Linux 等价命令）

```bash
mkdir -p ~/.dsh/plugin-src
cp -R dsh-hotplug-hub ~/.dsh/plugin-src/
dsh plugin --profile desktop add "link:$HOME/.dsh/plugin-src/dsh-hotplug-hub"
```

安装完重启 DSH，打开 设置 → 热插拔中枢。

## 5. 使用流程

1. 导入包：把 hotpack JSON 粘进插件中枢页签（或选 .hotpack.json 文件）。示例在 examples/。
2. 预览：列出包内每个插件是“复用”（绿）还是“待下载”（黄），不动任何文件。
3. 激活：缺的插件按需下载（npm 精确版本 / GitHub zip + 国内镜像 / 本地路径），挂进当前 profile；如果已有别的激活包，先无损卸载再挂载。
4. 停用 / 移除：停用卸载当前包（保留 store 缓存，下次激活秒复用）；移除只删包记录。
5. 挂载变更在重启 DSH 后生效（dsh profile 机制决定）。

也可以从插件包市场页签选示例包一键导入，或在 AI 装配间页签用自然语言描述需求自动生成 manifest，并继续对话调整。

## 6. Remote 服务 dshHotplug（11 个方法）

| 方法 | 参数 | 功能 |
|---|---|---|
| status | — | 中枢状态：profile / 激活包 / 已导入包 / store 缓存 |
| importPack | text | 导入 hotpack JSON（字符串或对象），只落盘不挂载 |
| preview | packId | 预演激活计划：每个插件 reused / download / error |
| activate | packId | 解析缺失插件并挂载（无损替换当前激活包） |
| deactivate | — | 卸载当前激活包（保留 store 缓存） |
| removePack | packId | 移除未激活的包记录 |
| check | — | 自检：Node/pnpm 版本、profile 状态、patch 状态、插件冲突矩阵、包数/store 数 |
| marketList | params | GitHub 市场列表（topic 搜索 + 多镜像测速，返回元数据） |
| marketDetail | params | 单仓库详情（README/package.json/hotpack 对比提取，含缓存） |
| aiAssemble | params | 需求 → LLM → 权威校验的 hotpack 清单 + README（多平台，key 仅内存/env） |
| aiChat | params | 人设化对话式装配：首轮组装，后续轮对话式增量修改/闲聊，会话本地续接，产物返回 diff |

## 7. 热插拔包格式（hotpack v1）

hotpack 是“下载路径 + 调用流程”的声明文件，本身不含插件代码；插件实体由热插拔中枢按路径解析：已有直接调用（复用），缺失才下载。

顶层字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| hotpack | 是 | 固定 "1.0" |
| id | 是 | 包唯一 id：[a-z0-9][a-z0-9._-]*，建议 pack.<场景> |
| name | 是 | 展示名 |
| version | 是 | 包版本（展示与覆盖判断用） |
| description | 否 | 一句话说明 |
| tags | 否 | 字符串数组 |
| plugins | 是 | 插件引用数组（顺序即 patch insert 顺序） |

plugins[] 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | 包内唯一短 id，用于生成 patch 实例 id |
| name | 是 | 合法 npm 包名（也是 profile node_modules 路径） |
| version | npm 必填 | 精确版本（不接受 range/tag） |
| source.type | 是 | npm / github / path |
| source.repo | github 必填 | owner/repo |
| source.ref | 否 | tag 或分支名（默认 main），限 [0-9A-Za-z._-] |
| source.path | path 必填 | 本地插件目录；支持绝对路径、~、$DSH_HOME 前缀 |
| config | 否 | 传给 cordis insert 的 config 对象 |

三种源：

- npm：必须精确版本（禁止 range）。缺失时 pnpm add --save-exact 装进 profile（走 pnpm 全局 store，装过的版本离线秒复用）。
- path：本地目录直接 link 挂载（同 graph-memory 模式），不下载。支持 ~ 和 $DSH_HOME 前缀展开。
- github：下载 zip 到 ~/.dsh/hotplug-store/<name>@<ref> 再 link；官方 codeload 优先，ghfast.top / gh-proxy / ghproxy 镜像兜底。包内 package.json 的 name 必须与清单一致。

示例（research.hotpack.json 摘要）：

```json
{
  "hotpack": "1.0",
  "id": "pack.research",
  "name": "科研热插拔包",
  "version": "1.0.0",
  "plugins": [
    { "id": "literature", "name": "@dsh-community/dsh-tool-literature", "version": "1.2.3", "source": { "type": "npm" } },
    { "id": "websearch", "name": "dsh-web-search-exa", "version": "0.4.2", "source": { "type": "npm" } }
  ]
}
```

## 8. 数据布局

```text
~/.dsh/hotplug-hub/
  state.json                  # 激活包 + 操作历史
  packs/<pack-id>/hotpack.json
~/.dsh/hotplug-store/         # github 源插件缓存（跨包复用）
  <name>@<ref>/
~/.dsh/profiles/<name>/
  package.json                # 中枢写入 link 依赖 + bundles 列表
  cordis.patch.yml            # 中枢写入 # hotplug:<packId> 块
```

## 9. 项目结构

```text
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
  install.sh            # 自动安装脚本（macOS / Linux）
  dsh-pack-hub/
    prototype.html      # 单文件跨平台原型（Windows / macOS 浏览器均可运行）
    README.md
    examples/research-pack.dshpack.json
```

## 10. 边界与红线

- profile 的 package.json / cordis.patch.yml 一律原子写（.tmp + .bak + rename），挂载失败自动回滚 patch 块与 bundles，不留半挂载状态。
- 绝不执行 hotpack 或下载内容里的任何脚本；npm 插件走 pnpm 正常依赖解析，github/path 源只做 link 挂载。
- 换包时 npm 源的旧插件会 pnpm remove（profile 保持干净，不与 dsh-hub 的 bundle 校对打架）；复用靠 pnpm store 缓存，重装不重新下载。
- 进 shell 的名字 / ref / repo 必须过白名单正则（PACK_ID_RE / PLUGIN_NAME_RE / EXACT_VERSION_RE / REF_RE / REPO_RE），参数走 argv，不做字符串拼接。
- 插件以用户权限作为本地代码运行，导入前请自行确认来源可信；本插件不做安全审核。

## 11. 维护铁律

- 新增 Remote 方法必须同步三处：lib/index.js 的 methods 列表、lib/typert.js 的 invocations、lib/client.js 的 REMOTE.descriptors；lib/typert.js 不可删除（否则 RPC 404）。
- Client 端通过 settings.section slot 注册独立设置页（需 inject @deepseek-ai/dsh-client-ui-slots，不是 dsh-client-ui-settings）。

## 12. 插件包系统规划摘要（DSH-插件包系统-具体规划.md）

- 核心结论：插件包应做成“组合层”，而不是第二套插件标准；真正要新建的是包中枢 + AI 组装器 + 记忆中枢，市场、安装、更新全部复用现有能力。
- 三个中枢 + 一个 AI 组装器：插件包市场、插件中枢、记忆中枢、AI 组装器。
- 包格式 v0.1：packId / name / version / scene / tags / requires / bundles / conflicts / memory / configDir / market。
- 安装执行流：解析并校验 manifest → Preflight（requires、精确 npm 版本、冲突矩阵）→ 逐 bundle 调用受管安装 → 全部成功后再写 pack receipt，失败回滚 → 用户确认后一次性重启。
- 热插拔语义：切换包只切换一组 bundle 的启用/停用，下一次 generation 生效；记忆包始终全局，不随切换丢失。
- 记忆包格式：memoryPackId / scope / schemaVersion / keywords / entries。
- 里程碑：M0 原型 → M1 包中枢 → M2 AI 组装器 → M3 记忆中枢 → M4 开源生态。
- 风险对策：精确版本 + 冲突矩阵 + 预检门槛 fail-closed；AI 只生成建议，安装必须走市场验证与用户确认。

## 13. 本仓库配套 Windows EXE 说明

本目录 release/DSH-Hotplug-Hub.exe 是根据仓库内的跨平台单文件原型 dsh-pack-hub/prototype.html 制作的 Windows 可执行程序。

- 制作方式：C# WinForms + Microsoft Edge WebView2 桌面控件，HTML 作为内嵌资源编译进 EXE；不启动浏览器，界面就是独立桌面窗口。
- 程序内容：插件中枢、插件包市场、AI 组装、记忆中枢、自检更新 5 个页签；使用 WebView2（Chromium 内核）渲染，和浏览器打开效果一致；数据保存在 WebView2 用户数据目录。
- 与 Windows/macOS 版本的关系：原型页面本身跨平台（Windows/macOS/Linux 浏览器均可打开）；EXE 用 WebView2 在桌面窗口内展示同一页面，同时兼顾仓库代码里的 Windows 分支（IS_WIN）与 macOS/Linux 安装脚本所对应的同一套产品设计。
- 运行要求：Windows 10/11，需要本机已安装 Microsoft Edge WebView2 Runtime（常见系统/Office 已自带）。无需安装 Node.js / pnpm / DSH；本 EXE 是产品原型演示，不修改真实 dsh profile。
- 使用：双击运行，直接弹出桌面窗口显示原型页面；关闭窗口即退出。不启动浏览器，不附加额外菜单/边框。
- 官方 Harness 接入：借鉴官方桌面端启动器布局，在左侧栏底部版本信息（profile desktop / dsh 0.1.0-rc.7）上方居中放置“▶ 启动 DSH 官方启动器”按钮，点击可启动官方 DSH Desktop；若已运行则自动切换到其窗口。
- 自动检测 / 手动选择：启动时会自动检测常见安装路径和 `%LOCALAPPDATA%\Programs`、`Program Files` 下的 DSH / DeepSeek 目录；如果找不到，会提示手动选择 `DSH Desktop.exe`，选择结果保存在 `%LOCALAPPDATA%\DSH-Hotplug-Hub\harness-path.txt`，下次自动使用。
- 选择桌面端：侧栏新增“📁 选择桌面端”按钮，可随时手动指定要启动的官方 DSH 桌面端；选择后立即刷新“系统自检”，并新增“官方 Harness 路径”检测行。
- 左侧导航按钮：已修复为真正切换界面（注入 `.hidden { display: none !important; }`），点击插件中枢 / 插件包市场 / AI 组装 / 记忆中枢 / 自检更新会正确切换页面。
- 系统自检：桌面 EXE 已接入真实环境检测——Node 版本、pnpm 版本、官方 Harness 路径/版本、WebView2 版本、本地 ~/.dsh/profiles 探测；点击“重新自检”会再次向 C# 请求并刷新真实数据；DSH 内部状态（冲突矩阵、patch 状态、插件健康）仍为模拟展示，真实自检需在 DSH 宿主环境调用 lib/index.js 的 check()。
- 下载官方客户端：系统自检的“DSH 版本”行新增“⬇ 下载官方客户端”按钮，点击会打开官方 GitHub Releases 下载页（https://github.com/deepseek-ai/deepseek-harness/releases/latest）。
- 安装程序：`installer/Setup.exe` 是 Windows 安装程序，默认安装到 `C:\DSH-Hotplug-Hub`（可更改）；安装内容包含 EXE、WebView2 DLL、启动器 launcher、assembly、sandbox、开发文档，并创建桌面/开始菜单快捷方式。
- 清晰度优化：EXE 使用自定义应用图标（src/app.ico），启动时启用 DPI Aware，侧栏 SVG 图标放大到 20px 并设置 shape-rendering: geometricPrecision，减少模糊。
- API 模型配置：左侧栏“⚙ DSH API 配置”直接使用官方 DSH 的 API 配置（读取 `~/.dsh/settings.yaml` 与 `~/.dsh/.credentials.yaml`），不再维护独立配置；弹窗只读展示当前 Provider / Model / Base URL / API Key，并提供“重新读取 / 打开配置目录 / 启动官方 DSH 配置”。
- AI 组装接入 API：AI 组装页新增模型下拉框，可切换模型；“开始组装”会直接使用官方 DSH 的 API 配置调用 OpenAI 兼容 `/chat/completions` 生成 hotpack/dshpack manifest + README，不再只是本地模拟。
- 依赖文件：EXE 同级目录需保留 Microsoft.Web.WebView2.Core.dll、Microsoft.Web.WebView2.WinForms.dll、WebView2Loader.dll。

## 14. 附录：仓库文件清单

| 文件 | 说明 |
|---|---|
| README.zh.md | 项目主 README（中文） |
| DSH-插件包系统-具体规划.md | 插件包系统 v0.1 规划 |
| package.json | 插件配置（ESM，peerDeps cordis + typert-protocol） |
| install.sh | macOS / Linux 安装脚本 |
| lib/index.js | host 端：7 个 Remote 方法、hotpack 解析、挂载/卸载（含 Windows 分支） |
| lib/client.js | client UI：5 子页签设置页 |
| lib/typert.js | TYPERT manifest：7 个 invocation 定义 |
| docs/hotpack-format.zh.md | hotpack v1 格式规范 |
| examples/research.hotpack.json | 科研热插拔包示例 |
| examples/video.hotpack.json | 视频热插拔包示例 |
| dsh-pack-hub/README.md | 插座中枢原型说明 |
| dsh-pack-hub/prototype.html | 单文件跨平台原型 |
| dsh-pack-hub/examples/research-pack.dshpack.json | .dshpack.json 示例 |
| release/DSH-Hotplug-Hub.exe | 生成的 Windows EXE（WinForms + WebView2 桌面版，本说明所在目录） |
| release/DSH热插拔中枢-说明.txt | 本说明 TXT 版 |
| release/DSH热插拔中枢-说明.docx | 本说明 Word 版 |

## 15. License

MIT
