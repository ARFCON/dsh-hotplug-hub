# 全局记忆功能 Spec（dsh-memory-hub）

> 状态：**待用户拍板**（本文为新 spec 草案，供确认后开始编写 / 对齐代码）
> 基线：**已发布 `dsh-memory-hub@0.8.0-pre`**（含 `memory.update`、GUI 编辑/删除、重要信息主动提醒）。
> 范围：**完整记忆中枢 = dsh-memory-hub 插件 + 桌面「记忆中枢」面板**（本次用户确认）。
> 与既有文档的关系：本文吸收了 `记忆中枢插件开发文档-草案.md`（v0.3）的已拍板决策 Q1–Q8 与 M0–M4 里程碑，并将基线提升到 0.8.0-pre；后续代码对齐以本文为准。

---

## 1. 背景与目标

Dseam世界（DSH-Hotplug-Hub，v0.9.4 桌面应用）的核心能力之一是**全局记忆中枢**：让 AI 助手具备跨会话、跨 profile、切包不丢的长期记忆，同时保证**写入有把关、召回靠谱、可审计、缓存友好、卸载即净**。

- 记忆中枢 = `dsh-memory-hub` 插件（DSH 运行时内） + 桌面「记忆中枢」面板（WebView2 GUI）。
- 插件本体实现：`dsh-hotplug-hub/dsh-hotplug-hub/dsh-memory-hub/`（仓库内包）。
- 与 profile 解耦：记忆包存用户数据目录 `~/.dsh/memory-hub/`，**不注册为任何 profile 的直接 bundle**，切换 profile / 切换插件包不丢记忆。
- 桌面应用启动时自动安装 / 更新 `dsh-memory-hub`（从 GitHub Release 解析 `dsh-memory-hub-0.8.0-pre.tgz` 资产），失败记日志不阻塞启动。

**目标**：不碰引擎、不 fork DSH、随装随用、卸载即净——缓存友好、写入有把关、召回靠谱、可审计、协议可互操作。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| memory-pack / 记忆包 | `memoryPackId` 标识的全局记忆集合，含 `pack.json` + `entries/` |
| entry / 条目 | 一事实一文件（Markdown + frontmatter），对应一条长期记忆 |
| 提案 / proposal | AI 写入的待确认载荷，用户采纳才生效 |
| writePolicy | 写策略：`ask`（默认，进提案队列）/ `auto`（直写）/ `off`（禁写） |
| pinned | 常驻条目，进稳定 systemPrompt 快照（预算内） |
| relevant | 可召回条目，进 BM25 检索池（不进稳定前缀） |
| L3 日志轨 | `memory.log` 产生的高频日志（daily / project-<slug>），不注入、不召回 |
| 快照段 / 尾部段 | systemPrompt 的两个注入位：冻结快照（会话不变） + 变更尾部（一次即消失） |

---

## 3. 范围

### 3.1 In Scope

- **插件面**：存储层、条目 CRUD、提案队列入口、工具面、关键词路由、BM25 检索、审批门、审计、缓存友好注入、L3 日志轨、回合内自我审查、协议层（v1 Schema + 一致性套件）、Web API 数据面。
- **桌面面板面**：真实读写 `~/.dsh/memory-hub`；记忆列表/搜索/查看/编辑/删除；待确认提案采纳/驳回；审计查看；与插件协议一致。
- **接线**：桌面启动自动安装/更新插件；固定提示行引导 AI 沉淀。

### 3.2 Out of Scope（本期不实现，接口预留）

- embedding 语义检索（规划 line 180「后续可加 embedding」）：`memory.search` 保持词法 BM25，接口形态允许未来扩展向量后端。
- 跨设备 Git 同步对账（memory-evolve 的 `[id:xxxx]` 合并锚点已预留在 `tagged` 字段，本期不做同步 UI/对账）。
- 图谱记忆（graph-memory 式社区/PageRank）：不在本期。

---

## 4. 功能需求（FR）

