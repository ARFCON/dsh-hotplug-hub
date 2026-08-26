'use strict';
// scripts/qa3-fs-fault-injection.js — 文件系统故障注入（QA3 第 3 层主题 13）
// 通过 createCore 注入包装 fs 端口模拟 EACCES/ENOSPC/EBUSY/ENOENT，
// 验证每层错误被正确分类且不崩溃。
// 用法：node scripts/qa3-fs-fault-injection.js
// 退出码：0=全部通过；1=存在失败项（打印明细）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createFsPort } = require('../ports/fs');
const { writeFileAtomic } = require('../infra/atomic');
const { writeState } = require('../infra/store');
const { createRunLog } = require('../infra/runlog');
const { createSnapshot, restoreSnapshot, cleanupResidue } = require('../infra/snapshot');
const { acquireLock } = require('../infra/lock');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; failures.push({ name, detail }); console.log(`  FAIL ${name}: ${detail}`); }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 构造"在指定方法上抛指定错误码"的包装 fs 端口
function fsWithError(method, errCode) {
  const base = createFsPort(fs);
  return {
    ...base,
    [method]: (...args) => {
      const e = new Error(`${errCode}: injected on ${method}`);
      e.code = errCode;
      throw e;
    }
  };
}

console.log('== QA3 文件系统故障注入 ==');

// 1) 原子写 EACCES：原文件完好、tmp 清理、错误码 ERR_INSTALL_FAILED
{
  const dir = tmpDir('qa3-fi-atomic-');
  const file = path.join(dir, 'data.txt');
  fs.writeFileSync(file, 'ORIGINAL');
  const badFs = fsWithError('renameSync', 'EACCES');
  const r = writeFileAtomic(badFs, file, 'NEW', { errorCode: 'ERR_INSTALL_FAILED' });
  check('atomic EACCES → ERR_INSTALL_FAILED', r.ok === false && r.error.code === 'ERR_INSTALL_FAILED', JSON.stringify(r));
  check('atomic EACCES 原文件完好', fs.readFileSync(file, 'utf8') === 'ORIGINAL');
  check('atomic EACCES tmp 清理', fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length === 0);
}

// 2) 原子写 EBUSY（rename 被占用）：失败不崩溃、错误码正确
{
  const dir = tmpDir('qa3-fi-ebusy-');
  const file = path.join(dir, 'data.txt');
  fs.writeFileSync(file, 'ORIGINAL');
  const badFs = fsWithError('renameSync', 'EBUSY');
  const r = writeFileAtomic(badFs, file, 'NEW', { errorCode: 'ERR_LOCK_ACQUIRE' });
  check('atomic EBUSY → ERR_LOCK_ACQUIRE（调用方语义码）', r.ok === false && r.error.code === 'ERR_LOCK_ACQUIRE', JSON.stringify(r));
  check('atomic EBUSY 原文件完好', fs.readFileSync(file, 'utf8') === 'ORIGINAL');
}

// 3) store.writeState ENOSPC → ERR_STATE_WRITE（exit=10，P3-8 语义纠正）
{
  const dir = tmpDir('qa3-fi-store-');
  const badFs = fsWithError('renameSync', 'ENOSPC');
  const r = writeState(badFs, path.join(dir, 'state.json'), { schemaVersion: 1 });
  check('store ENOSPC → ERR_STATE_WRITE', r.ok === false && r.error.code === 'ERR_STATE_WRITE', JSON.stringify(r));
  check('store ENOSPC exit=10', r.ok === false && r.error.exitCode === 10);
}

// 4) runlog append ENOSPC → ERR_LOG_WRITE（exit=11）
{
  const dir = tmpDir('qa3-fi-log-');
  const badFs = fsWithError('appendFileSync', 'ENOSPC');
  const logger = createRunLog(badFs, path.join(dir, 'run.jsonl'), { now: () => 1000 });
  const r = logger.append({ stream: 'stdout', line: 'x' });
  check('runlog ENOSPC → ERR_LOG_WRITE', r.ok === false && r.error.code === 'ERR_LOG_WRITE', JSON.stringify(r));
  check('runlog ENOSPC exit=11', r.ok === false && r.error.exitCode === 11);
}

