'use strict';
// test/crosslang-html.test.mjs — 跨语言契约：prototype.html 内联解析器 ≡ shared（M-51/R-v5-2）
//
// 从 dsh-pack-hub/prototype.html 提取内联 parseHotpackJson / dshpackToHotpack /
// validateSourceRef / sanitizeMcpCommand，在 vm 中执行并与 shared 权威实现比对。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = readFileSync(join(root, 'dsh-hotplug-hub', 'dsh-pack-hub', 'prototype.html'), 'utf8');

/** 提取 prototype.html 中的函数源码（按名称 + 大括号配对；识别字符串/正则/注释）。 */
function extractFn(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`prototype.html 中找不到函数 ${name}`);
  // async 前缀一并截取（async function 体内的 await 才合法——审计修复：此前按
  // `function name(` 定位会丢掉 async 关键字，提取 async 函数必得 SyntaxError）
  const fnStart = html.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
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

const sandbox = { console, setTimeout, clearTimeout, AbortController, Promise, unescape, encodeURIComponent, Date, Math };
sandbox.window = {};
sandbox.state = { plugins: [] };
vm.createContext(sandbox);
// MCP_CMD_SAFE_RE 常量（sanitizeMcpCommand 依赖）
const safeReMatch = /const MCP_CMD_SAFE_RE = \/.*?\/;/.exec(html);
if (safeReMatch) vm.runInContext(safeReMatch[0], sandbox);
for (const name of ['parseHotpackJson', 'dshpackToHotpack', 'validateSourceRef', 'sanitizeMcpCommand', 'packIdOf', 'sha1Hex', 'sanitizeTopic', 'codeloadTarUrl', 'marketInstallSpec', 'installedPluginNames', 'marketEntryInstalled', 'raceFilesAny', 'fetchTimeout']) {
  const src = extractFn(name);
  if (name === 'dshpackToHotpack' || name === 'packIdOf') {
    // dshpackToHotpack 依赖 parseHotpackJson 与 packIdOf（原型内联）；packIdOf 依赖 sha1Hex
    vm.runInContext(extractFn('parseHotpackJson') + '\n' + extractFn('sha1Hex') + '\n' + extractFn('packIdOf') + '\n' + src, sandbox, { filename: 'prototype-inline.js' });
  } else if (name === 'marketInstallSpec' || name === 'installedPluginNames') {
    if (name === 'marketInstallSpec') {
      vm.runInContext(extractFn('codeloadTarUrl') + '\n' + src, sandbox, { filename: 'prototype-inline.js' });
    } else {
      vm.runInContext(src, sandbox, { filename: 'prototype-inline.js' });
    }
  } else if (name === 'raceFilesAny') {
    // raceFilesAny 依赖 fetchTimeout（外部 signal 联动 + AbortController）
    vm.runInContext('const FETCH_TIMEOUT_MS = 12000;\n' + extractFn('fetchTimeout') + '\n' + src, sandbox, { filename: 'prototype-inline.js' });
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
  sha1Hex: sandbox.sha1Hex,
  sanitizeTopic: sandbox.sanitizeTopic,
  marketInstallSpec: sandbox.marketInstallSpec,
  installedPluginNames: sandbox.installedPluginNames,
  marketEntryInstalled: sandbox.marketEntryInstalled,
  raceFilesAny: sandbox.raceFilesAny,
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

  it('packIdOf 与后端一致（golden 值 + 单射；修复：shared 未导出 packIdOf 使旧断言恒真）', async () => {
    // golden 由后端 lib/core/market.js packIdOf 生成（sha1 后缀防 a-b/c 与 a/b-c 清洗碰撞）
    expect(inline.packIdOf('ARFCON/dsh-hotplug-hub')).toBe('pack.arfcon-dsh-hotplug-hub-6360aa41');
    expect(inline.packIdOf('a-b/c')).not.toBe(inline.packIdOf('a/b-c'));
    // 与后端实现逐字符等价（动态比对，防 golden 漂移）
    const backendPackIdOf = (repo) => {
      const s = String(repo).toLowerCase();
      const base = ('pack.' + s).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      const digest = createHash('sha1').update(s).digest('hex').slice(0, 8);
      const head = base.length <= 55 ? base : base.slice(0, 55);
      return `${head}-${digest}`;
    };
    for (const repo of ['a/b', 'A-B/c', 'x'.repeat(80) + '/y', 'owner/repo.name', '中文/仓库']) {
      expect(inline.packIdOf(repo), repo).toBe(backendPackIdOf(repo));
    }
    // sha1Hex 与 node:crypto 等价（UTF-8 多字节）
    for (const s of ['abc', '中文仓库', 'emoji-🐱-test', '']) {
      expect(inline.sha1Hex(s)).toBe(createHash('sha1').update(s, 'utf8').digest('hex'));
    }
  });

  it('marketInstallSpec：manifest 源优先于 npmName（npm 抢注防护）', () => {
    // manifest 是 github 源 + 仓库 package.json name 恰好是热门 npm 包名 → 必须走 github tarball
    // 审计修复（审查轮 P1）：codeload URL 必须带 heads|tags 段——`/tar.gz/refs/<branch>`
    // 实测 404（正确形态见 Main.cs EnsureDshHub 与后端 ensure.js githubZipUrls）
    const e = {
      repo: 'evil/repo', ref: 'main', npmName: 'lodash', version: '4.17.21',
      manifest: { plugins: [{ id: 'main', name: 'anything', source: { type: 'github', repo: 'evil/repo', ref: 'main' } }] },
    };
    expect(inline.marketInstallSpec(e)).toBe('https://codeload.github.com/evil/repo/tar.gz/refs/heads/main');
    // 版本号形态的 ref 走 tags/
    const tagE = { repo: 'o/r', ref: 'v1.2.0', manifest: { plugins: [{ id: 'p', name: 'x', source: { type: 'github', repo: 'o/r', ref: 'v1.2.0' } }] } };
    expect(inline.marketInstallSpec(tagE)).toBe('https://codeload.github.com/o/r/tar.gz/refs/tags/v1.2.0');
    // npm 源 manifest → 精确版本 spec
    expect(inline.marketInstallSpec({ manifest: { plugins: [{ id: 'p', name: 'pkg-a', version: '1.2.3', source: { type: 'npm' } }] } })).toBe('pkg-a@1.2.3');
    // 无 manifest → 仓库 tarball 兜底（不是 npmName）
    expect(inline.marketInstallSpec({ repo: 'o/r', ref: 'dev', npmName: 'some-npm-name' })).toBe('https://codeload.github.com/o/r/tar.gz/refs/heads/dev');
  });

  it('marketEntryInstalled：URL 安装的插件按 spec 内的仓库路径识别（包名 ≠ 仓库名场景）', () => {
    sandbox.window.__pluginsData = [{ id: 'unrelated-pkg-name', name: 'unrelated-pkg-name', spec: 'https://codeload.github.com/o/somerepo/tar.gz/refs/heads/main' }];
    expect(inline.marketEntryInstalled({ repo: 'o/somerepo', name: 'Some Repo', manifest: null })).toBe(true);
    sandbox.window.__pluginsData = [{ id: 'x', name: 'x', spec: 'https://codeload.github.com/o/other/tar.gz/refs/heads/main' }];
    expect(inline.marketEntryInstalled({ repo: 'o/somerepo', name: 'Some Repo', manifest: null })).toBe(false);
    // 仓库短名命中（dependencies 键 = 仓库名的常见形态）
    sandbox.window.__pluginsData = [{ id: 'dsh-hub', name: 'dsh-hub', spec: '^1.0.0' }];
    expect(inline.marketEntryInstalled({ repo: 'arfcon/dsh-hub', name: 'dsh-hub', manifest: null })).toBe(true);
    sandbox.window.__pluginsData = [];
  });

  it('sanitizeTopic：非法 token 显式拒绝（null），与后端语义一致（不再静默过滤）', () => {
    expect(inline.sanitizeTopic('')).toBe('');
    // 逗号（中英文）与空格同为分隔符——与后端 sanitizeTopic 的 /[,，\s]+/ 一致
    expect(inline.sanitizeTopic('a,b')).toBe('a b');
    expect(inline.sanitizeTopic('a，b')).toBe('a b');
    expect(inline.sanitizeTopic('  ')).toBe('');
    expect(inline.sanitizeTopic('dsh-plugin')).toBe('dsh-plugin');
    expect(inline.sanitizeTopic('A B')).toBe('a b');
    expect(inline.sanitizeTopic('a$b')).toBeNull();
    expect(inline.sanitizeTopic('a b c d e')).toBeNull();
    expect(inline.sanitizeTopic('x'.repeat(33))).toBeNull();
  });

  it('raceFilesAny：404/410 立即结算；403（限流）等镜像 200 胜出；败者被 abort（与后端 raceFiles 对齐）', async () => {
    const signals = [];
    sandbox.fetch = async (url, opts) => {
      const u = String(url);
      signals.push({ u, signal: opts && opts.signal });
      if (u.includes('404-first')) return { ok: false, status: 404 };
      if (u.includes('410-first')) return { ok: false, status: 410 };
      if (u.includes('403-first')) return { ok: false, status: 403 };
      if (u.includes('slow-mirror')) {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, status: 200, text: async () => 'mirror-200' };
      }
      if (u.includes('hang')) return new Promise(() => {});
      return { ok: false, status: 500 };
    };
    // 404 立即结算（不等 hang 通道）
    const r404 = await inline.raceFilesAny(['https://404-first/f', 'https://hang/f'], {});
    expect(r404.ok).toBe(false);
    expect(r404.status).toBe(404);
    // 410 同样立即结算
    const r410 = await inline.raceFilesAny(['https://410-first/f', 'https://hang/f'], {});
    expect(r410.status).toBe(410);
    // 403 不是「不存在」：等 slow-mirror 的 200 胜出
    const r403 = await inline.raceFilesAny(['https://403-first/f', 'https://slow-mirror/f'], {});
    expect(r403.ok).toBe(true);
    expect(r403.text).toBe('mirror-200');
    // 胜出后 hang 通道的 signal 被 abort
    const hang = signals.find((s) => s.u.includes('hang'));
    expect(hang.signal.aborted).toBe(true);
    delete sandbox.fetch;
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