### 4.1 插件面（dsh-memory-hub@0.8.0-pre）

| 编号 | 需求 | 备注 |
|---|---|---|
| FR-1 | `memory.search`：关键词路由 → BM25 召回（标题/描述/keywords/body） | 返回 `freshness` + 命中词 + 不可信声明 |
| FR-2 | `memory.commit`：沉淀长期事实；writePolicy=ask 时进待确认提案队列 | 用户 `adopt` 才生效 |
| FR-3 | `memory.suggest`：AI 主动提案（永远进队列，绝不直写） | 与 commit 不同点是强制队列 |
| FR-4 | `memory.update`：按 id 更新条目（title/body/description/keywords/type） | 0.8.0-pre 新增；ask 模式进提案，采纳后 revision+1、updatedAt 刷新 |
| FR-5 | `memory.list`：浏览条目 / 归档 / 提案 / 记忆包 | `what` in entries|packs|proposals|archived |
| FR-6 | `memory.forget`：归档条目（进 `.archive`，保留 revision 历史） | ask 模式进提案 |
| FR-7 | `memory.audit`：审计账本查询 | 按 entryId / limit 过滤 |
| FR-8 | `memory.log`：L3 日志轨（daily / project-<slug>），不注入、不召回 | 高频笔记与记忆分离 |
| FR-9 | `memory.review_status` / `memory.review_done`：回合内自我审查（M3 方案 B） | 每 N 次记忆变更后 due |
| FR-10 | 关键词路由：`routes.json` 多记忆包，query 分词包含匹配路由；未命中走 fallback | 两端长度≥2 才判包含 |
| FR-11 | 冻结快照段：pinned 记忆 + 概览注入 systemPrompt，会话内永不中途变（WeakMap 按 Session 冻结） | 缓存友好核心 |
| FR-12 | 固定提示行：稳定前缀内恒定引导（重要信息主动提醒；收尾自动沉淀） | 文本恒定，不产生新前缀快照 |
| FR-13 | 变更检测尾部注入：写入/采纳/驳回/新提案 → 下一轮 prompt 尾部注一次即消失；空闲轮逐字节复用前缀缓存 | 有界队列 64 |
| FR-14 | pinned 预算：超 `snapshotChars` 拒绝 pinned（提示常驻规则进指令文件），绝不截断 | BUDGET_EXCEEDED |
| FR-15 | `/memory` 命令面：`list|search|proposals|adopt|reject|packs|audit|stats` | commands 服务存在时注册 |
| FR-16 | Web API 数据面：`/memory-hub/api/*`（同源 fence） | 供桌面面板与插件 GUI 消费 |

### 4.2 桌面面板面（记忆中枢）

| 编号 | 需求 | 备注 |
|---|---|---|
| FD-1 | 真实读写 `~/.dsh/memory-hub`，不展示假数据 | 覆盖 v0.1.7 起「记忆中枢真实化」 |
| FD-2 | 记忆列表 / 搜索（BM25 走插件 / 面板内置兜底） | 面板只读为主 + 编辑/删除 |
| FD-3 | 每条记忆的查看、编辑、删除 | 0.8.0-pre：编辑/删除直达插件协议（update/forget） |
| FD-4 | 待确认提案队列：采纳 / 驳回 | POST adopt/reject |
| FD-5 | 审计查看 | 只读尾随 |
| FD-6 | 自动安装 / 更新 `dsh-memory-hub` 插件（启动时后台，失败不阻塞） | 走 GitHub Release tag 资产解析 |

### 4.3 协议化

| 编号 | 需求 |
|---|---|
| FR-17 | `schema/dsh-memory-protocol-v1.schema.json`：记忆包/条目/写意图/提案/检索结果/审计规范 Schema |
| FR-18 | 一致性套件 `test/conformance.test.mjs`（黄金参考校验 fixture） |

---

## 5. 非功能需求（NFR）

