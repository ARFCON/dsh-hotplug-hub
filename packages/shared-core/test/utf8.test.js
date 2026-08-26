'use strict';
// test/utf8.test.js — 严格 UTF-8 校验：权威实现（node:buffer.isUtf8）与手写回退
// （isValidUtf8Manual）大语料一致性 + 边界向量（根治「二进制误内联 → 回滚数据丢失」）。
const { isUtf8: nodeIsUtf8 } = require('node:buffer');
const { isValidUtf8, isValidUtf8Manual } = require('../fs/utf8');

/** 单字节 → Buffer。 */
function buf(...bytes) {
  return Buffer.from(bytes);
}

describe('isValidUtf8 权威 vs 手写（大语料一致）', () => {
  it('合法边界码点全部通过（U+0000…U+10FFFF 各边界）', () => {
    const validStrs = [
      '\u0000', // NUL（1 字节）
      '\u007f', // 1 字节上界
      '\u0080', // 2 字节下界
      '\u07ff', // 2 字节上界
      '\u0800', // 3 字节下界
      '\ud7ff', // 代理区前
      '\ue000', // 代理区后
      '\uffff', // 3 字节上界
      '\u{10000}', // 4 字节下界
      '\u{10ffff}', // Unicode 上界
      '中文 🐱 a1-_', // 混合
    ];
    for (const s of validStrs) {
      const b = Buffer.from(s, 'utf8');
      expect(isValidUtf8(b), JSON.stringify(s)).toBe(true);
      expect(isValidUtf8Manual(b), JSON.stringify(s)).toBe(true);
      expect(nodeIsUtf8(b), JSON.stringify(s)).toBe(true);
    }
  });

  it('非法字节序列（过长/代理/超范围/残缺/坏续字节）权威与手写同判 false', () => {
    const invalid = [
      [0xc0, 0x80], // 过长 2 字节（NUL）
      [0xc1, 0xbf], // 过长 2 字节
      [0xe0, 0x80, 0x80], // 过长 3 字节
      [0xe0, 0x9f, 0xbf], // 过长 3 字节上界
      [0xed, 0xa0, 0x80], // 代理区（U+D800）
      [0xed, 0xbf, 0xbf], // 代理区上界（U+DFFF）
      [0xf0, 0x80, 0x80, 0x80], // 过长 4 字节
      [0xf0, 0x8f, 0xbf, 0xbf], // 过长 4 字节上界
      [0xf4, 0x90, 0x80, 0x80], // 超 U+10FFFF
      [0xf5, 0x80, 0x80, 0x80], // 前导字节超范围
      [0xff], // 非法前导
      [0x80], // 孤立续字节
      [0xbf], // 孤立续字节
      [0xc2], // 2 字节残缺
      [0xe4, 0xb8], // 3 字节残缺
      [0xe4, 0x28, 0xa1], // 坏续字节（次字节非 0x80-0xBF）
      [0xf0, 0x9f, 0x98], // 4 字节残缺
      [0xf0, 0x9f, 0x28, 0x80], // 坏续字节
    ];
    for (const bytes of invalid) {
      const b = buf(...bytes);
      expect(isValidUtf8(b), JSON.stringify(bytes)).toBe(false);
      expect(isValidUtf8Manual(b), JSON.stringify(bytes)).toBe(false);
      expect(nodeIsUtf8(b), JSON.stringify(bytes)).toBe(false);
    }
  });

  it('全 256 种单字节：手写与权威同判', () => {
    for (let n = 0; n < 256; n += 1) {
      const b = Buffer.from([n]);
      expect(isValidUtf8Manual(b), `byte 0x${n.toString(16)}`).toBe(nodeIsUtf8(b));
    }
  });

  it('2/3/4 字节全前导 × 续字节边界：手写与权威同判', () => {
    const leads2 = [0xc0, 0xc1, 0xc2, 0xdf];
    const leads3 = [0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef];
    const leads4 = [0xf0, 0xf1, 0xf3, 0xf4];
    const conts = [0x00, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0];
    for (const l of leads2) {
      for (const c of conts) {
        const b = Buffer.from([l, c]);
        expect(isValidUtf8Manual(b), `[${l},${c}]`).toBe(nodeIsUtf8(b));
      }
    }
    for (const l of leads3) {
      for (const c1 of conts) {
        for (const c2 of [0x80, 0xbf, 0xc0]) {
          const b = Buffer.from([l, c1, c2]);
          expect(isValidUtf8Manual(b), `[${l},${c1},${c2}]`).toBe(nodeIsUtf8(b));
        }
      }
    }
    for (const l of leads4) {
      for (const c1 of [0x80, 0x8f, 0x90, 0xbf]) {
        const b = Buffer.from([l, c1, 0x80, 0x80]);
        expect(isValidUtf8Manual(b), `[${l},${c1},0x80,0x80]`).toBe(nodeIsUtf8(b));
      }
    }
  });

  it('随机缓冲区模糊：手写与权威逐字节同判（确定性种子）', () => {
    // 简单确定性 PRNG（避免引入外部依赖，保证可复现）
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < 500; n += 1) {
      const len = rand() % 12;
      const bytes = [];
      for (let i = 0; i < len; i += 1) bytes.push(rand() & 0xff);
      const b = Buffer.from(bytes);
      const expected = nodeIsUtf8(b);
      expect(isValidUtf8Manual(b), JSON.stringify(bytes)).toBe(expected);
      expect(isValidUtf8(b), JSON.stringify(bytes)).toBe(expected);
    }
  });

  it('空 buffer 与纯 ASCII buffer 通过', () => {
    expect(isValidUtf8(Buffer.alloc(0))).toBe(true);
    expect(isValidUtf8Manual(Buffer.alloc(0))).toBe(true);
    expect(isValidUtf8(Buffer.from('hello world 123'))).toBe(true);
    expect(isValidUtf8Manual(Buffer.from('hello world 123'))).toBe(true);
  });
});
