'use strict';
// test/format.test.js — cli/format.js 双模式输出全覆盖（§8.5：cli 边界 100%）
// 覆盖：badgeFor（含未知命令）、formatScalar（null/对象/原始值）、formatData
// （null/空数组/数组/嵌套对象/空数组值/原始值）、formatResult 文本模式（带数据/
// 不带数据/未知命令徽标）、JSON 模式、exitCodeForResult 全分支。
const { formatResult, exitCodeForResult, badgeFor } = require('../cli/format');

describe('cli/format.js 双模式输出（§8.5 边界 100%）', () => {
  describe('badgeFor', () => {
    it('已知命令成功/失败徽标', () => {
      expect(badgeFor('assemble', true)).toBe('ASSEMBLE OK');
      expect(badgeFor('assemble', false)).toBe('ASSEMBLE FAIL');
      expect(badgeFor('logs', true)).toBe('LOGS OK');
      expect(badgeFor('rollback', false)).toBe('ROLLBACK FAIL');
    });
    it('未知命令回退 CMD 徽标', () => {
      expect(badgeFor('frobnicate', true)).toBe('CMD OK');
      expect(badgeFor(undefined, false)).toBe('CMD FAIL');
    });
  });

  describe('formatScalar（内部格式化）', () => {
    it('数组元素 null/undefined → (null)；对象属性 null → "k: null"', () => {
      const arr = formatResult({ ok: true, code: 'OK', message: 'm', data: [null, undefined], exitCode: 0 }, { command: 'status' });
      expect(arr).toContain('(null)');
      const obj = formatResult({ ok: true, code: 'OK', message: 'm', data: { a: null, b: undefined }, exitCode: 0 }, { command: 'status' });
      expect(obj).toContain('a: null');
      expect(obj).toContain('b: undefined');
    });
  });

  describe('formatData 文本数据体', () => {
    it('null data → 无数据体', () => {
      expect(formatResult({ ok: true, code: 'OK', message: 'm', data: null, exitCode: 0 }, { command: 'check' }))
        .toBe('CHECK OK m');
    });
    it('空数组 → "  []"', () => {
      const out = formatResult({ ok: true, code: 'OK', message: 'm', data: [], exitCode: 0 }, { command: 'logs' });
      expect(out).toContain('[]');
    });
    it('数组（含对象元素）→ 逐元素格式化', () => {
      const out = formatResult({ ok: true, code: 'OK', message: 'm', data: [{ name: 'p1' }, 'plain'], exitCode: 0 }, { command: 'status' });
      expect(out).toContain('name: p1');
      expect(out).toContain('plain');
    });
    it('嵌套对象 → 缩进层级；空数组值 → "k: []" 单行', () => {
      const out = formatResult({
        ok: true, code: 'OK', message: 'm',
        data: { top: { inner: { deep: 1 } }, empty: [], flag: true },
        exitCode: 0
      }, { command: 'status' });
      expect(out).toContain('top:');
      expect(out).toContain('inner:');
      expect(out).toContain('deep: 1');
      expect(out).toContain('empty: []');
      expect(out).toContain('flag: true');
    });
    it('原始值 data → 直接输出', () => {
      const out = formatResult({ ok: true, code: 'OK', message: 'm', data: 42, exitCode: 0 }, { command: 'status' });
      expect(out).toContain('42');
    });
  });

  describe('formatResult 模式', () => {
    it('JSON 模式：完整 CommandResult 可 JSON.parse（含 data）', () => {
      const result = { ok: false, code: 'ERR_X', message: 'boom', data: { k: [1, 2] }, exitCode: 3 };
      const json = formatResult(result, { json: true });
      expect(JSON.parse(json)).toEqual(result);
    });
    it('文本模式：徽标 + message 首行，数据体随后', () => {
      const out = formatResult({ ok: true, code: 'OK', message: '完成', data: { a: 1 }, exitCode: 0 }, { command: 'install' });
      const lines = out.split('\n');
      expect(lines[0]).toBe('INSTALL OK 完成');
      expect(lines[1]).toContain('a: 1');
    });
    it('opts 缺省：命令徽标回退 CMD', () => {
      const out = formatResult({ ok: false, code: 'ERR_X', message: 'err', data: null, exitCode: 2 }, {});
      expect(out).toBe('CMD FAIL err');
    });
  });

  describe('exitCodeForResult 全分支', () => {
    it('null result → 1', () => {
      expect(exitCodeForResult(null)).toBe(1);
      expect(exitCodeForResult(undefined)).toBe(1);
    });
    it('显式 exitCode（含 0）优先', () => {
      expect(exitCodeForResult({ ok: true, exitCode: 5 })).toBe(5);
      expect(exitCodeForResult({ ok: false, exitCode: 0 })).toBe(0);
    });
    it('无 exitCode：ok → 0', () => {
      expect(exitCodeForResult({ ok: true })).toBe(0);
    });
    it('无 exitCode 且失败 → exitCodeForCode(result.code)', () => {
      expect(exitCodeForResult({ ok: false, code: 'ERR_ARG_BAD_OPTION' })).toBe(2);
      expect(exitCodeForResult({ ok: false, code: 'ERR_ENV_UNSUPPORTED' })).toBe(12);
    });
  });
});
