# dsh-memory-hub

DSH 记忆中枢：**全局记忆包（memory-pack），与 profile 解耦，AI 可调用**。
切包不丢、可审计、写入有把关（确认制）、检索靠谱（BM25，CJK 友好）。

> 设计依据文档：`记忆中枢插件开发文档-草案.md`（v0.2 定稿，用户 8 项决策已固化）。
> 学习来源：esengine/DeepSeek-Reasonix（记忆内核）+ GitHub DSH 记忆插件调研
> （dsh-memory-evolve / graph-memory / dsh-mnemon / dsh-memento / dsh-noema）。

## 能力

| 面 | 说明 |
|---|---|
| `memory.search` | 关键词路由 → BM25 召回（标题/描述/keywords/body）；返回 `freshness` + 命中词 + 不可信声明 |
| `memory.commit` | 沉淀长期事实；writePolicy=ask（默认）时进入**待确认提案队列**，用户 `adopt` 才生效 |
| `memory.suggest` | AI 主动提案（永远进队列，绝不直写） |
| `memory.list` / `memory.forget` / `memory.audit` | 浏览 / 归档（进 .archive + revision 历史）/ 审计账本 |
| `/memory` 命令 | `list|search|proposals|adopt|reject|packs|audit|stats`（commands 服务存在时） |
| 冻结快照段 | 每会话首次 prompt 组装时把 pinned 记忆 + 概览注入 systemPrompt，**会话内永不中途变**（缓存友好） |

## 存储布局（默认 `~/.dsh/memory-hub/` 或 `$DSH_HOME/memory-hub/`）

```
memory-hub/
├── routes.json                # 关键词路由表（F4）
├── global-pack/               # 默认全局记忆包
│   ├── pack.json              # memoryPackId/scope/schemaVersion/keywords/entries
│   ├── entries/<name>.md      # 一事实一文件（frontmatter + body）
│   ├── index.json             # 检索索引镜像（可重建，非权威）
│   ├── .revisions/<id>/NNN.md # 条目历史版本
│   ├── .archive/<name>.md     # 遗忘归档
│   └── .proposals/*.json      # 待确认提案队列
└── .audit.jsonl               # 全局审计账本（滚动）
```

条目字段（`lib/constants.mjs` + `lib/store.mjs` 为准）：
`id (mem-<16hex>) / revision / createdAt / updatedAt / name / title / description /
type (user|feedback|project|reference) / scope (global|project) /
activation (relevant|pinned) / volatility (evergreen|stable|volatile) /
subjectKey（点分键，一 scope+subject 一活跃值）/ expiresAt（硬过期）/
lastVerifiedAt / keywords（双语同义词）/ tagged（[id: ] 跨设备合并锚点）/ body`。

## 配置（cordis.patch.yml / profile config）

```yaml
- insert:
    - id: memory-hub
      name: 'dsh-memory-hub'
      config:
        hubDir: null          # 默认 $DSH_HOME/memory-hub
        writePolicy: ask      # ask|auto|off（模型不可见，默认 ask=进提案队列）
        snapshotOrder: 50     # systemPrompt 段顺序
        snapshotChars: 2560   # 冻结快照字符预算
        searchLimit: 4        # 每次检索默认条数
```

## 审批门（确认制）

- **强制点在协议层**（`lib/protocol.mjs` 的 `authorize`，非工具层）——模型无法绕过。
- `ask`（默认）：模型任何写入 → `.proposals/` 提案，用户 `/memory adopt/reject` 拍板。
- `auto`：直写（保留给「用户口述」等明确意图）。
- `off`：写入整体禁用。
- 每次写（含拒绝）都落 `.audit.jsonl`（action/operator/outcome/via），可 `memory.audit` 审计。

## 协议

- `schema/dsh-memory-protocol-v1.schema.json`：记忆包/条目/写意图/提案/检索结果/审计的规范 Schema。
- 一致性套件：`test/conformance.test.mjs`（黄金参考校验 fixture）。

## 开发

```sh
# 用 DSH 内置 node（无全局 node 时）
"C:\Program Files\DSH Desktop\resources\node\node.exe" --test test/
```

- 零运行时依赖（`lib/` 只 `node:` 内置）；DSH 导入只在 `lib/index.mjs`。
- 测试：`node --test test/`（storage / BM25 / protocol / conformance）。
- 注册即 effect：tools / snapshot / command 全部经 `ctx.effect()` 返回 disposer；卸载即净。

## M0/M1 已实现

- [x] M0 骨架：包结构 / cordis.patch.yml / 存储层（pack+entries+原子写+路由）/ 工具/快照注入
- [x] M1：条目 CRUD（commit/list/forget/adopt/reject/restore）+ 提案队列 + 审批门（协议层强制点）+
      BM25 memory.search + 关键词路由 + protocol v1 Schema + 一致性套件 + 审计
- [ ] M2 缓存友好稳定前缀（快照已实现冻结语义，待前缀静态性验证）
- [ ] M3 自动记忆（task 收尾 commit + 每 N 轮审查）· L3 日志轨
- [ ] M4 GUI 记忆中枢页签（hybrid，DshTheme 令牌）
