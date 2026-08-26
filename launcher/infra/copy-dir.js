'use strict';
// infra/copy-dir.js — 目录递归复制（path 源插件降级：真实链接不可用时的回退）
//
// 审计 C 修复：旧「复制壳」仅复制 package.json，插件 main 入口代码缺失，DSH require
// 后无法加载，却仍返回 ok:true（假成功）。本模块递归复制全部文件，失败返回 {ok:false}。
// 审计 H5 修复（假成功根治）：旧实现把【符号链接/junction 条目】静默跳过——插件源码
// 若含指向自身文件的链接（或 node_modules/.bin 等），复制产物会缺文件却仍 ok:true。
// 现对链接条目【解引用复制目标内容】（文件→copyFileSync；目录→递归），彻底不丢代码；
// 环引用经 visited 实路径集合防护（防自指链接无限递归）。node_modules/.git 属派生依赖/
// VCS，不复制（由后续 install 或运行时重建）。
const path = require('path');
const { makeError } = require('../contracts/errors');

/**
 * 递归复制目录（含链接解引用），防环引用。
 * @param {object} fsPort
 * @param {string} src 源目录（path 源）
 * @param {string} dest 目标目录（profile/node_modules/<name>）
 * @param {Set<string>} [visited] 已访问的实路径集合（环防护，内部使用）
 * @returns {{ok: boolean, error?: Error}}
 */
function copyDirRecursive(fsPort, src, dest, visited = new Set()) {
  let realSrc;
  try { realSrc = fsPort.realpathSync(src); } catch (_) { realSrc = src; }
  if (visited.has(realSrc)) return { ok: true }; // 自指/环引用：已复制过，跳过防无限递归
  visited.add(realSrc);
  try {
    fsPort.mkdirSync(dest, { recursive: true });
    for (const ent of fsPort.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dest, ent.name);
      if (ent.isSymbolicLink && ent.isSymbolicLink()) {
        // 链接条目：解引用复制目标内容（不静默丢弃插件代码）
        let resolved;
        try {
          resolved = fsPort.realpathSync(s);
        } catch (e) {
          return { ok: false, error: makeError('ERR_INSTALL_FAILED', `path 源链接无法解析 ${s}：${e.message}`) };
        }
        const st = fsPort.statSync(resolved);
        if (st.isDirectory()) {
          const r = copyDirRecursive(fsPort, resolved, d, visited);
          if (!r.ok) return r;
        } else if (st.isFile()) {
          fsPort.copyFileSync(resolved, d);
        } // 其它类型（socket 等）非插件代码，跳过
      } else if (ent.isDirectory()) {
        // 派生依赖/VCS 不复制：插件自身的 node_modules 由依赖解析重建，.git 非运行所需
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const r = copyDirRecursive(fsPort, s, d, visited);
        if (!r.ok) return r;
      } else if (ent.isFile()) {
        fsPort.copyFileSync(s, d);
      } // 其它条目（socket/fifo）跳过——非插件代码
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `path 源目录复制失败：${e.message}`) };
  } finally {
    visited.delete(realSrc);
  }
}

module.exports = { copyDirRecursive };
