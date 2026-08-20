'use strict';
// test/qa3-monitor-utf8.test.js — monitor UTF-8 穷尽（QA3 第 2 层主题 5）
// 中文跨 2/3/4 字节边界切分 / emoji / 组合字符 / BOM / 残缺 / 多行 / CRLF / 空白保留。
const { createLineDecoder } = require('../infra/monitor');

describe('QA3 monitor UTF-8 穷尽（审计 N36/M/X22 强化）', () => {
  const CASES = [
    { name: '中文（3 字节）', text: '中文日志行' },
    { name: '中文+ASCII 混合', text: 'abc中文def' },
    { name: 'emoji（4 字节）', text: '🎉🚀💯' },
    { name: '组合字符（NFC/NFD）', text: 'e\u0301n\u0301' }, // é = e + combining acute
    { name: '全角标点', text: '，。！？' },
    { name: '韩文/日文', text: '한국어日本語' }
  ];

  for (const { name, text } of CASES) {
    it(`任意 chunk 大小 1-10 字节切分还原：${name}`, () => {
      const buf = Buffer.from(text + '\n', 'utf8');
      for (let size = 1; size <= 10; size += 1) {
        const dec = createLineDecoder();
        const lines = [];
        for (let i = 0; i < buf.length; i += size) {
          lines.push(...dec.push(buf.subarray(i, i + size)));
        }
        expect(lines, `chunk=${size}`).toEqual([text]);
        expect(lines[0].includes('\uFFFD'), `chunk=${size} 无 U+FFFD`).toBe(false);
      }
    });
  }

  it('单 chunk 含多行：完整拆分行且保留空行', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from('a\n\nb\n\n\nc\n', 'utf8'));
    expect(lines).toEqual(['a', '', 'b', '', '', 'c']);
  });

  it('CRLF 混用：LF / CRLF / 裸 CR 行为', () => {
    const dec = createLineDecoder();
    // CRLF 行尾剥除；裸 CR（非行尾）保留
    const lines = dec.push(Buffer.from('a\r\nb\nc\rd\n', 'utf8'));
    expect(lines).toEqual(['a', 'b', 'c\rd']);
  });

  it('CR 与 LF 分属不同 chunk：不误剥', () => {
    const dec = createLineDecoder();
    const buf = Buffer.from('x\r\ny\n', 'utf8');
    // 第一个 chunk 以 \r 结尾，第二个以 \n 开头
    const l1 = dec.push(buf.subarray(0, 2)); // 'x\r'
    expect(l1).toEqual([]);
    const l2 = dec.push(buf.subarray(2));    // '\ny\n'
    expect(l2).toEqual(['x', 'y']);
  });

  it('尾部残缺：无换行时 flush 输出；含残缺多字节 flush 输出替换符（记录行为）', () => {
    const dec = createLineDecoder();
    const buf = Buffer.from('完整行', 'utf8');
    expect(dec.push(buf.subarray(0, 8))).toEqual([]); // 8 字节非完整多字节尾部
    // 剩余字节：'完整行' = 9 字节（3*3）；8 字节截断最后一个字符 1 字节
    const tail = dec.flush();
    expect(tail.length).toBe(1);
    // flush 对残缺多字节直接 toString → 可能含 U+FFFD（记录为观察：flush 无 UTF-8 校验）
    // 注：完整 9 字节时 flush 正常无替换符
    const dec2 = createLineDecoder();
    dec2.push(buf);
    expect(dec2.flush()).toEqual(['完整行']);
  });

  it('BOM（EF BB BF）保留在行首（记录行为：不剥 BOM）', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文\n', 'utf8')]));
    // BOM 作为 U+FEFF 出现在行首（当前实现不剥 BOM —— 记录为观察）
    expect(lines[0].charCodeAt(0)).toBe(0xfeff);
    expect(lines[0].includes('\uFFFD')).toBe(false);
  });

  it('前后空格保留（不 trim，M/X22 修复实证）', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from('  前导   \n\t制表\t\n', 'utf8'));
    expect(lines).toEqual(['  前导   ', '\t制表\t']);
  });

  it('空行保留：连续换行产生空字符串行', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from('\n\n\n', 'utf8'));
    expect(lines).toEqual(['', '', '']);
  });

  it('纯 \r\n 空行 → 空字符串行', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from('\r\n\r\n', 'utf8'));
    expect(lines).toEqual(['', '']);
  });

  it('push 字符串输入（非 Buffer）按 utf8 编码', () => {
    const dec = createLineDecoder();
    const lines = dec.push('中文行\nnext\n');
    expect(lines).toEqual(['中文行', 'next']);
  });

  it('hasPending 状态机：空 / 完整行 / 半行 / flush 后', () => {
    const dec = createLineDecoder();
    expect(dec.hasPending()).toBe(false);
    dec.push('x');
    expect(dec.hasPending()).toBe(true);
    dec.push('\n');
    expect(dec.hasPending()).toBe(false);
    dec.push('y');
    expect(dec.hasPending()).toBe(true);
    dec.flush();
    expect(dec.hasPending()).toBe(false);
  });

  it('超长行（>1MB）不崩溃，完整还原', () => {
    const dec = createLineDecoder();
    const longLine = '中'.repeat(400000); // 1.2MB
    const buf = Buffer.from(longLine + '\n', 'utf8');
    const lines = [];
    for (let i = 0; i < buf.length; i += 8192) {
      lines.push(...dec.push(buf.subarray(i, i + 8192)));
    }
    expect(lines).toEqual([longLine]);
    expect(lines[0].includes('\uFFFD')).toBe(false);
  });

  it('空 chunk / 空字符串 push 安全', () => {
    const dec = createLineDecoder();
    expect(dec.push(Buffer.alloc(0))).toEqual([]);
    expect(dec.push('')).toEqual([]);
  });
});
