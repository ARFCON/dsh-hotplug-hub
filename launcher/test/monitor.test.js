'use strict';
// test/monitor.test.js — UTF-8 分块拼接（N36 回归）+ CRLF + 按行 JSONL
const { createLineDecoder } = require('../infra/monitor');

describe('infra/monitor UTF-8 分块解码（N36 回归）', () => {
  it('多字节字符被逐字节切断不产生 U+FFFD', () => {
    const dec = createLineDecoder();
    const full = '中文日志行内容 mixed with ascii';
    const buf = Buffer.from(full + '\n', 'utf8');
    const lines = [];
    for (let i = 0; i < buf.length; i += 1) {
      lines.push(...dec.push(buf.subarray(i, i + 1)));
    }
    expect(lines).toEqual([full]);
    expect(lines[0].includes('\uFFFD')).toBe(false);
  });

  it('任意分块大小均能还原', () => {
    const dec = createLineDecoder();
    const full = 'a'.repeat(100) + '中' + 'b'.repeat(100);
    const buf = Buffer.from(full + '\n', 'utf8');
    const lines = [];
    for (let i = 0; i < buf.length; i += 7) {
      lines.push(...dec.push(buf.subarray(i, i + 7)));
    }
    expect(lines).toEqual([full]);
  });

  it('CRLF 行尾剥除（Windows 特判）', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from('first\r\nsecond\r\n', 'utf8'));
    expect(lines).toEqual(['first', 'second']);
  });

  it('多行块按行拆分，半行保留到 flush', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from('l1\nl2\nl3', 'utf8'));
    expect(lines).toEqual(['l1', 'l2']);
    expect(dec.hasPending()).toBe(true);
    expect(dec.flush()).toEqual(['l3']);
    expect(dec.hasPending()).toBe(false);
  });

  it('空输入安全', () => {
    const dec = createLineDecoder();
    expect(dec.push(Buffer.alloc(0))).toEqual([]);
    expect(dec.flush()).toEqual([]);
  });
});
