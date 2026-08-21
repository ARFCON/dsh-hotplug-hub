'use strict';
// fs/utf8.js — UTF-8 有效性判定（自 launcher infra/monitor.js 原样搬移，零改动）

/**
 * 严格 UTF-8 校验（Buffer.isUtf8 为 Node 20+ API；手写回退兼容 Node 18）。
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isValidUtf8(buf) {
  if (typeof Buffer.isUtf8 === 'function') return Buffer.isUtf8(buf);
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 >= buf.length || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2; continue;
    }
    if (b >= 0xe0 && b <= 0xef) {
      if (i + 2 >= buf.length) return false;
      for (let k = 1; k <= 2; k += 1) if ((buf[i + k] & 0xc0) !== 0x80) return false;
      i += 3; continue;
    }
    if (b >= 0xf0 && b <= 0xf4) {
      if (i + 3 >= buf.length) return false;
      for (let k = 1; k <= 3; k += 1) if ((buf[i + k] & 0xc0) !== 0x80) return false;
      i += 4; continue;
    }
    return false;
  }
  return true;
}

module.exports = { isValidUtf8 };
