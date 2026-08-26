'use strict';
// fs/utf8.js — UTF-8 有效性判定（单一真源，Node ≥18 兼容）
//
// 权威判定优先用 node:buffer 的 isUtf8（Node 18.14+ 命名导出）；低于该版本时回退
// 手写严格 UTF-8 校验器（RFC 3629）。
//
// 审计修复（本轮根治）：
//   - 根因 1：此前用 `Buffer.isUtf8`（全局 Buffer 对象上并不存在该静态方法，恒为
//     undefined），导致「优先权威实现」分支永远不生效，实际一直走手写回退；
//   - 根因 2：手写回退缺少「过长编码（C0/C1、E0 80-9F、F0 80-8F）/ 代理区（ED A0-BF）/
//     超 U+10FFFF（F4 90-BF）」判定，把非法字节序列误判为合法 UTF-8。下游
//     fs/snapshot 据此把二进制文件误内联为 UTF-8 字符串（toString 产生 U+FFFD），
//     回滚时哈希不匹配 → 数据丢失；launcher infra/monitor 据此漏报 UTF-8 损坏信号。
//
// 权威实现（node:buffer.isUtf8）与手写实现（isValidUtf8Manual）的一致性由
// test/utf8.test.js 大语料模糊断言锁定，两者对同一输入必须恒同判。
const { isUtf8: nodeIsUtf8 } = require('node:buffer');

/**
 * 手写严格 UTF-8 校验（RFC 3629；node:buffer 无 isUtf8 时的回退实现）。
 *
 * 规则（逐字节）：
 *   - 0x00-0x7F：ASCII，1 字节；
 *   - 0xC2-0xDF：2 字节，次字节 0x80-0xBF（0xC0/0xC1 为过长编码，拒绝）；
 *   - 0xE0：3 字节，次字节 0xA0-0xBF（0x80-0x9F 为过长编码），三字节 0x80-0xBF；
 *   - 0xE1-0xEC：3 字节，次/三字节 0x80-0xBF；
 *   - 0xED：3 字节，次字节 0x80-0x9F（0xA0-0xBF 为 UTF-16 代理区 U+D800-U+DFFF，拒绝）；
 *   - 0xEE-0xEF：3 字节，次/三字节 0x80-0xBF；
 *   - 0xF0：4 字节，次字节 0x90-0xBF（0x80-0x8F 为过长编码），三/四字节 0x80-0xBF；
 *   - 0xF1-0xF3：4 字节，次/三/四字节 0x80-0xBF；
 *   - 0xF4：4 字节，次字节 0x80-0x8F（0x90-0xBF 超出 U+10FFFF，拒绝），三/四字节 0x80-0xBF；
 *   - 0x80-0xC1（孤立续字节/过长前导）与 0xF5-0xFF：拒绝。
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isValidUtf8Manual(buf) {
  let i = 0;
  while (i < buf.length) {
    const b0 = buf[i];
    if (b0 < 0x80) {
      i += 1;
      continue;
    }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
      continue;
    }
    if (b0 === 0xe0) {
      if (i + 2 >= buf.length || buf[i + 1] < 0xa0 || buf[i + 1] > 0xbf || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
      continue;
    }
    if (b0 >= 0xe1 && b0 <= 0xec) {
      if (i + 2 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
      continue;
    }
    if (b0 === 0xed) {
      if (i + 2 >= buf.length || buf[i + 1] < 0x80 || buf[i + 1] > 0x9f || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
      continue;
    }
    if (b0 >= 0xee && b0 <= 0xef) {
      if (i + 2 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
      continue;
    }
    if (b0 === 0xf0) {
      if (i + 3 >= buf.length || buf[i + 1] < 0x90 || buf[i + 1] > 0xbf || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) return false;
      i += 4;
      continue;
    }
    if (b0 >= 0xf1 && b0 <= 0xf3) {
      if (i + 3 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) return false;
      i += 4;
      continue;
    }
    if (b0 === 0xf4) {
      if (i + 3 >= buf.length || buf[i + 1] < 0x80 || buf[i + 1] > 0x8f || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) return false;
      i += 4;
      continue;
    }
    // 0x80-0xC1（孤立续字节 / 过长前导）与 0xF5-0xFF（超出 UTF-8 范围）
    return false;
  }
  return true;
}

/**
 * 严格 UTF-8 校验：优先 node:buffer.isUtf8（权威实现），回退手写实现。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isValidUtf8(buf) {
  if (typeof nodeIsUtf8 === 'function') return nodeIsUtf8(buf);
  return isValidUtf8Manual(buf);
}

module.exports = { isValidUtf8, isValidUtf8Manual };
