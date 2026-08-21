'use strict';
// test/esm-shim.test.js — ESM 垫片再导出集合 == CJS 全导出（铁律 B 防漂移）
const path = require('path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('child_process');

describe('ESM 垫片（index.mjs）', () => {
  it('再导出集合与 CJS 全导出一致（且值同引用）', () => {
    const cjs = require('../index.js');
    const cjsKeys = Object.keys(cjs).sort();
    // 在子进程中加载 ESM 垫片并输出命名导出集合 + 与 CJS 的引用同一性
    const script = `
      import { pathToFileURL } from 'node:url'
      import { createRequire } from 'node:module'
      import * as esm from ${JSON.stringify('esm-shim-target')}
      const require = createRequire(import.meta.url)
      const cjs = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))})
      const esmKeys = Object.keys(esm).filter((k) => k !== 'default').sort()
      const cjsKeys = Object.keys(cjs).sort()
      const sameKeys = JSON.stringify(esmKeys) === JSON.stringify(cjsKeys)
      const sameRefs = esmKeys.every((k) => esm[k] === cjs[k])
      console.log(JSON.stringify({ esmKeys, cjsKeys, sameKeys, sameRefs }))
    `.replace('"esm-shim-target"', JSON.stringify(pathToFileURL(path.join(__dirname, '..', 'index.mjs')).href));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const result = JSON.parse(out.trim().split('\n').pop());
    expect(result.sameKeys).toBe(true);
    expect(result.sameRefs).toBe(true);
    expect(result.esmKeys.length).toBe(cjsKeys.length);
  });
});
