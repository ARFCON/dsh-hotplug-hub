'use strict';
// test/schemas.test.js — 5 个 JSON Schema 结构契约 + 4 个 ajv 校验器（M-28/H-14）
const {
  assemblySchema, stateSchema, cordisPatchSchema, runLineSchema, commandResultSchema, SCHEMAS,
  validateState, validateRunLine, validateCommandResult, validateAssemblyShape
} = require('../contracts/schemas');

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
});
