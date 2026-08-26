'use strict';
// test/schemas.test.js — 5 个 JSON Schema 结构契约 + 4 个 ajv 校验器（M-28/H-14）
const {
  assemblySchema, stateSchema, cordisPatchSchema, runLineSchema, commandResultSchema, SCHEMAS,
  validateState, validateRunLine, validateCommandResult, validateAssemblyShape
} = require('../contracts/schemas');
const { validatePatchDocument } = require('../profile/patch');
const { validateVersion } = require('../ids');
const Ajv = require('ajv');

describe('SCHEMAS', () => {
  it('5 个 schema 齐全', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(['assembly', 'commandResult', 'cordisPatch', 'runLine', 'state']);
  });
  it('assemblySchema 契约字段', () => {
    expect(assemblySchema.properties.hotpack.const).toBe('1.0');
    expect(assemblySchema.required).toContain('plugins');
    expect(assemblySchema.properties.id.pattern).toBe('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$');
    expect(assemblySchema.definitions.source.properties.type.enum).toEqual(['npm', 'path', 'github']);
  });
  it('stateSchema 必填与 phase 字段（阶段 2 加 enum）', () => {
    expect(stateSchema.required).toContain('schemaVersion');
    expect(stateSchema.properties.schemaVersion.const).toBe(1);
    expect(typeof stateSchema.properties.phase).toBe('object');
  });
  it('runLineSchema 严格（additionalProperties:false）', () => {
    expect(runLineSchema.additionalProperties).toBe(false);
    expect(runLineSchema.properties.stream.enum).toEqual(['stdout', 'stderr', 'error']);
  });
  it('commandResultSchema 契约', () => {
    expect(commandResultSchema.required).toEqual(['ok', 'code', 'message', 'data', 'exitCode']);
  });
  it('cordisPatchSchema 结构', () => {
    expect(cordisPatchSchema.type).toBe('array');
    expect(cordisPatchSchema.items.required).toEqual(['insert']);
  });
});

describe('ajv 校验器（M-28/H-14：I/O 边界）', () => {
  // 与 createEmptyState 契约字段对齐（FIX-20：required 含 assemblySha256/rollback）
  const goodState = () => ({
    schemaVersion: 1,
    id: 'x',
    assemblySha256: null,
    phase: 'IDLE',
    resolved: { plugins: [], conflicts: [] },
    install: { status: 'missing', lastExit: null, nodeModules: false },
    launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
    heal: { history: [], quarantined: [] },
    rollback: { snapshot: null, lastRollbackAt: null }
  });

  it('validateState：合法通过；缺 schemaVersion/非法 phase 拒绝', () => {
    expect(validateState(goodState())).toEqual({ ok: true });
    const noVersion = validateState({ ...goodState(), schemaVersion: undefined });
    expect(noVersion.ok).toBe(false);
    expect(noVersion.errors.length).toBeGreaterThan(0);
    const badPhase = validateState({ ...goodState(), phase: 'NOT_A_PHASE' });
    expect(badPhase.ok).toBe(false);
    const missingHeal = validateState({ ...goodState(), heal: undefined });
    expect(missingHeal.ok).toBe(false);
  });

  it('validateRunLine：合法通过；缺字段/多字段拒绝（additionalProperties:false）', () => {
    const good = { seq: 1, t: '2024-01-01T00:00:00.000Z', stream: 'stderr', line: 'Error: x' };
    expect(validateRunLine(good)).toEqual({ ok: true });
    expect(validateRunLine({ t: 'x', stream: 'stderr', line: 'y' }).ok).toBe(false); // 缺 seq
    expect(validateRunLine({ seq: 0, t: 'x', stream: 'stderr', line: 'y' }).ok).toBe(false); // seq < 1
    expect(validateRunLine({ seq: 1, t: 'x', stream: 'stderr', line: 'y', extra: 1 }).ok).toBe(false);
  });

  it('validateCommandResult：合法通过；data 类型错拒绝', () => {
    const good = { ok: true, code: 'OK', message: 'm', data: null, exitCode: 0 };
    expect(validateCommandResult(good)).toEqual({ ok: true });
    const bad = validateCommandResult({ ok: true, code: 'OK', message: 'm', data: 'string', exitCode: 0 });
    expect(bad.ok).toBe(false);
    expect(validateCommandResult({ ok: true, code: 'OK', message: 'm', data: null, exitCode: '2' }).ok).toBe(false);
  });

  it('validateAssemblyShape：合法 assembly 通过；缺 plugins 拒绝', () => {
    const good = {
      hotpack: '1.0', id: 'x', name: 'n', version: '1.0.0', plugins: [
        { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }
      ]
    };
    expect(validateAssemblyShape(good)).toEqual({ ok: true });
    expect(validateAssemblyShape({ hotpack: '1.0', id: 'x', plugins: [] }).ok).toBe(false);
  });

  it('assemblySchema/cordisPatchSchema 与运行时校验器在可表达子集上一致（根治：形状佐证不得比运行时更松）', () => {
    const ajv = new Ajv({ allErrors: true });
    const vPatch = ajv.compile(cordisPatchSchema);
    const vAsm = ajv.compile(assemblySchema);
    // cordisPatch：可表达子集（非空数组 / id 字符集与长度 / name 非空白 / NUL 拒绝）
    const badPatches = [
      [], // 空顶层数组（运行时 reject）
      [{ insert: [{ id: '', name: 'x', config: {} }] }], // 空 id
      [{ insert: [{ id: 'a\u0000b', name: 'x', config: {} }] }], // NUL
      [{ insert: [{ id: 'a', name: '  ', config: {} }] }], // 空白 name
      [{ insert: [{ id: 'a', name: 'x', config: [] }] }], // 数组 config
    ];
    for (const doc of badPatches) {
      expect(vPatch(doc), JSON.stringify(doc)).toBe(false);
      expect(validatePatchDocument(doc).ok, JSON.stringify(doc)).toBe(false);
    }
    // 合法 patch 双方都接受（schema 不得假拒绝运行时接受的输入）
    const goodPatch = [{ insert: [{ id: 'hp-pack-p1', name: 'pkg-a', config: {} }] }];
    expect(vPatch(goodPatch)).toBe(true);
    expect(validatePatchDocument(goodPatch).ok).toBe(true);
    // assembly：name 非空白 / version 精确形状
    const badAsm = { hotpack: '1.0', id: 'x', name: ' ', version: '1.0.0', plugins: [{ id: 'p', name: 'q', version: '1.0.0', source: { type: 'npm' } }] };
    expect(vAsm(badAsm)).toBe(false);
    // 运行时 accept ⟹ schema accept（schema 是超集：不假拒绝）
    const goodAsm = { hotpack: '1.0', id: 'x', name: 'n', version: '1.0.0', plugins: [{ id: 'p', name: 'q', version: '1.0.0', source: { type: 'npm' } }] };
    expect(vAsm(goodAsm)).toBe(true);
    expect(validateVersion('1.02.3').ok).toBe(false); // semver 双检为运行时专属（schema 无法表达）
  });
});
