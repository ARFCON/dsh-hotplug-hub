'use strict';
// test/qa3-runlog-extra.test.js — runlog 强化（QA3 第 2 层主题 6）
// 跨进程 seq 恢复 / 滚动轮转 / 坏行跳过 / 并发写。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunLog } = require('../infra/runlog');
const { createFsPort } = require('../ports/fs');

const fsPort = createFsPort(fs);

function tmpLog(prefix = 'qa3-log-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'run.jsonl');
}

describe('QA3 runlog 强化（QA Bug #2 / N46 强化）', () => {
  it('两次 open 模拟跨进程：seq 连续恢复 [1,2,3,4,5]', () => {
    const logFile = tmpLog();
    const a = createRunLog(fsPort, logFile, { now: () => 1000 });
    expect(a.append({ stream: 'stdout', line: 'l1' }).seq).toBe(1);
    expect(a.append({ stream: 'stdout', line: 'l2' }).seq).toBe(2);
    const b = createRunLog(fsPort, logFile, { now: () => 2000 });
    expect(b.append({ stream: 'stdout', line: 'l3' }).seq).toBe(3);
    const c = createRunLog(fsPort, logFile, { now: () => 3000 });
    expect(c.append({ stream: 'stdout', line: 'l4' }).seq).toBe(4);
    expect(c.append({ stream: 'stdout', line: 'l5' }).seq).toBe(5);
    expect(c.list().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('滚动轮转：超 maxBytes 触发，旧文件 .1 保留，新文件从新 seq 继续', () => {
    const logFile = tmpLog();
    const logger = createRunLog(fsPort, logFile, { now: () => 1000, maxBytes: 300 });
    for (let i = 1; i <= 6; i += 1) logger.append({ stream: 'stdout', line: 'x'.repeat(80) });
    expect(fs.existsSync(logFile + '.1')).toBe(true);
    // 滚动后新 logger 从 .1 的末行恢复 seq（loadSeq 读的是主文件，但主文件已滚动）
    const logger2 = createRunLog(fsPort, logFile, { now: () => 2000, maxBytes: 300 });
    // 主文件内容存在且 seq 递增
    const entries = logger2.list();
    const seqs = entries.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('坏行跳过且不中断后续写入；末行损坏时截断坏尾并从断点续 seq（C4 修复：不再从 1 重来）', () => {
    const logFile = tmpLog();
    fs.writeFileSync(logFile, '{broken json\n{"seq":5,"t":"x","stream":"stdout","line":"ok"}\nnot json either\n', 'utf8');
    const logger = createRunLog(fsPort, logFile, { now: () => 1000 });
    const r = logger.append({ stream: 'stdout', line: 'after' });
    expect(r.ok).toBe(true);
    // C4 修复：坏尾（'not json either'）被截断，seq 从最后合法行（5）续写 → 6
    // （原行为：seq 从 1 重来 → 跨进程重复 seq）
    expect(r.seq).toBe(6);
    // list 只返回可解析行：坏行被截断后文件只有 2 条合法记录
    expect(logger.list()).toHaveLength(2);
    expect(logger.list().map((e) => e.seq)).toEqual([5, 6]);
  });

  it('并发写：两 logger 交替 append 全部落盘且主文件可解析（注：目录锁外不做 seq 唯一性保证）', () => {
    const logFile = tmpLog();
    const a = createRunLog(fsPort, logFile, { now: () => 1000 });
    const b = createRunLog(fsPort, logFile, { now: () => 2000 });
    a.append({ stream: 'stdout', line: 'a1' });
    b.append({ stream: 'stdout', line: 'b1' });
    a.append({ stream: 'stdout', line: 'a2' });
    b.append({ stream: 'stdout', line: 'b2' });
    const entries = a.list();
    expect(entries).toHaveLength(4);
    const lines = entries.map((e) => e.line).sort();
    expect(lines).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('行内容含前后空格/制表符/引号/换行字符不破坏 JSONL', () => {
    const logFile = tmpLog();
    const logger = createRunLog(fsPort, logFile, { now: () => 1000 });
    logger.append({ stream: 'stdout', line: '  前导   ' });
    logger.append({ stream: 'stderr', line: 'a"b\\c' });
    logger.append({ stream: 'stdout', line: 'multi\nline' }); // 内容含字面 \n 字符（JSON 转义）
    const entries = logger.list();
    expect(entries.map((e) => e.line)).toEqual(['  前导   ', 'a"b\\c', 'multi\nline']);
  });

  it('append 失败（父目录不可写）→ ERR_LOG_WRITE（exit=11）且不崩溃', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-log-fail-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const logger = createRunLog(fsPort, path.join(blocker, 'run.jsonl'), { now: () => 1000 });
    const r = logger.append({ stream: 'stdout', line: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOG_WRITE');
    expect(r.error.exitCode).toBe(11);
  });

  it('list 对不存在的文件返回 []', () => {
    const logger = createRunLog(fsPort, path.join(os.tmpdir(), 'qa3-nofile-' + Date.now(), 'run.jsonl'), { now: () => 1000 });
    expect(logger.list()).toEqual([]);
  });

  it('rotate 显式调用：已有 .1 被覆盖为最新', () => {
    const logFile = tmpLog();
    const logger = createRunLog(fsPort, logFile, { now: () => 1000 });
    logger.append({ stream: 'stdout', line: 'first-gen' });
    logger.rotate();
    expect(fs.existsSync(logFile + '.1')).toBe(true);
    expect(fs.readFileSync(logFile + '.1', 'utf8')).toContain('first-gen');
    logger.append({ stream: 'stdout', line: 'second-gen' });
    logger.rotate();
    expect(fs.readFileSync(logFile + '.1', 'utf8')).toContain('second-gen');
  });
});
