'use strict';
// test/fix-batch6.test.js — 第六批 P3 快速修复验收
const { parseArgs } = require('../cli/parser');
const { helpResult, usageResult } = require('../app/commands');
const { checkConflicts } = require('../domain/conflicts');
const { createCore } = require('../app/create-core');
const { patchIdFor } = require('../domain/patch');
const { migrateState } = require('../infra/store');

describe('P3-1 --help 支持', () => {
  it('--help 解析为 help 标志（不再 ERR_ARG_BAD_OPTION）', () => {
    const r = parseArgs(['--help']);
    expect(r.ok).toBe(true);
    expect(r.help).toBe(true);
    const r2 = parseArgs(['-h']);
    expect(r2.ok).toBe(true);
    expect(r2.help).toBe(true);
  });

  it('helpResult exit=0 且含用法', () => {
    const h = helpResult();
    expect(h.exitCode).toBe(0);
    expect(h.message).toContain('用法');
  });
});

describe('P3-2 --tail 0 合法', () => {
  it('--tail 0 保持 0（全部），不回落 50', () => {
    expect(parseArgs(['logs', 'id', '--tail', '0']).options.tail).toBe(0);
  });
  it('--tail 负值回落默认 50', () => {
    expect(parseArgs(['logs', 'id', '--tail', '-5']).options.tail).toBe(50);
  });
});

describe('P3-3 role 大小写归一', () => {
  it('Search 与 search 视为重复角色', () => {
    const plugins = [
      { id: 'a', name: 'a', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: { role: 'Search' } },
      { id: 'b', name: 'b', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: { role: 'search' } }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(false);
    expect(r.conflicts.some((c) => c.type === 'role')).toBe(true);
  });
});

describe('P3-4 create-core 装配 manifest', () => {
  it('domain.manifest 存在且与 stages 使用一致', () => {
    const core = createCore({ baseDir: __dirname, home: require('os').tmpdir() });
    expect(typeof core.domain.manifest.buildManifest).toBe('function');
  });
});

describe('P3-5 patch id 碰撞已消除（回归确认）', () => {
  it('截断后不同 id 不碰撞', () => {
    const packId = 'x'.repeat(64);
    expect(patchIdFor(packId, 'a'.repeat(40))).not.toBe(patchIdFor(packId, 'a'.repeat(39) + 'b'));
  });
});

describe('P3-6 store 迁移错误语义（FIX-9 联动）', () => {
  it('高版本明确拒绝（exit 12 环境域）', () => {
    const r = migrateState({ schemaVersion: 99 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ENV_UNSUPPORTED');
    expect(r.error.exitCode).toBe(12);
  });
});
