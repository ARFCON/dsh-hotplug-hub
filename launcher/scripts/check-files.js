'use strict';
// scripts/check-files.js — 轻量 lint：行数上限、占位符禁用、UTF-8 干净性
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAX_LINES = 300;
const SKIP = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['package-lock.json']);
// 占位符模式（用 charCode 拼接，避免脚本自匹配）
const BAD_PATTERNS = [
  { re: /TODO\s*[:：]/, name: 'TODO 占位' },
  { re: new RegExp(String.fromCharCode(0x5f85) + String.fromCharCode(0x5b9e) + String.fromCharCode(0x73b0)), name: '待实现占位' },
  { re: /^\s*\.\.\.\s*;?$/m, name: '省略号占位' },
  { re: /^\s*pass\s*;?$/m, name: 'pass 占位' }
];
// 占位符检查跳过自身，避免自匹配
const SELF = __filename;

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs') || ent.name.endsWith('.json')) out.push(p);
  }
  return out;
}

let failed = false;
const files = walk(ROOT, []).filter((p) => !SKIP_FILES.has(path.basename(p)));
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    console.error(`FAIL ${rel}: ${lines.length} 行 > ${MAX_LINES} 行`);
    failed = true;
  }
  if (file !== SELF) {
    for (const { re, name } of BAD_PATTERNS) {
      if (re.test(text)) {
        console.error(`FAIL ${rel}: 匹配占位符模式「${name}」`);
        failed = true;
      }
    }
  }
  if (text.includes('\uFFFD')) {
    console.error(`FAIL ${rel}: 含 U+FFFD（UTF-8 损坏）`);
    failed = true;
  }
}

if (failed) {
  console.error('lint 失败：请修复后重试');
  process.exit(1);
}
console.log(`lint OK: ${files.length} 个文件 ≤${MAX_LINES} 行、无占位符、UTF-8 干净`);
