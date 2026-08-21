'use strict';
// test/crosslang-html.test.mjs — 跨语言契约：prototype.html 内联解析器 ≡ shared（M-51/R-v5-2）
//
// 从 dsh-pack-hub/prototype.html 提取内联 parseHotpackJson / dshpackToHotpack /
// validateSourceRef / sanitizeMcpCommand，在 vm 中执行并与 shared 权威实现比对。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = readFileSync(join(root, 'dsh-hotplug-hub', 'dsh-pack-hub', 'prototype.html'), 'utf8');

/** 提取 prototype.html 中的函数源码（按名称 + 大括号配对；识别字符串/正则/注释）。 */
function extractFn(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`prototype.html 中找不到函数 ${name}`);
  const fnStart = start;
  let depth = 0;
  let i = html.indexOf('{', start);
  const isRegexStart = (pos) => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(html[j])) j -= 1;
    if (j < 0) return true;
    const prev = html[j];
    return !/[A-Za-z0-9_)\]}'"`]/.test(prev);
  };
  for (; i < html.length; i += 1) {
    const c = html[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      for (; i < html.length; i += 1) {
        if (html[i] === '\\') { i += 1; continue; }
        if (html[i] === quote) break;
      }
      continue;
    }
    if (c === '/' && html[i + 1] === '/') { while (i < html.length && html[i] !== '\n') i += 1; continue; }
    if (c === '/' && html[i + 1] === '*') { i += 2; while (i < html.length && !(html[i] === '*' && html[i + 1] === '/')) i += 1; i += 1; continue; }
    if (c === '/' && isRegexStart(i)) {
      i += 1;
      let inClass = false;
      for (; i < html.length; i += 1) {
        if (html[i] === '\\') { i += 1; continue; }
        if (html[i] === '[') inClass = true;
        else if (html[i] === ']') inClass = false;
        else if (html[i] === '/' && !inClass) break;
      }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return html.slice(fnStart, i + 1); }
  }
  throw new Error(`函数 ${name} 提取失败`);
}

const sandbox = { console };
vm.createContext(sandbox);
// MCP_CMD_SAFE_RE 常量（sanitizeMcpCommand 依赖）
const safeReMatch = /const MCP_CMD_SAFE_RE = \/.*?\/;/.exec(html);
if (safeReMatch) vm.runInContext(safeReMatch[0], sandbox);
for (const name of ['parseHotpackJson', 'dshpackToHotpack', 'validateSourceRef', 'sanitizeMcpCommand', 'packIdOf']) {
  const src = extractFn(name);
  if (name === 'dshpackToHotpack' || name === 'packIdOf') {
    // dshpackToHotpack 依赖 parseHotpackJson 与 packIdOf（原型内联）
    vm.runInContext(extractFn('parseHotpackJson') + '\n' + extractFn('packIdOf') + '\n' + src, sandbox, { filename: 'prototype-inline.js' });
  } else {
    vm.runInContext(src, sandbox, { filename: 'prototype-inline.js' });
  }
}
const inline = {
  parseHotpackJson: sandbox.parseHotpackJson,
  dshpackToHotpack: sandbox.dshpackToHotpack,
  validateSourceRef: sandbox.validateSourceRef,
  sanitizeMcpCommand: sandbox.sanitizeMcpCommand,
  packIdOf: sandbox.packIdOf,
};

const shared = require('../index.js');

describe('prototype.html 内联解析器 ≡ shared（M-51 / R-v5-2 行为等价）', () => {
  it('parseHotpackJson 接受/拒绝与 shared parseHotpack 一致（样本集）', () => {
    const samples = [
      { hotpack: '1.0', id: 'pack.x', name: 'X', version: '1.0.0', plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }] },
      { hotpack: '1.0', id: 'pack.x', name: 'X', version: '1.0.0', plugins: [] },
      { hotpack: '2.0', id: 'x', name: 'X', version: '1.0.0', plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }] },
      { id: 'x', name: 'X', version: '1.0.0', plugins: [] },
      { hotpack: '1.0', name: 'X', version: '1.0.0', plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }] },
      { hotpack: '1.0', id: 'x', version: '1.0.0', plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }] },
      { hotpack: '1.0', id: 'x', name: 'X', plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }] },
    ];
    for (const s of samples) {
      const text = JSON.stringify(s);
      const a = inline.parseHotpackJson(text) !== null;
      const b = shared.parseHotpack(text).ok;
      expect(a, JSON.stringify(s)).toBe(b);
    }
  });

  it('validateSourceRef 与 shared 一致（H-10 样本）', () => {
    const cases = ['main', 'v1.0.0', 'feature/x', 'release/v1.0/stable', '..', '...', 'a..b', 'a/b/../c', 'feature/', '/feature', 'a//b', 'a\\b', 'a b', 'a&b', '', 'x'.repeat(300), 'a\u0000b'];
    for (const ref of cases) {
      expect(inline.validateSourceRef(ref), JSON.stringify(ref)).toBe(shared.validateSourceRef(ref).ok);
    }
  });

  it('sanitizeMcpCommand 拒绝 shell 元字符（M-52 等价）', () => {
    expect(inline.sanitizeMcpCommand('npx', '').ok).toBe(true);
    expect(inline.sanitizeMcpCommand('npx', '--foo bar').ok).toBe(true);
    expect(inline.sanitizeMcpCommand('a&b', '').ok).toBe(false);
    expect(inline.sanitizeMcpCommand('npx', 'x;rm').ok).toBe(false);
    expect(inline.sanitizeMcpCommand('', '').ok).toBe(false);
    expect(inline.sanitizeMcpCommand('npx', 'a$(id)').ok).toBe(false);
    expect(inline.sanitizeMcpCommand('npx', 'a b c').ok).toBe(true);
  });

  it('packIdOf 与 shared 一致', () => {
    expect(inline.packIdOf('ARFCON/dsh-hotplug-hub')).toBe(shared.packIdOf ? shared.packIdOf('ARFCON/dsh-hotplug-hub') : 'pack.arfcon-dsh-hotplug-hub');
  });

  it('prototype.html 关键安全特征（H-12/M-53）', () => {
    // 无内联 onclick 处理器（removeSkill 已迁移 addEventListener）
    expect(html.includes('onclick="removeSkill(')).toBe(false);
    // window.open 带协议白名单
    const openIdx = html.indexOf("window.open(btn.dataset.url, '_blank')");
    expect(openIdx).toBe(-1); // 旧无校验形态已不存在
    expect(html.includes('/^https?:\\/\\//i.test(url)')).toBe(true);
    // 兼容性标注存在
    expect(html.includes('导入兼容性以实际安装校验为准')).toBe(true);
  });

  it('dshpackToHotpack：原型内联与 shared 接受/拒绝一致（样本）', () => {
    const cases = [
      JSON.stringify({ packId: 'x', name: 'n', version: '1.0.0', bundles: [{ package: 'pkg-a', version: '1.0.0' }] }),
      JSON.stringify({ packId: 'x', name: 'n', version: '1.0.0', bundles: [{ package: 'pkg-a' }] }),
      JSON.stringify({ packId: 'x', name: 'n', version: '1.0.0', bundles: [] }),
      '{bad',
    ];
    for (const text of cases) {
      const a = inline.dshpackToHotpack(text) !== null;
      const b = shared.dshpackToHotpack(text).ok;
      expect(a, text.slice(0, 60)).toBe(b);
    }
  });
});
