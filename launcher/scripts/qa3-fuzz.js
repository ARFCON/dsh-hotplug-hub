'use strict';
// scripts/qa3-fuzz.js — 模糊测试（QA3 第 3 层主题 14）
// 对 ids.validateId / isWithin / conflicts.checkConflicts / classify.classifySignal / patch.serializePatch
// 做随机字符串模糊测试（每目标 500 例）：不抛未捕获异常、返回结构正确、不产生越界路径。
// 用法：node scripts/qa3-fuzz.js [n]
// 退出码：0=全部通过；1=存在失败项
const { validateId, isWithin, normalizeAndAssert } = require('../domain/ids');
const { checkConflicts } = require('../domain/conflicts');
const { classifySignal, classifyEntries } = require('../domain/classify');
const { serializePatch } = require('../domain/patch');
const os = require('os');
const path = require('path');

const N = Number(process.argv[2] || 500);
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push({ name, detail }); }
}

// 随机字符串生成器（覆盖控制字符/Unicode/分隔符/超长）
function randString(rng) {
  const pools = [
    'abcXYZ019._-', '..\\/:%', '\u0000\u001f\u007f', '中🎉é', ' \t\n', '@!*#|>',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-'
  ];
  const pool = pools[rng() % pools.length];
  const len = rng() % 80;
  let s = '';
  for (let i = 0; i < len; i += 1) s += pool[rng() % pool.length];
  if (rng() % 20 === 0) s += '..'; // 注入穿越特征
  if (rng() % 20 === 0) s = 'a'.repeat(rng() % 100); // 注入超长
  return s;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

console.log(`== QA3 模糊测试（每目标 ${N} 例，种子固定可复现）==`);

// 1) validateId：不抛异常、返回 {ok, id?/error?}、ok 时 id 原样
{
  const rng = mulberry32(20260820);
  let okCount = 0;
  for (let i = 0; i < N; i += 1) {
    const s = randString(rng);
    let r;
    try {
      r = validateId(s);
    } catch (e) {
      check(`validateId 不抛异常 #${i}`, false, `输入=${JSON.stringify(s)} 异常=${e.message}`);
      continue;
    }
    check(`validateId 返回结构 #${i}`, r && typeof r.ok === 'boolean' && (r.ok ? r.id === s : r.error && r.error.code), `输入=${JSON.stringify(s)}`);
    if (r.ok) {
      okCount += 1;
      // ok 时 id 必须通过白名单正则（结构自洽）
      check(`validateId ok 时匹配白名单 #${i}`, /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s), `输入=${JSON.stringify(s)}`);
    }
  }
  console.log(`validateId: ${N} 例（ok=${okCount}）`);
}

// 2) normalizeAndAssert：不抛异常；ok 时拼接路径必须在 root 内（零越界）
// A2 修复：原断言用「输入 s 重算路径」验证 isWithin——白名单已蕴含无穿越，属恒真自洽；
// 改为用「函数返回的 id」重拼路径校验，能发现函数返回语义回归；并在结束后清理 root。
{
  const rng = mulberry32(20260821);
  const root = path.join(os.tmpdir(), 'qa3-fuzz-root-' + Date.now());
  require('fs').mkdirSync(root, { recursive: true });
  let okCount = 0;
  try {
    for (let i = 0; i < N; i += 1) {
      const s = randString(rng);
      let r;
      try {
        r = normalizeAndAssert(s, root);
      } catch (e) {
        check(`normalizeAndAssert 不抛异常 #${i}`, false, `输入=${JSON.stringify(s)} 异常=${e.message}`);
        continue;
      }
      check(`normalizeAndAssert 返回结构 #${i}`, r && typeof r.ok === 'boolean', `输入=${JSON.stringify(s)}`);
      if (r.ok) {
        okCount += 1;
        const target = path.join(root, r.id);
        check(`normalizeAndAssert ok 时零越界 #${i}`, isWithin(root, target), `输入=${JSON.stringify(s)} target=${target}`);
      }
    }
  } finally {
    try { require('fs').rmSync(root, { recursive: true, force: true }); } catch (_) { /* ok */ }
  }
  console.log(`normalizeAndAssert: ${N} 例（ok=${okCount}）`);
}

