'use strict';
// test/audit-r5-readonly-B.test.js — 只读自检 + 状态持久化/锁/快照/日志/同步 深度审计（R5，B 部分）
//
// 独立审计（不信任既有结论），逐条读源码 + 亲跑验证。本文件只钉死【新发现、当前
// 仍失败】的真实缺陷，不修复源码、不改既有测试。每个缺陷标注：
//   [缺陷] —— 测试失败，证明真实缺陷（行为违反契约/越界/幂等/数据完整性）
//
// 缺陷清单（详见文件末尾缺陷说明）：
//   B1  restoreSnapshot 无根域 realpath 越界防护：junction/symlink 逃逸，删除根域外文件
//       （与 cleanupResidue 的 opts.root、syncProfile 的 assertWithinRealpath 不对称）
//   B2  restoreSnapshot 成功后清理 externalDir，同一快照二次回滚失败（幂等回滚被破坏）
//   B3  runlog append 对「完整 JSON 行但缺末尾换行」的坏尾 off-by-one：不截断不补换行，
//       append 直接拼接 → list() 丢弃两条记录（数据丢失）
const fs = require('fs');
const path = require('path');
const { createSnapshot, restoreSnapshot, cleanupResidue } = require('../infra/snapshot');
const { createRunLog } = require('../infra/runlog');
const { createFsPort } = require('../ports/fs');
const { tempDir } = require('./helpers');

const fsPort = createFsPort(fs);

// =====================================================================
// B1：restoreSnapshot 根域越界防护缺失（junction/symlink 逃逸）
// =====================================================================
describe('R5-B1 restoreSnapshot 根域越界防护', () => {
  it('[缺陷 B1] junction 目标逃逸：restoreSnapshot 在根域外删除「新增」文件（cleanupResidue 有 opts.root 防护、restoreSnapshot 无）', () => {
    const root = tempDir('r5b1-root-');
    const outside = tempDir('r5b1-out-');
    const profilesRoot = path.join(root, 'profiles');
    fs.mkdirSync(profilesRoot, { recursive: true });
    const linkDir = path.join(profilesRoot, 'demo');

    // 预置 junction/symlink 逃逸（Windows junction 优先，POSIX dir symlink 回退）
    let linked = false;
    try { fs.symlinkSync(outside, linkDir, 'junction'); linked = true; }
    catch (_) {
      try { fs.symlinkSync(outside, linkDir, 'dir'); linked = true; } catch (_) { /* 环境不支持则跳过 */ }
    }
    if (!linked) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    // 快照内容落在 outside（经 junction 进入快照）
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'KEEP');
    const snap = createSnapshot(fsPort, linkDir);
    expect(snap.ok).toBe(true);
    // 根域外的「新增」文件（不在快照清单内）——回滚删除新增时绝不应触碰
    fs.writeFileSync(path.join(outside, 'extra.txt'), 'EXTRA');

    const r = restoreSnapshot(fsPort, snap.snapshot, linkDir, { stamp: 'esc', root: profilesRoot });
    // 契约（对齐 cleanupResidue 的 opts.root / syncProfile 的 assertWithinRealpath）：
    // 根域外的 junction/symlink 目标必须被拒绝（ok:false），且绝不触碰根域外文件。
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'extra.txt'))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

// =====================================================================
// B2：restoreSnapshot 成功后清理 externalDir → 快照不可二次回滚
// =====================================================================
describe('R5-B2 restoreSnapshot 幂等回滚', () => {
  it('[缺陷 B2] 二进制（external）快照首次回滚成功后被销毁 externalDir，同一快照二次回滚失败', () => {
    const dir = path.join(tempDir('r5b2-'), 'prof');
    fs.mkdirSync(dir, { recursive: true });
    // 非法 UTF-8 二进制（< 1MB）→ createSnapshot 走 external 字节级备份
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));

    const snap = createSnapshot(fsPort, dir);
    expect(snap.ok).toBe(true);
    expect(snap.snapshot.files.some((f) => f.external)).toBe(true);

    const r1 = restoreSnapshot(fsPort, snap.snapshot, dir, { stamp: 't1' });
    expect(r1.ok).toBe(true);
    // externalDir 在首次回滚成功后被清理（快照内容已还原，不再需要备份副本）
    expect(fs.existsSync(snap.snapshot.externalDir)).toBe(false);

    // 同一快照仍被 state.rollback.snapshot 持有，且状态机允许 rollback 从 ROLLED_BACK
    // 幂等重入（assertCommandPipeline(ROLLED_BACK, 'rollback') === ok）→ 二次回滚应成功。
    // 当前实现 FAIL：external 备份已缺失（ERR_HEAL_ROLLBACK "external 备份缺失"）。
    const r2 = restoreSnapshot(fsPort, snap.snapshot, dir, { stamp: 't2' });
    expect(r2.ok).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
    if (snap.snapshot.externalDir) fs.rmSync(snap.snapshot.externalDir, { recursive: true, force: true });
  });
});

