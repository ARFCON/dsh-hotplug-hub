'use strict';
// test/hotpack.test.js — 权威 parseHotpack（launcher 语义基线，R-v5-11）+
// dshpackToHotpack + legacy 兼容 + opts 展示约束
const path = require('path');
const fs = require('fs');
const { parseHotpack, parseLegacy, validateAssembly, dshpackToHotpack } = require('../format/hotpack');

function validPack() {
  return {
    hotpack: '1.0',
    id: 'pack.research',
    name: 'Research Pack',
    version: '1.0.0',
    description: 'desc',
    tags: ['t1', 't2'],
    plugins: [
      { id: 'lit', name: '@dsh-community/dsh-tool-literature', source: { type: 'npm' }, version: '1.2.3', config: { k: 1 } },
      { id: 'cite', name: 'dsh-cite', source: { type: 'npm' }, version: '0.9.1' },
      { id: 'local', name: 'dsh-local', source: { type: 'path', path: 'C:/pkg' } },
      { id: 'gh', name: 'dsh-gh', source: { type: 'github', repo: 'owner/repo', ref: 'main' } }
    ]
  };
}

describe('parseHotpack 顶层校验（launcher 语义基线）', () => {
  it('接受合法 hotpack 并归一化', () => {
    const r = parseHotpack(validPack());
    expect(r.ok).toBe(true);
    expect(r.pack.hotpack).toBe('1.0');
    expect(r.pack.id).toBe('pack.research');
    expect(r.pack.name).toBe('Research Pack');
    expect(r.pack.plugins).toHaveLength(4);
    expect(r.pack.plugins[3].source).toEqual({ type: 'github', repo: 'owner/repo', ref: 'main' });
    // 不附加 memory（hotplug 侧职责）
    expect(r.pack.memory).toBeUndefined();
  });

  it('JSON 字符串输入', () => {
    const r = parseHotpack(JSON.stringify(validPack()));
    expect(r.ok).toBe(true);
  });

  it('错误统一 {ok, code, message}', () => {
    const cases = [
      ['not json {', 'ERR_ASSEMBLY_INVALID_JSON'],
      [42, 'ERR_ASSEMBLY_FIELD'],
      [{ hotpack: '2.0' }, 'ERR_ASSEMBLY_UNSUPPORTED'],
      [{ hotpack: '1.0', id: '-bad', name: 'x', version: '1.0.0', plugins: [{ id: 'p', name: 'n', source: { type: 'npm' }, version: '1.0.0' }] }, 'ERR_ARG_INVALID_ID'],
      [{ hotpack: '1.0', id: 'ok', name: '  ', version: '1.0.0', plugins: [{ id: 'p', name: 'n', source: { type: 'npm' }, version: '1.0.0' }] }, 'ERR_ASSEMBLY_FIELD'],
      [{ hotpack: '1.0', id: 'ok', name: 'x', version: '1.02.3', plugins: [{ id: 'p', name: 'n', source: { type: 'npm' }, version: '1.0.0' }] }, 'ERR_ASSEMBLY_FIELD'],
      [{ hotpack: '1.0', id: 'ok', name: 'x', version: '1.0.0', plugins: [] }, 'ERR_ASSEMBLY_FIELD'],
    ];
    for (const [input, code] of cases) {
      const r = parseHotpack(input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      expect(r.code, JSON.stringify(input)).toBe(code);
      expect(typeof r.message).toBe('string');
    }
  });

  it('插件级校验：保留名 / 重复 / 源类型 / 版本', () => {
    const base = () => ({ hotpack: '1.0', id: 'ok', name: 'x', version: '1.0.0', plugins: [] });
    const one = (p) => parseHotpack({ ...base(), plugins: [p] });
    expect(one({ id: 'p', name: 'CON', source: { type: 'npm' }, version: '1.0.0' }).ok).toBe(false); // 保留名
    expect(one({ id: 'p', name: 'n', source: { type: 'npm' }, version: 'latest' }).ok).toBe(false);
    expect(one({ id: 'p', name: 'n', source: { type: 'evil' } }).ok).toBe(false);
    expect(one({ id: 'p', name: 'n', source: 'npm' }).ok).toBe(false);
    expect(one({ id: 'p', name: 'n', source: { type: 'path' } }).ok).toBe(false); // 缺 path
    expect(one({ id: 'p', name: 'n', source: { type: 'github', repo: '' } }).ok).toBe(false); // 缺 repo
    expect(one({ id: 'p', name: 'n', source: { type: 'github', repo: 'o/r', ref: '../x' } }).ok).toBe(false); // 非法 ref
    expect(one({ id: 'p', name: 'n', source: { type: 'npm' }, version: '1.0.0' }).ok).toBe(true);
    expect(one({ id: 'p', name: 'n', source: { type: 'github', repo: 'o/r', ref: 'main' } }).ok).toBe(true);
    // 重复 id / name（大小写不敏感）
    const dup = parseHotpack({ ...base(), plugins: [
      { id: 'p', name: 'n', source: { type: 'npm' }, version: '1.0.0' },
      { id: 'P', name: 'n2', source: { type: 'npm' }, version: '1.0.0' }
    ] });
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe('ERR_ASSEMBLY_DUPLICATE');
  });

  it('source.type 空串 / 未知类型拒绝（不与缺省 npm 混同）', () => {
    const base = () => ({ hotpack: '1.0', id: 'ok', name: 'x', version: '1.0.0', plugins: [] });
    const one = (p) => parseHotpack({ ...base(), plugins: [p] });
    expect(one({ id: 'p', name: 'n', source: { type: '' }, version: '1.0.0' }).ok).toBe(false);
    expect(one({ id: 'p', name: 'n', source: { type: '' }, version: '1.0.0' }).code).toBe('ERR_ASSEMBLY_FIELD');
    // 缺省 source.type（undefined）仍默认 npm（向后兼容）
    expect(one({ id: 'p', name: 'n', source: {}, version: '1.0.0' }).ok).toBe(true);
    expect(one({ id: 'p', name: 'n', source: { type: 'path', path: 'C:/x' } }).ok).toBe(true);
  });

  it('opts：maxNameLength / maxDescLength（hotplug 214/300 展示约束）', () => {
    const pack = validPack();
    pack.description = 'd'.repeat(500);
    pack.plugins[0].name = 'pkg-' + 'x'.repeat(220);
    const r = parseHotpack(pack, { maxNameLength: 214, maxDescLength: 300 });
    expect(r.ok).toBe(false); // name 超限拒绝
    pack.plugins[0].name = 'pkg';
    const r2 = parseHotpack(pack, { maxNameLength: 214, maxDescLength: 300 });
    expect(r2.ok).toBe(true);
    expect(r2.pack.description.length).toBe(300);
    // 缺省不截断
    const r3 = parseHotpack(validPack());
    expect(r3.pack.description).toBe('desc');
  });

  it('allowLegacy:false 拒绝 legacy 形态（hotplug 语义）', () => {
    const legacy = { packId: 'x', name: 'n', version: '1.0.0', bundles: [{ id: 'b', package: 'p', version: '1.0.0' }] };
    const r = parseHotpack(legacy, { allowLegacy: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ASSEMBLY_UNSUPPORTED');
  });
});

describe('legacy 兼容（launcher 语义）', () => {
  it('缺省允许 legacy {packId, bundles} 形态', () => {
    const r = parseHotpack({ packId: 'x', name: 'n', version: '1.0.0', bundles: [{ id: 'b', package: 'p', version: '1.0.0' }] });
    expect(r.ok).toBe(true);
    expect(r.pack.id).toBe('x');
    expect(r.pack.plugins[0].name).toBe('p');
  });
  it('legacy 缺 id/name/version/bundles 显式报错（N38）', () => {
    expect(parseLegacy({ name: 'n', version: '1.0.0', bundles: [] }).ok).toBe(false);
    expect(parseLegacy({ packId: 'x', version: '1.0.0', bundles: [{ id: 'b', package: 'p' }] }).ok).toBe(false);
    expect(parseLegacy({ packId: 'x', name: 'n', bundles: [{ id: 'b', package: 'p', version: '1.0.0' }] }).ok).toBe(false);
    expect(parseLegacy({ packId: 'x', name: 'n', version: '1.0.0', bundles: [] }).ok).toBe(false);
  });
});

describe('validateAssembly 别名', () => {
  it('与 parseHotpack 同语义', () => {
    expect(validateAssembly(validPack()).ok).toBe(true);
    expect(validateAssembly('bad').ok).toBe(false);
  });
});

describe('dshpackToHotpack（H-11b/c 修复后语义）', () => {
  it('合法 dshpack → hotpack', () => {
    const text = JSON.stringify({
      packId: 'cn.dshpack.research',
      name: 'Research',
      version: '1.0.0',
      description: 'd',
      tags: ['t'],
      bundles: [
        { id: 'lit', package: '@dsh-community/dsh-tool-literature', version: '1.2.3', role: '文献', source: 'npm' },
        { id: 'cite', package: 'dsh-cite', version: '0.9.1', role: 'cite-tool', source: 'npm' }
      ]
    });
    const r = dshpackToHotpack(text);
    expect(r.ok).toBe(true);
    expect(r.pack.id).toBe('cn.dshpack.research');
    expect(r.pack.plugins).toHaveLength(2);
    // H-11b：显式 bundle.id 优先
    expect(r.pack.plugins[0].id).toBe('lit');
    expect(r.pack.plugins[1].id).toBe('cite');
  });

  it('H-11b：无显式 id → role 清洗；非 ASCII role → pluginN 回退', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [
        { package: 'pkg-a', version: '1.0.0', role: '文献' },
        { package: 'pkg-b', version: '1.0.0' }
      ]
    }));
    expect(r.ok).toBe(true);
    expect(r.pack.plugins[0].id).toBe('plugin1');
    expect(r.pack.plugins[1].id).toBe('plugin2');
  });

  it('H-11b 审计修复：role 前导下划线派生 id 首字符字母数字（不再被 validatePluginId 拒绝）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [
        { package: 'pkg-a', version: '1.0.0', role: '_foo' },
        { package: 'pkg-b', version: '1.0.0', role: 'bar_baz' }
      ]
    }));
    expect(r.ok).toBe(true);
    expect(r.pack.plugins[0].id).toBe('foo');     // '_foo' → 'foo'（剥前导下划线）
    expect(r.pack.plugins[1].id).toBe('bar_baz'); // 内部下划线保留
  });

  it('H-11b：npm 缺精确 version → 显式报错（不再静默跳过）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [{ id: 'a', package: 'pkg-a', source: 'npm' }]
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ASSEMBLY_FIELD');
    expect(r.message).toContain('version');
  });

  it('H-11b：显式 id 非法 → 报错（不静默造数）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [{ id: 'a/b', package: 'pkg-a', version: '1.0.0' }]
    }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('id 非法');
  });

  it('空 bundles → 显式报错', () => {
    const r = dshpackToHotpack(JSON.stringify({ packId: 'x', name: 'n', version: '1.0.0', bundles: [] }));
    expect(r.ok).toBe(false);
  });

  it('github bundle 源（dshpack 未携带 repo → 报错；携带 repo/ref → 保留）', () => {
    const noRepo = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [{ id: 'g', package: 'p', version: '1.0.0', source: 'github' }]
    }));
    expect(noRepo.ok).toBe(false);
    const withRepo = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [{ id: 'g', package: 'p', version: '1.0.0', source: { type: 'github', repo: 'o/r', ref: 'main' } }]
    }));
    expect(withRepo.ok).toBe(true);
    expect(withRepo.pack.plugins[0].source).toEqual({ type: 'github', repo: 'o/r', ref: 'main' });
  });

  it('非法 JSON / 非对象 → 报错', () => {
    expect(dshpackToHotpack('{').ok).toBe(false);
    expect(dshpackToHotpack('[1]').ok).toBe(false);
  });

  it('dshpack source 显式枚举：path / 未知类型显式报错（不再静默降 npm）', () => {
    const pathStr = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [{ id: 'a', package: 'pkg-a', version: '1.0.0', source: 'path' }],
    }));
    expect(pathStr.ok).toBe(false);
    expect(pathStr.message).toContain('只支持 npm / github');
    const pathObj = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'n', version: '1.0.0',
      bundles: [{ id: 'a', package: 'pkg-a', version: '1.0.0', source: { type: 'path', path: 'C:/x' } }],
    }));
    expect(pathObj.ok).toBe(false);
  });
});

describe('与仓库示例契约', () => {
  it('research.hotpack.json 可解析（H-11 阶段 4 已修订示例为合法绝对路径）', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'dsh-hotplug-hub', 'examples', 'research.hotpack.json'), 'utf8');
    const r = parseHotpack(text);
    expect(r.ok).toBe(true);
    expect(r.pack.id).toBe('pack.research');
  });

  it('research-pack.dshpack.json 经 dshpackToHotpack 可解析（显式 bundle.id）', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'dsh-hotplug-hub', 'dsh-pack-hub', 'examples', 'research-pack.dshpack.json'), 'utf8');
    const r = dshpackToHotpack(text);
    expect(r.ok).toBe(true);
    expect(r.pack.id).toBe('cn.dshpack.research');
    expect(r.pack.plugins.map((p) => p.id)).toEqual(['literature', 'cite', 'paper-writer', 'review-board']);
  });
});
