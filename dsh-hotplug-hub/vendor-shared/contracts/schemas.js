'use strict';
// contracts/schemas.js — 5 个 JSON Schema（与 DSH 契约对齐）+ ajv 校验器（M-28/H-14）
//   1. assembly.json（hotpack 1.0）
//   2. state.json（schemaVersion/assemblySha256/resolved/install/launch/heal/rollback；phase enum）
//   3. cordis.patch.yml（与 DSH 契约一致）
//   4. run.jsonl（行式 + seq + 滚动 5MB）
//   5. CommandResult（ok/code/message/data/exitCode）
//
// v5 阶段 2/5（M-28/H-14）：ajv 驱动 validateAssembly/validateState/validateRunLine/
// validateCommandResult，并在 I/O 边界真正调用（launcher store/runlog/pipeline）。
const { PLUGIN_NAME_RE, EXACT_VERSION_RE } = require('./constants');
const { STATES } = require('./state-machine');
const Ajv = require('ajv');

const assemblySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'dsh-hotplug-launcher/assembly.schema.json',
  title: 'Hotpack Assembly 1.0',
  type: 'object',
  required: ['hotpack', 'id', 'name', 'version', 'plugins'],
  additionalProperties: true,
  properties: {
    hotpack: { const: '1.0' },
    // C1 修复：pattern 显式表达大小写不敏感（PACK_ID_RE 带 /i 标志，
    // 而 regex.source 不带标志——此前 schema 拒绝运行时接受的 'MyPack'）
    id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$', maxLength: 64 },
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', pattern: EXACT_VERSION_RE.source },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    plugins: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/definitions/plugin' }
    }
  },
  definitions: {
    plugin: {
      type: 'object',
      required: ['id', 'name', 'source'],
      additionalProperties: true,
      properties: {
        // C1 修复：与 ids.validatePluginId（/i）一致的大小写不敏感 pattern
        id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$', maxLength: 64 },
        name: { type: 'string', pattern: PLUGIN_NAME_RE.source },
        version: { type: 'string' },
        source: { $ref: '#/definitions/source' },
        config: { type: 'object' }
      }
    },
    source: {
      type: 'object',
      required: ['type'],
      additionalProperties: true,
      properties: {
        type: { enum: ['npm', 'path', 'github'] },
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        // C2 修复：repo 长度预算与运行时 validateSourceRepo（512）对齐
        repo: { type: 'string', minLength: 1, maxLength: 512 },
        ref: { type: 'string', minLength: 1, maxLength: 256 }
      }
    }
  }
};

const stateSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'dsh-hotplug-launcher/state.schema.json',
  title: 'Hotplug Runtime State',
  type: 'object',
  // FIX-20：required 与 createEmptyState 实际字段对齐（assemblySha256/rollback 为必填）
  required: ['schemaVersion', 'id', 'assemblySha256', 'resolved', 'install', 'launch', 'heal', 'rollback'],
  additionalProperties: true,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string' },
    assemblySha256: { type: ['string', 'null'] },
    // H-14（v5）：phase 枚举对齐状态机 STATES
    phase: { enum: Object.keys(STATES) },
    resolved: {
      type: 'object',
      required: ['plugins', 'conflicts'],
      properties: {
        plugins: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'name', 'source'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              version: { type: ['string', 'null'] },
              resolvedVersion: { type: ['string', 'null'] },
              pinned: { type: 'boolean' },
              installPath: { type: ['string', 'null'] },
              ref: { type: ['string', 'null'] },
              source: { type: 'object' },
              config: { type: 'object' }
            }
          }
        },
        conflicts: { type: 'array', items: { type: 'object' } },
        pinnedAt: { type: ['string', 'null'] }
      }
    },
    install: {
      type: 'object',
      required: ['status', 'lastExit', 'nodeModules'],
      properties: {
        status: { enum: ['missing', 'ok', 'failed'] },
        lastExit: { type: ['integer', 'null'] },
        nodeModules: { type: 'boolean' }
      }
    },
    launch: {
      type: 'object',
      properties: {
        lastExit: { type: ['integer', 'null'] },
        lastStart: { type: ['string', 'null'] },
        retries: { type: 'integer' },
        pid: { type: ['integer', 'null'] }
      }
    },
    heal: {
      type: 'object',
      required: ['history', 'quarantined'],
      properties: {
        history: {
          type: 'array',
          items: {
            type: 'object',
            required: ['at', 'code', 'action', 'verified'],
            properties: {
              at: { type: 'string' },
              code: { type: 'string' },
              action: { type: 'string' },
              verified: { type: 'boolean' },
              dryRun: { type: 'boolean' },
              error: { type: ['string', 'null'] }
            }
          }
        },
        quarantined: { type: 'array', items: { type: 'string' } }
      }
    },
    rollback: {
      type: 'object',
      properties: {
        snapshot: { type: ['object', 'null'] },
        lastRollbackAt: { type: ['string', 'null'] }
      }
    }
  }
};

const cordisPatchSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'dsh-hotplug-launcher/cordis-patch.schema.json',
  title: 'cordis.patch.yml（与 DSH 契约一致）',
  type: 'array',
  items: {
    type: 'object',
    required: ['insert'],
    additionalProperties: true,
    properties: {
      insert: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'config'],
          additionalProperties: true,
          properties: {
            id: { type: 'string', maxLength: 64 },
            name: { type: 'string' },
            config: { type: 'object' }
          }
        }
      }
    }
  }
};

const runLineSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'dsh-hotplug-launcher/run-line.schema.json',
  title: 'run.jsonl 单行记录',
  type: 'object',
  required: ['seq', 't', 'stream', 'line'],
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', minimum: 1 },
    t: { type: 'string' },
    stream: { enum: ['stdout', 'stderr', 'error'] },
    line: { type: 'string' }
  }
};

const commandResultSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'dsh-hotplug-launcher/command-result.schema.json',
  title: '命令统一返回（CommandResult）',
  type: 'object',
  required: ['ok', 'code', 'message', 'data', 'exitCode'],
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    code: { type: ['string', 'null'] },
    message: { type: 'string' },
    data: { type: ['object', 'array', 'null'] },
    exitCode: { type: 'integer' }
  }
};

const SCHEMAS = {
  assembly: assemblySchema,
  state: stateSchema,
  cordisPatch: cordisPatchSchema,
  runLine: runLineSchema,
  commandResult: commandResultSchema
};

// --- ajv 校验器（M-28/H-14：I/O 边界真正调用；validateState/validateRunLine 等） ---

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * 校验 state 对象（读路径边界，H-14；phase enum 校验）。
 * @param {unknown} value
 * @returns {{ok: boolean, errors?: Array<string>}}
 */
function validateState(value) {
  const validate = ajv.getSchema('dsh-hotplug-launcher/state.schema.json') || ajv.compile(stateSchema);
  const ok = validate(value);
  return ok ? { ok: true } : { ok: false, errors: (validate.errors || []).map((e) => e.message || 'schema error') };
}

/**
 * 校验 run.jsonl 单行（写路径边界，M-28）。
 * @param {unknown} value
 * @returns {{ok: boolean, errors?: Array<string>}}
 */
function validateRunLine(value) {
  const validate = ajv.getSchema('dsh-hotplug-launcher/run-line.schema.json') || ajv.compile(runLineSchema);
  const ok = validate(value);
  return ok ? { ok: true } : { ok: false, errors: (validate.errors || []).map((e) => e.message || 'schema error') };
}

/**
 * 校验 CommandResult（返回边界，M-28）。
 * @param {unknown} value
 * @returns {{ok: boolean, errors?: Array<string>}}
 */
function validateCommandResult(value) {
  const validate = ajv.getSchema('dsh-hotplug-launcher/command-result.schema.json') || ajv.compile(commandResultSchema);
  const ok = validate(value);
  return ok ? { ok: true } : { ok: false, errors: (validate.errors || []).map((e) => e.message || 'schema error') };
}

/**
 * 校验 assembly 输入（parseHotpack 已做运行时校验；此处为 I/O 边界的 schema 佐证）。
 * @param {unknown} value
 * @returns {{ok: boolean, errors?: Array<string>}}
 */
function validateAssemblyShape(value) {
  const validate = ajv.getSchema('dsh-hotplug-launcher/assembly.schema.json') || ajv.compile(assemblySchema);
  const ok = validate(value);
  return ok ? { ok: true } : { ok: false, errors: (validate.errors || []).map((e) => e.message || 'schema error') };
}

module.exports = {
  assemblySchema,
  stateSchema,
  cordisPatchSchema,
  runLineSchema,
  commandResultSchema,
  SCHEMAS,
  validateState,
  validateRunLine,
  validateCommandResult,
  validateAssemblyShape
};