// 5) snapshot create EACCES → ERR_HEAL_ROLLBACK
{
  const dir = tmpDir('qa3-fi-snap-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  const badFs = fsWithError('readFileSync', 'EACCES');
  const r = createSnapshot(badFs, dir);
  check('snapshot EACCES → ERR_HEAL_ROLLBACK', r.ok === false && r.error.code === 'ERR_HEAL_ROLLBACK', JSON.stringify(r));
}

// 6) snapshot restore ENOENT（目标文件读取失败）→ ERR_HEAL_ROLLBACK
{
  const dir = tmpDir('qa3-fi-restore-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  const good = createFsPort(fs);
  const snap = createSnapshot(good, dir);
  const badFs = fsWithError('writeFileSync', 'ENOENT');
  const r = restoreSnapshot(badFs, snap.snapshot, dir);
  check('restore ENOENT → ERR_HEAL_ROLLBACK', r.ok === false && r.error.code === 'ERR_HEAL_ROLLBACK', JSON.stringify(r));
}

// 7) cleanupResidue 在 fs 读失败时返回 ok（collectAll 容错，不崩溃）
{
  const dir = tmpDir('qa3-fi-clean-');
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
  const badFs = fsWithError('readdirSync', 'EACCES');
  const r = cleanupResidue(badFs, dir, { keep: [] });
  check('cleanup EACCES 不崩溃且返回 ok（collectAll 容错语义）', Boolean(r) && r.ok === true, JSON.stringify(r));
}

// 8) lock acquire EACCES（mkdir 抛错）→ ERR_LOCK_ACQUIRE
{
  const dir = tmpDir('qa3-fi-lock-');
  const badFs = fsWithError('mkdirSync', 'EACCES');
  const r = acquireLock(badFs, path.join(dir, '.lock'), { waitMs: 50, staleMs: 1000, now: () => Date.now() });
  check('lock EACCES → ERR_LOCK_ACQUIRE', r.ok === false && r.error.code === 'ERR_LOCK_ACQUIRE', JSON.stringify(r));
}

// 9) pipeline 级故障注入：assemble 写产物失败 → 返回错误不崩溃
(async () => {
  const base = tmpDir('qa3-fi-pipeline-');
  const roots = {
    assemblyDir: path.join(base, 'assembly'),
    sandboxRoot: path.join(base, 'sandbox', '.sandbox'),
    profilesRoot: path.join(base, 'profiles'),
    storeRoot: path.join(base, 'store')
  };
  const id = 'fi-demo';
  fs.mkdirSync(path.join(roots.assemblyDir, id), { recursive: true });
  fs.writeFileSync(path.join(roots.assemblyDir, id, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: '故障', version: '1.0.0',
    plugins: [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
  }));
  // 注入：rename 到 sandbox package.json 时 EACCES（writeFileAtomic 的 rename 阶段失败 → ERR_INSTALL_FAILED）
  const badFs = {
    ...createFsPort(fs),
    renameSync: (src, dest, ...rest) => {
      if (String(dest).includes('sandbox') && String(dest).endsWith('package.json')) {
        const e = new Error('EACCES: injected rename');
        e.code = 'EACCES';
        throw e;
      }
      return fs.renameSync(src, dest, ...rest);
    }
  };
  const core = createCore({ roots, fsPort: badFs, home: base });
  const { runPipeline } = require('../app/pipeline');
  const r = await runPipeline(core, 'assemble', { id, yes: false, wait: false, timeoutMs: 1000, tail: 50 });
  check('pipeline assemble 写失败 → 返回错误（ERR_INSTALL_FAILED 域）', r.ok === false && (r.code.startsWith('ERR_INSTALL_') || r.code.startsWith('ERR_LOCK_')), JSON.stringify({ code: r.code, exitCode: r.exitCode }));
  // A2 修复：删除恒真 `|| true`——state 不得被写坏：不存在，或可解析且 phase 未被推进
  const stateFile = path.join(roots.storeRoot, id, 'state.json');
  let stateOk = true;
  let stateDetail = 'state.json 不存在';
  if (fs.existsSync(stateFile)) {
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      stateOk = st.schemaVersion === 1 && (st.phase === undefined || st.phase === 'IDLE');
      stateDetail = `phase=${st.phase}`;
    } catch (e) {
      stateOk = false;
      stateDetail = `state.json 损坏：${e.message}`;
    }
  }
  check('pipeline assemble 写失败 state 未被写坏', stateOk, stateDetail);
})()
  .then(() => {
    console.log(`\n== 结果：PASS=${pass} FAIL=${fail} ==`);
    if (fail > 0) {
      console.log('失败明细：');
      for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('脚本异常：', e);
    process.exit(2);
  });