// 3) checkConflicts：随机插件列表不抛异常、返回 {ok, conflicts[]}
{
  const rng = mulberry32(20260822);
  for (let i = 0; i < N; i += 1) {
    const n = (rng() % 5) + 1;
    const plugins = [];
    for (let j = 0; j < n; j += 1) {
      plugins.push({
        id: 'p' + j,
        name: randString(rng),
        source: { type: 'npm' },
        resolvedVersion: [null, '1.0.0', '1.2.3-beta.1', '^2.0.0', randString(rng)][rng() % 5],
        version: null,
        config: { role: rng() % 2 ? randString(rng) : undefined, dependencies: rng() % 3 ? { [randString(rng)]: randString(rng) } : {} }
      });
    }
    let r;
    try {
      r = checkConflicts(plugins);
    } catch (e) {
      check(`checkConflicts 不抛异常 #${i}`, false, `异常=${e.message}`);
      continue;
    }
    check(`checkConflicts 返回结构 #${i}`, r && typeof r.ok === 'boolean' && Array.isArray(r.conflicts), JSON.stringify(r).slice(0, 80));
  }
  console.log(`checkConflicts: ${N} 例`);
}

// 4) classifySignal / classifyEntries：随机输入不抛异常、返回 null 或 {code,action,suggest}
{
  const rng = mulberry32(20260823);
  for (let i = 0; i < N; i += 1) {
    const signal = {
      kind: ['stderr', 'stdout', 'exit', 'spawn-error', 'log', randString(rng)][rng() % 6],
      line: randString(rng),
      exitCode: rng() % 3,
      severity: ['error', 'info', randString(rng)][rng() % 3],
      message: randString(rng),
      err: { code: ['ENOENT', 'EACCES', randString(rng)][rng() % 3], message: randString(rng) }
    };
    let r;
    try {
      r = classifySignal(signal);
    } catch (e) {
      check(`classifySignal 不抛异常 #${i}`, false, `异常=${e.message}`);
      continue;
    }
    check(`classifySignal 返回结构 #${i}`, r === null || (r.code && r.action && typeof r.suggest === 'string'), JSON.stringify(r));
  }
  for (let i = 0; i < N; i += 1) {
    const entries = Array.from({ length: rng() % 4 }, () => ({
      seq: rng(), stream: ['stdout', 'stderr', 'error', randString(rng)][rng() % 4], line: randString(rng)
    }));
    let r;
    try {
      r = classifyEntries(entries);
    } catch (e) {
      check(`classifyEntries 不抛异常 #${i}`, false, `异常=${e.message}`);
      continue;
    }
    check(`classifyEntries 返回结构 #${i}`, Array.isArray(r), JSON.stringify(r).slice(0, 80));
  }
  console.log(`classifySignal/classifyEntries: ${N * 2} 例`);
}

// 5) serializePatch：随机 pack 不抛异常、返回结构正确；ok 时产物可 yaml.parse
{
  const YAML = require('yaml');
  const rng = mulberry32(20260824);
  let okCount = 0;
  for (let i = 0; i < N; i += 1) {
    const n = (rng() % 4) + 1;
    const plugins = [];
    for (let j = 0; j < n; j += 1) {
      plugins.push({
        id: randString(rng) || 'p' + j,
        name: randString(rng) || 'n' + j,
        version: '1.0.0',
        source: { type: 'npm' },
        config: rng() % 2 ? { k: randString(rng), n: rng() % 100, b: rng() % 2 === 0 } : {}
      });
    }
    const pack = { hotpack: '1.0', id: 'fz', name: 'fuzz', version: '1.0.0', plugins };
    let r;
    try {
      r = serializePatch(pack);
    } catch (e) {
      check(`serializePatch 不抛异常 #${i}`, false, `异常=${e.message}`);
      continue;
    }
    check(`serializePatch 返回结构 #${i}`, r && typeof r.ok === 'boolean', JSON.stringify(r).slice(0, 80));
    if (r.ok) {
      okCount += 1;
      try {
        const parsed = YAML.parse(r.yamlText);
        check(`serializePatch ok 时可解析 #${i}`, Array.isArray(parsed) && Array.isArray(parsed[0].insert), '');
      } catch (e) {
        check(`serializePatch ok 时可解析 #${i}`, false, `yaml.parse 异常=${e.message}`);
      }
    }
  }
  console.log(`serializePatch: ${N} 例（ok=${okCount}）`);
}

console.log(`\n== 结果：PASS=${pass} FAIL=${fail} ==`);
if (fail > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
