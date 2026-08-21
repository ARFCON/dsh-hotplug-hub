'use strict';
// test/runlog.test.js — JSONL 日志（seq 恢复 / 坏尾截断 / 滚动续号 / M-13 锁内 seq）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { createRunLog, nextRunSeq, readLastSeq } = require('../fs/runlog');

const nodeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  appendFileSync: fs.appendFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  readSync: fs.readSync.bind(fs),
  ftruncateSync: fs.ftruncateSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  rmSync: fs.rmSync.bind(fs)
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shared-runlog-'));
}

describe('createRunLog', () => {
  it('追加与读取（seq 递增）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    const log = createRunLog(nodeFs, file, {});
    const a = log.append({ stream: 'stdout', line: 'hello' });
    expect(a.ok).toBe(true);
    expect(a.seq).toBe(1);
    expect(log.append({ stream: 'stderr', line: 'warn' }).seq).toBe(2);
    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].line).toBe('hello');
  });

  it('新进程从文件恢复 seq（不重复）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    createRunLog(nodeFs, file, {}).append({ stream: 'stdout', line: 'a' });
    createRunLog(nodeFs, file, {}).append({ stream: 'stdout', line: 'b' });
    const log3 = createRunLog(nodeFs, file, {});
    expect(log3.append({ line: 'c' }).seq).toBe(3);
  });

  it('坏尾截断后从断点续写', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    createRunLog(nodeFs, file, {}).append({ line: 'a' });
    fs.appendFileSync(file, '{"seq":2,"t":"x","stream":"stdout","line":"partial');
    const log = createRunLog(nodeFs, file, {});
    expect(log.append({ line: 'b' }).seq).toBe(2);
    // 坏尾已被截断
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('partial');
  });

  it('滚动后新文件续取 .1 末行 seq', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    const log = createRunLog(nodeFs, file, { maxBytes: 50 });
    log.append({ line: 'x'.repeat(100) }); // 触发滚动
    expect(log.append({ line: 'y' }).seq).toBe(2);
    const entries = log.list({ includeRotated: true });
    expect(entries.length).toBe(2);
  });

  it('读取失败返回 [] 不抛异常（FIX-22）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    fs.writeFileSync(file, 'not-json\n{"seq":1,"t":"t","stream":"stdout","line":"ok"}');
    const log = createRunLog(nodeFs, file, {});
    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].line).toBe('ok');
  });

  it('写失败 → ERR_LOG_WRITE（exit=11 域）', () => {
    const dir = tempDir();
    const badFs = { ...nodeFs, appendFileSync: () => { throw new Error('EACCES'); } };
    const log = createRunLog(badFs, path.join(dir, 'run.jsonl'), {});
    const r = log.append({ line: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOG_WRITE');
    expect(r.error.exitCode).toBe(11);
  });
});

describe('M-13：锁内 seq（nextRunSeq / 跨进程全局唯一）', () => {
  const childFixture = path.join(__dirname, 'fixtures', 'runlog-child.cjs');

  it('nextRunSeq 在锁内返回下一 seq（不写盘）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    createRunLog(nodeFs, file, {}).append({ line: 'a' });
    createRunLog(nodeFs, file, {}).append({ line: 'b' });
    const r = nextRunSeq(nodeFs, file);
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(3);
    // 不产生写入（文件仍 2 行）
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('readLastSeq 只读恢复', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    createRunLog(nodeFs, file, {}).append({ line: 'a' });
    expect(readLastSeq(nodeFs, file)).toBe(1);
    expect(readLastSeq(nodeFs, path.join(dir, 'missing.jsonl'))).toBe(0);
  });

  it('M-28：append 写前 schema 校验（非法 stream 拒绝且不落盘，ERR_LOG_WRITE）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    const log = createRunLog(nodeFs, file, {});
    const bad = log.append({ stream: 'not-a-stream', line: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('ERR_LOG_WRITE');
    expect(bad.error.message).toContain('不符合 schema');
    // 文件不存在/为空：未写入任何坏行
    expect(fs.existsSync(file)).toBe(false);
    // 合法行不受影响
    const good = log.append({ stream: 'stderr', line: 'ok' });
    expect(good.ok).toBe(true);
    expect(log.list()).toHaveLength(1);
  });

  it('多进程并发 append：seq 全局唯一（M-13 实证）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'run.jsonl');
    // 4 个子进程各追加 3 条 → seq 必须 1..12 无重复
    const children = [];
    for (let i = 0; i < 4; i += 1) {
      children.push(spawnSync(process.execPath, [childFixture, file, '3'], { encoding: 'utf8', timeout: 30000 }));
    }
    for (const c of children) expect(c.status).toBe(0);
    const text = fs.readFileSync(file, 'utf8');
    const seqs = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).seq).sort((a, b) => a - b);
    expect(seqs).toHaveLength(12);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});
