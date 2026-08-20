'use strict';
// scripts/depcheck.js — 校验所有 require() 的外部依赖已声明于 package.json
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git']);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {})
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const found = new Set();
for (const file of walk(ROOT, [])) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m = null;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
}

const missing = [...found].filter((mod) => {
  if (builtins.has(mod)) return false;
  if (mod.startsWith('.') || mod.startsWith('/')) return false; // 相对/绝对路径
  // 子路径导入（如 vitest/config）归一到根包判断
  const root = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
  if (declared.has(root)) return false;
  return true;
}).sort();

if (missing.length > 0) {
  console.error('depcheck 失败：以下依赖未在 package.json 声明：');
  for (const mod of missing) console.error('  - ' + mod);
  process.exit(1);
}
console.log(`depcheck OK: 共发现 ${found.size} 个 require()，全部已声明或为内建模块`);
