'use strict';
// infra/monitor.js — UTF-8 分块拼接 + 按行 JSONL
//
// 审计修复：N36（多字节字符被 chunk 边界切断 → U+FFFD）—
// 字节级 carry：只对"完整行"解码（拿到换行符才解码），
// 半行字节始终保留在 pending Buffer 中，跨 chunk 安全。
//
// CRLF 处理：行尾 \r 剥除（Windows 特判）。

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

/**
 * 创建行解码器。
 * @returns {object} { push, flush, hasPending }
 */
function createLineDecoder() {
  let pending = Buffer.alloc(0);

  /**
   * 推入一个 chunk，返回本次产出的完整行（不含换行）。
   * @param {Buffer|string} chunk
   * @returns {Array<string>}
   */
  function push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    pending = Buffer.concat([pending, buf]);
    const lines = [];
    let idx = -1;
    while ((idx = pending.indexOf(0x0a)) !== -1) {
      const raw = pending.subarray(0, idx);
      pending = pending.subarray(idx + 1);
      // 剥除 \r
      const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
      lines.push(line.toString('utf8'));
    }
    return lines;
  }

  /**
   * 冲刷剩余半行（流结束时调用）。
   * 若尾部为残缺多字节序列（FIX-13），返回 UTF8_CORRUPTION 信号而非 U+FFFD 字符串。
   * @returns {Array<string|{__corrupt: true, buffer: Buffer}>}
   */
  function flush() {
    if (pending.length === 0) return [];
    const line = pending;
    pending = Buffer.alloc(0);
    if (!isValidUtf8(line)) {
      // 残缺多字节：不产生 U+FFFD 内容，标记 UTF8_CORRUPTION 信号（heal 可捕获）
      return [{ __corrupt: true, buffer: line }];
    }
    return [line.toString('utf8')];
  }

  function hasPending() {
    return pending.length > 0;
  }

  return { push, flush, hasPending };
}

/**
 * 将子进程 stdout/stderr 管道接入 runlog。
 * @param {object} child 子进程对象（含 stdout/stderr EventEmitter）
 * @param {object} runLog createRunLog 产物
 * @param {object} [opts]
 * @param {Function} [opts.onLine] (stream, line) => void 可选回调
 * @returns {void}
 */
function pipeChildToLog(child, runLog, opts = {}) {
  const onLine = opts.onLine || null;
  const decoders = {
    stdout: createLineDecoder(),
    stderr: createLineDecoder()
  };
  const attach = (streamName) => {
    const stream = child[streamName];
    if (!stream) return;
    stream.on('data', (d) => {
      for (const line of decoders[streamName].push(d)) {
        const r = runLog.append({ stream: streamName, line });
        if (!r.ok && onLine) onLine('error', r.error.message);
        if (onLine) onLine(streamName, line);
      }
    });
    stream.on('end', () => {
      for (const line of decoders[streamName].flush()) {
        if (line && line.__corrupt) {
          // FIX-13：残缺多字节尾随 → 记录 UTF8_CORRUPTION 信号（不写 U+FFFD 内容）
          const msg = '检测到 UTF-8 损坏（流结束时残缺多字节序列）';
          const r = runLog.append({ stream: 'error', line: msg });
          if (!r.ok && onLine) onLine('error', r.error.message);
          if (onLine) onLine(streamName, `[UTF8_CORRUPTION] ${msg}`);
          continue;
        }
        const r = runLog.append({ stream: streamName, line });
        if (!r.ok && onLine) onLine('error', r.error.message);
        if (onLine) onLine(streamName, line);
      }
    });
  };
  attach('stdout');
  attach('stderr');
}

module.exports = { createLineDecoder, pipeChildToLog, isValidUtf8 };
