'use strict';
// test/runlog.test.js — runlog 跨进程 seq 恢复（QA Bug #2）+ 5MB 滚动
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunLog } = require('../infra/runlog');
const { createFsPort } = require('../ports/fs');

const fsPort = createFsPort(fs);

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-log-'));
  return path.join(dir, 'run.jsonl');
}

describe('infra/runlog（QA Bug #2 回归）', () => {
  it('跨进程重建 logger 后 seq 继续递增（不重复）', () => {
    const logFile = tmpLog();
    const loggerA = createRunLog(fsPort, logFile, { now: () => 1000 });
    expect(loggerA.append({ stream: 'stdout', line: 'one' }).seq).toBe(1);
    expect(loggerA.append({ stream: 'stdout', line: 'two' }).seq).toBe(2);
    // 重建 logger（模拟新进程：loadSeq 从末行恢复）
    const loggerB = createRunLog(fsPort, logFile, { now: () => 2000 });
    const r = loggerB.append({ stream: 'stdout', line: 'three' });
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(3); // 期望 3，而非从 1 重来
    const entries = loggerB.list();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[2].t).toBe(new Date(2000).toISOString());
  });

  it('文件不存在时从 seq=1 开始', () => {
    const logger = createRunLog(fsPort, tmpLog(), { now: () => 1000 });
    expect(logger.append({ stream: 'stderr', line: 'first' }).seq).toBe(1);
  });

  it('5MB（可配置）滚动触发 rotate，旧行进 .1（N46）', () => {
    const logFile = tmpLog();
    const logger = createRunLog(fsPort, logFile, { now: () => 1000, maxBytes: 200 });
    for (let i = 0; i < 10; i += 1) {
      logger.append({ stream: 'stdout', line: 'x'.repeat(80) });
    }
    expect(fs.existsSync(logFile + '.1')).toBe(true);
    const entries = logger.list();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(10); // 部分旧行已滚入 .1
  });

  it('坏行跳过、seq 字段缺失时从 0 恢复', () => {
    const logFile = tmpLog();
    fs.writeFileSync(logFile, 'not-json\n{"seq":7,"t":"x","stream":"stdout","line":"ok"}\n', 'utf8');
    const logger = createRunLog(fsPort, logFile, { now: () => 1000 });
    const r = logger.append({ stream: 'stdout', line: 'next' });
    expect(r.seq).toBe(8);
    expect(logger.list()).toHaveLength(2); // 坏行被跳过
  });
});