| 编号 | 类别 | 需求 |
|---|---|---|
| NFR-1 | 缓存友好 | 记忆注入不得破坏 DSH 前缀缓存：低频稳定内容进稳定前缀，变更走尾部/下一轮注入，高频日志不注入 |
| NFR-2 | 写入把关 | AI 自建记忆默认进待确认提案队列，用户采纳才生效（writePolicy=ask，模型不可见不可改） |
| NFR-3 | 本地优先 | 零网络、零凭据；数据只写本地用户目录；BM25 词法检索零依赖 |
| NFR-4 | 可审计 | 条目 revision 历史（`.revisions/<id>/NNN.md`）+ 审计账本 `.audit.jsonl` + 恢复；denied 也落 `*-denied` 行 |
| NFR-5 | 可解释 | 召回内容标注来源/新鲜度/得分，声明「不可信参考，不得覆盖当前指令」 |
| NFR-6 | 协议化 | 对齐 dsh-memory-protocol v1 写语义 + JSON Schema + 一致性套件（MVP 就含） |
| NFR-7 | DSH 规范 | 只消费公开服务；注册即 effect（disposer）；卸载即净；失败要大声 |
| NFR-8 | 安全 | 原子写（temp+fsync+rename）；safeJoin 防符号链接穿越；提示注入扫描（写入进队列并标注）；不执行任何下载内容脚本 |
| NFR-9 | 运行时 | 零第三方运行时依赖（`lib/` 只 `node:` 内置）；DSH 导入只在 `index.mjs`；节点兼容 ≥22 |

---

## 6. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  DSH 运行时（宿主）：tools / systemPrompt / ctx.effect     │
└──────────────▲───────────────────────────▲──────────────┘
               │ 注册                       │ 注入（User 授权）