// =====================================================================
// B3：runlog 坏尾截断 off-by-one（完整 JSON 行缺末尾换行）
// =====================================================================
describe('R5-B3 runlog 坏尾截断', () => {
  it('[缺陷 B3] 末尾为完整 JSON 行但缺换行 → append 直接拼接，list() 丢弃两条记录（数据丢失）', () => {
    const logFile = path.join(tempDir('r5b3-'), 'run.jsonl');
    // 完整合法 JSON 行，但【无末尾换行】（崩溃/外部写入的坏尾形态之一）
    fs.writeFileSync(logFile, '{"seq":5,"t":"x","stream":"stdout","line":"ok"}', 'utf8');

    const logger = createRunLog(fsPort, logFile, { now: () => 1000 });
    const r = logger.append({ stream: 'stdout', line: 'after' });
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(6); // seq 恢复正确

    // 期望：append 在坏尾处补换行/截断，list() 可读回两条 [5, 6]。
    // 当前实现 FAIL：keepEnd=size+1（off-by-one）导致不截断不补换行，append 直接拼接，
    // 落盘为 {"seq":5,...}{"seq":6,...}\n（单行两个 JSON），list() 解析失败 → []。
    expect(logger.list().map((e) => e.seq)).toEqual([5, 6]);

    fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
  });
});

// =====================================================================
// 缺陷说明（file:line 根因 + 修复方向）
// =====================================================================
// B1  packages/shared-core/fs/snapshot.js:restoreSnapshot（约 L83-L173）
//     根因：restoreSnapshot 无独立根域参数（cleanupResidue 有 opts.root 并走
//     assertWithinRealpath(fsPort, opts.root, dir)），仅在第 3 步对每个文件做
//     assertWithinRealpath(fsPort, dir, lexical)——当 dir 本身是 junction/symlink 时，
//     root(=dir) 与 target 同侧解析到根域外，越界判定被架空。launcher/app/stages.js:
//     stageRollback（约 L244）直接用 path.join(profilesRoot, id) 的【词法路径】调用
//     restoreSnapshot，未做 syncProfile 那样的 assertWithinRealpath(fsPort, profilesRoot,
//     profileDir)（launcher/infra/profile.js L64）。
//     修复方向：restoreSnapshot 增加 opts.root 参数并对 dir 做
//     assertWithinRealpath(fsPort, opts.root, dir)；stageRollback 传 root=profilesRoot。
//
// B2  packages/shared-core/fs/snapshot.js:restoreSnapshot 第 6 步（约 L165-L168）
//     根因：回滚成功后 rmSync(snapshot.externalDir)，但快照对象仍被
//     state.rollback.snapshot 持有（launcher/app/stages.js:stageRollback 不清空 snapshot），
//     且状态机允许 rollback 从 ROLLED_BACK 幂等重入 → 二次回滚在预验证阶段报
//     "external 备份缺失"。外部文件快照非幂等。
//     修复方向：要么回滚成功后清空 state.rollback.snapshot（使二次回滚报"无可用快照"，
//     而非静默破坏），要么 externalDir 延后/标记为已消费并允许幂等重建（external 内容
//     已还原到目标，可据此重建快照或直接判等通过）。
//
// B3  packages/shared-core/fs/runlog.js:scanForLastValidLine（约 L29-L59）
//     根因：末行是完整 JSON 但无末尾换行时，keepEnd = baseOffset + lineStart + 1 =
//     stat.size + 1（lineStart = buf.length），loadSeqFromFile 的 truncated 判定
//     (keepEnd < stat.size) 为 false → 既不截断也不补换行；append 用 appendFileSync
//     直接追加，与上一行拼接成单行两个 JSON，list() JSON.parse 失败丢弃整行。
//     修复方向：当 keepEnd > stat.size（行终止换行缺失）时，append 前先补写换行，
//     或 truncateBadTail/append 保证文件尾必以 \n 结束再追加。
