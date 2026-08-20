'use strict';
// infra/runlog.js — JSONL 行式日志（seq 递增 + 5MB 滚动）
//
// 审计修复：M/X22（按行分条、不 trim 内容）/ N46（滚动上限防打满磁盘）。
// C4 修复：
//   - loadSeq 对"末行部分写入/损坏"回退扫描最后合法完整行并截断坏尾，
//     新进程 seq 从断点续写（不再从 1 重来产生重复 seq）；
//   - rotate 后新文件首条 seq 从 .1 末行续取（跨滚动全局递增）；
//   - list({includeRotated:true}) 合并 .1（logs 命令可读滚动前条目）。
const path = require('path');
const { RUNLOG_MAX_BYTES } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');

/**
 * 创建 run.jsonl 日志器。
 * @param {object} fsPort fs 端口
 * @param {string} logFile run.jsonl 路径
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] 滚动上限（默认 5MB）
 * @param {Function} [opts.now] 时钟注入
 * @returns {object} { append, list, rotate, file }
 */
function createRunLog(fsPort, logFile, opts = {}) {
  const maxBytes = opts.maxBytes === undefined ? RUNLOG_MAX_BYTES : opts.maxBytes;
  const now = opts.now || Date.now;
  let seq = 0;

  /**
   * 在字节缓冲区中从尾部向前扫描最后一个合法 JSON 行（含 seq 字段）。
   * C6 修复：返回 keepEnd（该行终止换行之后的绝对字节偏移）；全文件/窗口通用。
   * @param {Buffer} buf
   * @param {number} baseOffset buf 在文件中的起始偏移
   * @returns {{seq: number|null, keepEnd: number}}
   */
  function scanForLastValidLine(buf, baseOffset) {
    let lineStart = buf.length; // 当前行段结束位置（独占）
    for (let i = buf.length - 1; i >= 0; i -= 1) {
      if (buf[i] === 0x0a) {
        const raw = buf.subarray(i + 1, lineStart);
        const text = raw.toString('utf8');
        if (text.trim()) {
          try {
            const parsed = JSON.parse(text);
            if (Number.isInteger(parsed.seq)) {
              return { seq: parsed.seq, keepEnd: baseOffset + lineStart + 1 };
            }
          } catch (_) { /* 坏行继续向前 */ }
        }
        lineStart = i;
      }
    }
    // 首段（0..lineStart）本身可能是一条完整合法行（缓冲区起点即行首）
    if (lineStart > 0) {
      const firstLine = buf.subarray(0, lineStart).toString('utf8');
      if (firstLine.trim()) {
        try {
          const parsed = JSON.parse(firstLine);
          if (Number.isInteger(parsed.seq)) {
            return { seq: parsed.seq, keepEnd: baseOffset + lineStart + 1 };
          }
        } catch (_) { /* 忽略 */ }
      }
    }
    return { seq: null, keepEnd: -1 };
  }

  /**
   * 读取文件尾部最后一个可解析的 JSON 行（含 seq 字段），并返回
   * { seq, truncated }——truncated 表示末尾存在部分写入的坏尾（已被截断）。
   * C6 修复：先扫尾部 4096B 窗口；窗口内无合法行（如 >4096B 的未换行坏尾）
   * 时回退全文件扫描，保证 seq 跨进程恢复不丢失。
   * @returns {{seq: number, truncated: boolean}}
   */
  function loadSeqFromFile(file) {
    if (!file || !fsPort.existsSync(file)) return { seq: 0, truncated: false };
    try {
      const stat = fsPort.statSync(file);
      if (stat.size === 0) return { seq: 0, truncated: false };
      const fd = fsPort.openSync(file, 'r');
      try {
        const windowStart = Math.max(0, stat.size - 4096);
        let buf = Buffer.alloc(stat.size - windowStart);
        fsPort.readSync(fd, buf, 0, buf.length, windowStart);
        let found = scanForLastValidLine(buf, windowStart);
        if (found.seq === null && windowStart > 0) {
          // 罕见路径：坏尾吞掉整个窗口（单行 >4096B 未换行）→ 全文件扫描
          buf = Buffer.alloc(stat.size);
          fsPort.readSync(fd, buf, 0, buf.length, 0);
          found = scanForLastValidLine(buf, 0);
        }
        const truncated = found.seq !== null && found.keepEnd >= 0 && found.keepEnd < stat.size;
        return { seq: found.seq || 0, truncated };
      } finally {
        fsPort.closeSync(fd);
      }
    } catch (_) {
      return { seq: 0, truncated: false };
    }
  }

  /**
   * 首次追加时恢复 seq（C4 修复：主文件缺失/为空时回退 .1；坏尾截断后从断点续写）。
   */
  function loadSeq() {
    if (seq > 0) return;
    const main = loadSeqFromFile(logFile);
    if (main.seq > 0) {
      seq = main.seq;
      if (main.truncated) truncateBadTail(logFile);
      return;
    }
    // 主文件无有效 seq（新文件/被滚动）→ 从 .1 末行续取（跨滚动全局递增）
    const rotated = loadSeqFromFile(logFile + '.1');
    if (rotated.seq > 0) seq = rotated.seq;
  }

  /** 截断损坏尾部（字节精确）：保留最后一个合法完整行及其换行符，其后内容截断。 */
  function truncateBadTail(file) {
    try {
      const fd = fsPort.openSync(file, 'r+');
      try {
        const stat = fsPort.statSync(file);
        if (stat.size === 0) return;
        // C6 修复：全文件扫描定位最后合法行边界（窗口方案对 >4096B 坏尾失效）
        const buf = Buffer.alloc(stat.size);
        fsPort.readSync(fd, buf, 0, buf.length, 0);
        const found = scanForLastValidLine(buf, 0);
        if (found.keepEnd >= 0 && found.keepEnd < stat.size) {
          fsPort.ftruncateSync(fd, found.keepEnd);
        }
      } finally {
        fsPort.closeSync(fd);
      }
    } catch (_) { /* 截断失败不影响主流程 */ }
  }

  function rotate() {
    const old = logFile + '.1';
    if (fsPort.existsSync(old)) fsPort.unlinkSync(old);
    if (fsPort.existsSync(logFile)) fsPort.renameSync(logFile, old);
  }

  /**
   * 追加一条结构化日志。
   * @param {object} entry { stream, line, ... }
   * @returns {{ok: boolean, seq?: number, error?: Error}}
   */
  function append(entry) {
    try {
      loadSeq();
      seq += 1;
      fsPort.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fsPort.existsSync(logFile)) {
        const st = fsPort.statSync(logFile);
        if (st.size >= maxBytes) rotate();
      }
      const line = JSON.stringify({
        seq,
        t: new Date(now()).toISOString(),
        stream: entry.stream || 'stdout',
        line: String(entry.line === undefined ? '' : entry.line)
      });
      fsPort.appendFileSync(logFile, line + '\n', 'utf8');
      return { ok: true, seq };
    } catch (e) {
      return { ok: false, error: makeError('ERR_LOG_WRITE', `日志写入失败 ${logFile}：${e.message}`) };
    }
  }

  /**
   * 读取条目（坏行跳过；读取失败返回 []，FIX-22 不抛异常）。
   * @param {object} [opts]
   * @param {boolean} [opts.includeRotated] 是否合并滚动文件 .1（logs 命令用；
   *   默认 false——heal 分类只读当前窗口，避免陈旧故障行触发幻影自愈）
   * @returns {Array<object>}
   */
  function list(opts = {}) {
    const out = [];
    if (opts.includeRotated) {
      readFileEntries(logFile + '.1', out);
    }
    readFileEntries(logFile, out);
    return out;
  }

  function readFileEntries(file, out) {
    if (!file || !fsPort.existsSync(file)) return;
    let text;
    try {
      text = fsPort.readFileSync(file, 'utf8');
    } catch (_) {
      return; // 读取失败（权限/占用）按空处理，不崩 CLI
    }
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw));
      } catch (_) { /* 坏行跳过 */ }
    }
  }

  return { append, list, rotate, file: logFile };
}

module.exports = { createRunLog };