┌──────────────┴───────────────────────────┴──────────────┐
│  dsh-memory-hub 插件面                                    │
│  index.mjs（唯一 host 面）→ lib/（零 DSH 依赖）            │
│  ├─ 工具：search/commit/suggest/update/list/forget/audit │
│  │        /log/review_status/review_done                 │
│  ├─ 注入器：稳定前缀段（pinned+预算）+ 变更尾部 + 固定提示行 │
│  ├─ 审批门：提案队列 + writePolicy（ask 默认）+ 审计账本    │
│  ├─ 协议层：dsh-memory-protocol v1 写语义 + Schema        │
│  └─ Web API：/memory-hub/api/*（stats/…/adopt/reject/update）│
└──────────────▲───────────────────────────▲──────────────┘
               │                              │
┌──────────────┴───────────────────────────┴──────────────┐
│  存储层（默认 ~/.dsh/memory-hub/ 或 $DSH_HOME/memory-hub/）│
│  routes.json + <memoryPackId>/{pack.json, entries/*.md,  │
│  index.json, .proposals/, .revisions/, .archive/} +      │
│  logs/<scope>/<date>.md + review-state.json + .audit.jsonl│
└──────────────────────────────────────────────────────────┘
              ▲
┌─────────────┴───────────────────────────────────────────┐
│  桌面「记忆中枢」面板（WebView2 / settings.section）        │
│  显示/搜索/编辑/删除记忆、提案采纳/驳回、审计             │
└──────────────────────────────────────────────────────────┘
```

- **与 profile 的关系**：记忆包位于用户数据目录，不注册为任何 profile 的 bundle——插件的 bundles 只声明运行时逻辑，记忆本体全局存在，切 profile/切包不丢（规划 line 182）。
- **层**：L1 常驻层（pinned，低频稳定 → 稳定前缀段，预算控制）；L2 事实层（可检索条目，一事实一文件，memory.search 召回）；L3 日志层（project/daily 日志，不注入、按需读取）。

---

## 7. 数据模型与存储布局

### 7.1 存储布局（默认 `~/.dsh/memory-hub/`）

```
memory-hub/
├── routes.json                # 关键词路由表（FR-10）
├── global-pack/               # 默认全局记忆包
│   ├── pack.json              # memoryPackId/scope/schemaVersion/keywords/entries
│   ├── entries/<name>.md      # 一事实一文件（frontmatter + body）
│   ├── index.json             # 检索索引镜像（可重建，非权威）
│   ├── .revisions/<id>/NNN.md # 条目历史版本
│   ├── .archive/<name>.md     # 遗忘归档
│   └── .proposals/*.json      # 待确认提案队列
├── logs/<scope>/<YYYY-MM-DD>.md   # L3 日志轨（FR-8）
├── review-state.json          # 审查状态（FR-9）
└── .audit.jsonl               # 全局审计账本（滚动归档）
```

### 7.2 routes.json

```jsonc
{
  "schemaVersion": 1,
  "routes": [
    { "keywords": ["用户", "偏好"], "packId": "global-pack" },
    { "keywords": ["构建", "插件", "build"], "packId": "project-devtools" }
  ],
  "fallbackPackId": "global-pack"
}
```

### 7.3 pack.json

```jsonc
{
  "memoryPackId": "global-pack",
  "scope": "global",           // global | project:<slug>
  "schemaVersion": 1,
  "keywords": ["用户", "偏好", "约定"],
  "entries": 42,               // 镜像计数
  "updatedAt": "2026-08-19T00:00:00Z"
}
```

### 7.4 条目字段（`entries/<name>.md`）

```markdown
---
id: mem-9f3a2c1d              # mem-<16hex>，不可变
revision: 3                    # 单调从 1；update/采纳后 +1
createdAt: 2026-08-19T00:00:00Z
updatedAt: 2026-08-19T01:00:00Z
name: dsh-plugin-build-rule    # kebab slug，Unicode 规则
title: DSH 插件构建规则
description: 插件包用 dev_build_plugin 构建，产物 tgz 进桌面
type: project                  # user|feedback|project|reference
scope: global                 # global|project
activation: relevant           # relevant|pinned（pinned=进稳定前缀，预算内）
volatility: stable             # evergreen|stable|volatile
subjectKey: dsh.build_plugin   # 点分键，一 scope+subject 一活跃值；撞占报 holder 建议 update 成 revision
expiresAt: null                # 硬过期 YYYY-MM-DD；过则停自动召回，显式 search 可见
lastVerifiedAt: null
keywords: ["构建", "插件", "build", "tgz"]
tagged: [id: mem-9f3a2c1d]     # 跨设备同步合并锚点（本期仅预留）
---
正文（Markdown）。
```

- 引用只认 `project/<name>.md | global/<name>.md` 限定形式（REF_RE）。
- 正则（`lib/constants.mjs` 为准）：`PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i`；`NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u`；`REF_RE`；`ID_PREFIX='mem-'`；`LEGACY_ID_RE`（迁移，不生成）。
- 枚举：`SCOPES=['global','project']`；`TYPES=['user','feedback','project','reference']`；`ACTIVATIONS=['relevant','pinned']`；`VOLATILITIES={evergreen:[36500,36500], stable:[90,365], volatile:[7,30]}`；`TYPE_FRESHNESS={user:[90,365], feedback:[90,365], project:[14,45], reference:[14,45]}`。

### 7.5 硬上限（`DEFAULTS`，`lib/constants.mjs`）

| 常量 | 值 | 含义 |
|---|---|---|
| searchLimit | 4 | 默认检索条数 |
| searchLimitMax | 8 | 检索条数硬上限 |
| searchChars | 2400 | 召回返回总字符预算 |
| snippetChars | 300 | 单条 snippet 上限 |
| snapshotChars | 2560 | 稳定前缀字符预算（FR-14） |
| staleFactor | 0.92 | BM25 stale 降权系数 |
| strongMatchTerms | 2 | 强匹配捷径 |
| strongTermRunes | 6 | 单 term 超长即强区分 |
| keepRelativeScore | 0.24 | 相对高分保留系数 |
| maxPendingProposals | 200 | 提案队列硬上限 |
| proposalMaxChars | 8192 | 提案单条字符上限 |
| auditRollAfter | 5000 | 审计账本滚动阈值 |
| tailMaxNotices | 8 | 尾部注入单轮条数 |
| tailMaxChars | 800 | 尾部注入字符预算 |
| pinnedEstimatePad | 40 | pinned 单条目预算估算垫 |

---

## 8. 接口契约

### 8.1 工具面（index.mjs 为准，全部 `isConcurrencySafe`、`timeoutMs=10_000`、输出 `TEXT_OUTPUT`）

| 工具 | 关键参数 | 权限 |
|---|---|---|
| `memory.search` | `query`(必填)/`pack`/`includeExpired` | 只读 |
| `memory.commit` | `title`(必填)/`body`/`description`/`type`/`keywords`/`subjectKey`/`activation`/`volatility`/`expiresAt`/`pack` | 写（ask→提案） |
| `memory.suggest` | `title`(必填)/`body`/`description`/`reason`/`pack` | 写（强制队列） |
| `memory.update` | `id`(必填)/`title`/`body`/`description`/`keywords`/`type` | 写（ask→提案；采纳后 revision+1） |
| `memory.list` | `what`(entries|packs|proposals|archived)/`pack`/`status`/`limit` | 只读 |
| `memory.forget` | `id`(必填) | 写（ask→提案） |
| `memory.audit` | `limit`/`entryId` | 只读 |
| `memory.log` | `scope`(daily|project-<slug>)/`text`(必填，自动 UTC 前缀) | 写（直写 L3 轨） |
| `memory.review_status` | — | 只读 |
| `memory.review_done` | — | 写（持久化 lastReviewedAt+markedTurns） |

- **返回约定**：search 结果带 `id/revision/scope/type/freshness/score/匹配理由` + 标题 + 正文片段；块前缀 `<memory-recall>` + 不可信声明（`STRINGS.untrustedWarning`）。
- **错误约定**：预算超限 → `BUDGET_EXCEEDED`；引用歧义 → `AMBIGUOUS_MATCH`；subject 冲突 → 报 holder id 建议 update 成 revision；找不到条目 → `NotFoundError`。
- **search 路由**：`routePackId(routes, query)` 对 query 分词（`queryTerms`），每个 route 的 keywords 与 term 做**双向包含匹配**（`term.includes(kw) || kw.includes(term)`），两端长度≥2；取分最高包；未命中 fallback。显式 `pack` 参数优先且不存在返回空结果。

### 8.2 systemPrompt 注入

- **快照段** `dsh-memory-hub:memory`，`order=cfg.snapshotOrder(50)`：每会话首次 assemble 冻结（WeakMap<Session,String>）。渲染 `# 记忆` 头 + 记忆包列表 + 活跃条目数 + 待确认提案数 + `## 常驻记忆（pinned）`。预算处理：先钳动态部分（`cap = snapshotChars - fixed.length - 8`），**固定提示行永不裁掉**。
- **尾部段** `dsh-memory-hub:memory-tail`，`order=snapshotOrder+1`：`changeLog` 有界队列（64），`_postChange` 走协议层单一入口；`tailSeen`（WeakMap<Session,at>）上次展示时间；无变更返回 `''`（空闲轮逐字节复用前缀缓存）；有变更返回最后 `tailMaxNotices` 条（`- ${action} ${packId}${/name} (${proposalId})`），超 `tailMaxChars` 截断。
- **固定提示行（0.8.0-pre 文案，必须恒定）**：
  > [dsh-memory-hub 记忆约定：当用户说出重要信息（偏好/决定/约束/背景/纠正/长期目标）时，先提醒用户"这条我会记住"，然后调用 memory.suggest 提案记忆（ask 模式下进待确认提案，绝不绕过确认直接 commit）；用户要求修改或删除记忆时，用 memory.update / memory.forget。不要主动展开全部记忆；每完成若干用户任务，调用 memory.review_status 检查审查到期的沉淀建议。变更会在下一轮注入，不影响本会话前缀。]

### 8.3 /memory 命令面

`list | search <q> | proposals | adopt <packId> <proposalId> | reject <packId> <proposalId> | packs | audit | stats`（commands 服务存在时注册；未 inject，用 `ctx.get('commands')` 防抛错；监听 `internal/service` 服务上线后补注册）。

### 8.4 Web API 数据面（`/memory-hub/api/*`）

- 挂载：`ctx.inject(['webServer'])`；`kind='prefix'`、`path='/memory-hub/api'`；**同源 fence** `trustedOrigin`（Origin 存在须与 Host 一致；无 Origin 只认 127.0.0.1/localhost/[::1]）。
- 方法（`buildMemoryApi(service)` 纯处理器）：`stats`（hubDir/packs/activeEntries/pinned/pendingProposals/writePolicy/review）、`packs`、`entries`（搜索/过滤）、`proposals`、`audit`、`logs`、`adopt`、`reject`、`update`（编辑）、`forget`（删除）。
- 错误码映射：404（NOT_FOUND/not-found）、409（WRITE_DENIED/BUDGET_EXCEEDED/SUBJECT_CONFLICT/AMBIGUOUS_MATCH）、500 其他。
- client 合约：`lib/client.js` vanilla React；`__ModuleLoader__.load` + exports `{name, inject:['slots','locale'], apply}`；`ctx.slots.inject('settings.section', …)` 挂「记忆中枢」页；DshTheme 令牌 scoped 样式；双语 zh/en；采纳/驳回/编辑/删除走 `POST adopt/reject/update/forget`。
- 已知边界：运行时注入只保证 host 立即生效；client 由 dsh-client-modules 在 **DSH 重启时**扫描 junction 注册（对全部注入型 client 插件一致），页面在重启后出现在 设置 → 记忆中枢。

### 8.5 配置（cordis.patch.yml / profile config）

```yaml
- insert:
    - id: memory-hub
      name: 'dsh-memory-hub'
      config:
        hubDir: null             # 默认 $DSH_HOME/memory-hub
        writePolicy: ask         # ask|auto|off（模型不可见，默认 ask）
        snapshotOrder: 50
        snapshotChars: 2560
        searchLimit: 4
        reviewEveryTurns: 8
        tailMaxNotices: 8
        tailMaxChars: 800
```

---

## 9. 设计决策（含已拍板 Q1–Q8 + 本次新确认）

| 项 | 决策 | 影响 |
|---|---|---|
| Q1 插件形态 | **hybrid**：工具 + Web 面板（桌面面板 + settings.section） | §4.2 / §8.4 |
| Q2 审批门 | **writePolicy 默认 ask**：AI 写入全进待确认提案队列 | §8.5 |
| Q3 记忆包组织 | **严格多记忆包 + 关键词路由**（MVP 即 routes.json） | §7.2 |
| Q4 作用域 | **global 为主，project 以条目 scope+日志轨体现** | §7.4 |
| Q5 检索 | **MVP 就上 BM25**（词法零依赖子串并行） | §8.1 |
| Q6 自动记忆 | **A+B 都要**：收尾 commit/重要信息提醒 + 每 N 轮 review_status/review_done | FR-9/FR-12 |
| Q7 放置位置 | **dsh-hotplug-hub 仓库内新包 `dsh-hotplug-hub/dsh-memory-hub/`**（与 dsh-pack-hub 并列） | 工程布局 |
| Q8 协议化 | **MVP 就对齐全套** dsh-memory-protocol v1 + Schema + 一致性套件 | FR-17/FR-18 |
| **S1 范围（本次）** | **插件 + 桌面记忆中枢面板（完整中枢）** | §3 |
| **S2 基线（本次）** | **已发布 0.8.0-pre**（含 memory.update + GUI 编辑/删除 + 重要信息提醒）；仓库源码 0.2.0 需对齐拉到 0.8.0-pre | §10.2 |
| **S3 文档（本次）** | **完整 Spec：需求+设计+验收**（本文），放仓库 `开发文档/` | — |

### 9.1 设计要点采纳清单（D1–D12）

| # | 要点 | 来源 | 采纳 |
|---|---|---|---|
| D1 | 一事实一文件 MD + frontmatter + 索引 + 原子写 + 引用限定 | Reasonix | §7.4 |
| D2 | 稳定前缀只放低频稳定内容；变更走尾部注入；固定提示行 | Reasonix + memory-evolve | §8.2 |
| D3 | 条目字段模型（id/revision/type/scope/activation/volatility/subject_key/expires/last_verified/keywords） | Reasonix | §7.4 |
| D4 | 确认制：AI 写入进待确认队列（writePolicy=ask 默认） | memory-evolve + memento | Q2 |
| D5 | 审批门强制点在服务/协议层写方法内部，不在工具层 | memento | §8.1 / protocol.authorize |
| D6 | 有界召回：BM25（CJK）/条数与字符预算/freshness/过期排除/不可信声明 | Reasonix + memento | §8.1 |
| D7 | 高频日志轨不注入；待办与记忆分离 | memory-evolve | §6 层 / FR-8 |
| D8 | 审计：revision 历史 + 审计账本 + 恢复 | Reasonix + memento | NFR-4 |
| D9 | 关键词路由激活记忆包；embedding 接口预留 | 规划 + graph-memory | FR-10 / §3.2 |
| D10 | 会话事件 memory/* declared-not-emitted 陷阱：审计走已知事件 + 插件审计表 | memento | NFR-4 |
| D11 | 条目 ID `[id:xxxx]` 同步锚点预留 | memory-evolve | §7.4 tagged |
| D12 | 协议化：写语义 + JSON Schema + 一致性套件（MVP） | memento | FR-17/18 |

---

## 10. 里程碑与验收标准

### 10.1 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 骨架** | 包结构、cordis.patch.yml、lib/ 骨架、存储层（routes.json + pack.json + entries 原子写）、注入器（稳定前缀空实现 + 固定提示行） | 注入后 `dev_plugin_status` 正常；卸载即净 |
| **M1 存储/检索/协议** | 条目 CRUD（commit/list/forget）+ 提案队列 + 审批门 + BM25 memory.search + 关键词路由 + protocol v1 核心 + Schema + 一致性套件 | 端到端：写入→提案→采纳→BM25 检索命中；审计可查；一致性套件全绿 |
| **M2 缓存友好上线** | 稳定前缀（pinned 渲染+预算）+ 变更检测尾部注入 | 前缀静态性验证（无写入时快照逐字节不变） |
| **M3 自动记忆** | 方案 A 收尾 commit + 方案 B 每 N 轮审查 + L3 日志轨 | 任务完成自动打包；审查产出进提案队列 |
| **M4 GUI 页签** | 记忆中枢页（只读浏览/检索/提案/审计，DshTheme 令牌） | 与桌面面板页一致；页面接真实数据 |

### 10.2 现状与待办（基线 0.8.0-pre）

- **已完成（本机 43/43 测试绿 + 运行时验证）**：
  - **源码已对齐 0.8.0-pre**：仓库内 `dsh-memory-hub/` 的 `package.json`（version 0.8.0-pre + `dsh.bundle.patch`）、`lib/index.mjs`（补 `memory.update` 工具）、`lib/service.mjs`（补 `updateDirect`/`removeDirect`）、`lib/store.mjs`（空 catch 注释）、`lib/constants.mjs`（0.8.0-pre 固定提示行文案）、`lib/webapi.mjs`（补 `update`/`forget` 端点）、`lib/client.js`（GUI 编辑/删除）已与**已发布 `dsh-memory-hub-0.8.0-pre.tgz` 逐字节一致**（hash 复核通过；仅 `types.d.ts` 为仓库独有开发类型契约，不入包）。
  - **测试**：`node --test` → **43/43 全绿**（原 40 + 新增 3：webapi update/forget 直接编辑删除 + memory.update ask 门 update 提案语义 + 不存在 id 抛错）。运行依赖说明：本机无全局 node/git，测试用 DSH 内置 `vendor/node/node.exe --test test/*.test.mjs`；`dsh-memory-hub/node_modules` junction 原指向已不存在的 `C:\Program Files\DSH Desktop\resources\app\node_modules`，已改为指向 `C:\Users\BangBang\AppData\Local\DSH Desktop\dsh-desktop\node_modules`（修复悬空 junction）。
  - **运行时注入验收**：`dev_inject_plugin` 注入成功（host ✓ + client ✓）；`GET /memory-hub/api/stats` 返回真实 hubDir/packs/writePolicy/review；`/memory-hub/api/entries` 正常。卸载即净已验证。
- **待人工过目**：M4 面板重启后截图核验 settings.section 渲染与令牌一致性；桌面 EXE 记忆中枢面板与插件交互联调（编辑/删除按钮 → update/forget 端点）。
- **版本说明**：版本号（0.8.0-pre）按《版本号管理规范》由 Owner 复核；仓库源码 version 与发布包已一致。

---

## 11. 安全红线

- 不执行 hotpack / 下载内容里的任何脚本；npm 走 pnpm，github/path 只 link。
- 白名单正则（PACK_ID_RE / NAME_RE / REF_RE）+ argv 传参。
- profile 文件原子写，失败回滚；记忆写前 snapshot 进 `.revisions/`。
- 提示注入扫描：写入 body/keywords 扫可疑指令注入，命中进提案队列并标注。
- 审批门模型不可见不可绕过（强制点在协议层 `authorize`）。
- 用户确认安装；自愈只改 sandbox，不碰用户现有 profile。

---

## 12. 测试策略

- `node --test test/` 单测：`store.test.mjs`（存储/原子写/路由/日志/审查状态）、`bm25.test.mjs`（CJK BM25/新鲜度/过期/预算）、`protocol.test.mjs`（写语义/审批门/审计/restore）、`conformance.test.mjs`（协议一致性套件，黄金参考）、`m2m3-milestones.test.mjs`（前缀静态性/尾部一次消失/预算拒绝）、`webapi.test.mjs`（纯处理器）。
- 本机真实 DSH 冒烟：注入 → `/memory-hub/api/*` → `memory.log` → `memory.review_status` → 卸载即净。
- 桌面面板联调：重启后 settings.section 渲染、编辑/删除/采纳/驳回直达协议。

---

## 13. 开放问题（本期不分叉实现）

- 市场托管位置与插件签名（与包中枢共用，非记忆专属）。
- embedding 语义检索后端选型（接口预留，`memory.search` 不支持时保持 BM25）。
- 跨设备 Git 同步与 `[id:xxxx]` 合并锚点真正启用（本期仅字段预留）。

---

## 14. 参考资料

- esengine/DeepSeek-Reasonix：internal/memory/（store/store_v2/remember/auto_recall/freshness/queue/quickadd）+ benchmarks/memorybench/
- github.com/csyangwen/dsh-memory-evolve（五轨+确认制+git 分支+同步）
- github.com/PerryLink/dsh-memento（能力接缝+审批门+审计+protocol v1）
- github.com/adoresever/graph-memory（图谱+双路径召回+FTS5/向量）
- github.com/omdsh-dev/dsh-mnemon（三层+Provider）· github.com/ZSeven-W/dsh-noema
- dsh-hotplug-hub：DSH-插件包系统-具体规划.md（记忆中枢定义/M3 里程碑）、开发文档/规范/DSH-统一UI开发标准.md（令牌）、更新历史.md（0.1.x–0.9.4 记忆中枢演进）
- 记忆中枢插件开发文档-草案.md（v0.3，Q1–Q8 已拍板决策 + M0–M4 验收）
