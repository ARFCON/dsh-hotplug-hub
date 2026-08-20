# launcher — 独立启动器（Hexagonal 六层重构版）

DSH-Hotplug-Hub 的核心启动器：把 `assembly/<id>/assembly.json` 组装为 DSH 可加载的
profile（sandbox 产物 → `~/.dsh/profiles/<id>` 同步 → 拉起 DSH → 自愈闭环）。

> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`。

## 架构（分层 + 端口适配器，单向依赖）

```
index.js                  # CLI 入口（解析 → 分发 → 格式化 → 退出码）
cli/                      # parser（--yes/--wait/--json 位置无关）· format（人类/JSON 双模式）
app/                      # create-core（依赖注入容器）· pipeline（状态机编排）
                          # stages（写阶段）· stages-readonly（只读阶段）· stages-heal（自愈）
domain/                   # 纯函数零副作用：ids/assembly/resolve/conflicts/classify/patch/healplan/manifest
contracts/                # errors（32 错误码）· schemas（5 JSON Schema）· state-machine · constants
ports/                    # 端口接口：fs/proc/registry/dsh/now（未注入抛"端口未注入"）
infra/                    # 副作用实现：atomic/lock/store/snapshot/runlog/install/profile/
                          # harness/launch/monitor/heal/heal-steps/heal-verify/dsh-cli/tree-util
test/                     # vitest 测试（40 文件 359 用例）
scripts/                  # lint/depcheck/测试启动器/QA e2e（三平台可跑）
```

关键契约：32 错误码（退出码 2-12）、`state.json` 唯一状态源、`cordis.patch.yml`
（yaml 序列化 + 回读自校验）、`run.jsonl`（seq 连续 + 5MB 滚动）、命令 = 状态机子流水线。

## 运行方式

```bash
# 安装依赖（yaml + semver 运行时；vitest 测试）
npm ci

# 测试 / lint / 依赖声明校验
npm test                # 备选（更稳）：node scripts/run-tests.js run
npm run lint
npm run depcheck

# 进程级 QA（隔离 HOME + DSH_HOTPLUG_ROOT；假工具链真实子进程，无需外网）
node scripts/qa3-cli-e2e.js             # CLI 全链路 27 项
node scripts/qa3-cli-e2e-crashloop.js   # CRASH_LOOP 闭环 16 项
node scripts/qa3-concurrency.js         # 并发锁 / 无孤儿 13 项
node scripts/qa3-fuzz.js                # 模糊测试 3342 断言
node scripts/qa3-fs-fault-injection.js  # 故障注入 15 项
node scripts/qa4-real-env.js            # 真实环境（假 npm / git / .cmd harness）13 项

# CLI（根目录语义与旧版一致：assembly/sandbox 位于仓库根；
# 可用 DSH_HOTPLUG_ROOT 显式指定根目录做隔离运行）
node launcher/index.js assemble <id>
node launcher/index.js check <id>
node launcher/index.js install <id>
node launcher/index.js launch <id> [--wait]
node launcher/index.js heal <id> [--yes]
node launcher/index.js status <id> [--json]
node launcher/index.js rollback <id>
node launcher/index.js logs <id> [--tail N]
node launcher/index.js --help
```

> 正确流程：`assemble → install → launch`（状态机守卫强制前置；未 install 直接
> launch 会被拒绝）。`heal` 默认预览，`--yes` 才执行；无自愈信号时退出码 9。

## 与旧版（core.js）的关键差异

- 产物可验证：cordis.patch.yml 由 yaml 库生成并回读自校验（修复非法 YAML）；
- 插件真实落地：`dsh plugin add` 通道 + npm 降级 + github 镜像重试；path 源建
  junction/symlink（非复制壳）；
- 自愈闭环：执行 + 验证 + 回滚 + 重试预算；CRASH_LOOP 回滚快照 + 隔离最近插件并
  重置崩溃计数（不再恒 ERR_HEAL_BUDGET）；
- 隔离（quarantine）真实消费：assemble/install/launch 产物排除被隔离插件；
- 路径安全：CLI id 白名单 + 14 向量穿越矩阵全拒 + harness 完整性校验；
- 只读命令（check/status/logs）零副作用；state 唯一状态源（损坏禁覆盖）；
- win32 `.cmd/.bat` harness 经 `cmd.exe /d /c` 包装（ComSpec；特殊字符显式拒绝）。

## 已知边界（诚实清单）

- `install` 的 github 源为 `git clone` + 镜像重试；npm 源需网络可用；
- win32 仍以 `DSH_PROFILE` 环境变量单通道传递 profile（非 win32 额外传 `--profile`），
  双通道决策需真实 DSH 冒烟实证；
- CRASH_LOOP 自愈的验证 = 补救动作已应用 + 崩溃计数重置（重启存活验证由下一次
  launch 完成）；
- harness 为路径信任校验（非白名单路径拒绝执行），正式版建议数字签名/哈希白名单；
- runlog 滚动保留 1 个 `.1` 文件。
