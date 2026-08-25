'use strict';
// fs/runlog.js — JSONL 行式日志（seq 递增 + 5MB 滚动）
//
// 审计修复：M/X22（按行分条、不 trim 内容）/ N46（滚动上限防打满磁盘）。
// C4 修复：
//   - loadSeq 对"末行部分写入/损坏"回退扫描最后合法完整行并截断坏尾，
//     新进程 seq 从断点续写（不再从 1 重来产生重复 seq）；
//   - rotate 后新文件首条 seq 从 .1 末行续取（跨滚动全局递增）；
//   - list({includeRotated:true}) 合并 .1（logs 命令可读滚动前条目）。
// M-13 修复（v5 阶段 1）：append 的 read-modify-write 全程持 shared fs/lock
// 文件锁（<logFile 同目录>/.runlog.lock）——跨进程全局唯一 seq；nextRunSeq
// 供外部在锁内预取下一 seq（同一把锁，互斥）。
const path = require('path');
const { RUNLOG_MAX_BYTES } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const { acquireLock, releaseLock } = require('./lock');

// run.jsonl 的 seq 专用锁文件名（与命令锁/补丁锁独立，防交叉持锁顺序死锁）
const RUNLOG_LOCK_FILE = '.runlog.lock';
const RUNLOG_LOCK_WAIT_MS = 5000;

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
   * 追加一条结构化日志（M-13：锁内 read-modify-write，跨进程 seq 全局唯一）。
   * M-28（v5 阶段 5）：写盘前经 runLineSchema 校验最终行结构（校验在锁内对
   * 真实构造行执行；ajv 惰性加载——vendored 消费方不调用 append 则零依赖）。
   * @param {object} entry { stream, line, ... }
   * @returns {{ok: boolean, seq?: number, error?: Error}}
   */
  function append(entry) {
    const lockPath = path.join(path.dirname(logFile), RUNLOG_LOCK_FILE);
    const a = acquireLock(fsPort, lockPath, { waitMs: RUNLOG_LOCK_WAIT_MS, refreshMs: 0 });
    if (!a.ok) {
      return { ok: false, error: makeError('ERR_LOG_WRITE', `日志锁获取失败 ${lockPath}：${a.error.message}`, { cause: a.error }) };
    }
    try {
      loadSeq();
      seq += 1;
      fsPort.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fsPort.existsSync(logFile)) {
        const st = fsPort.statSync(logFile);
        if (st.size >= maxBytes) rotate();
      }
      const line = {
        seq,
        t: new Date(now()).toISOString(),
        stream: entry.stream || 'stdout',
        line: String(entry.line === undefined ? '' : entry.line)
      };
      // M-28：单行 schema 校验（写路径边界；违规显式 ERR_LOG_WRITE，不落坏行）。
      // 惰性 require：ajv 仅在本函数被真正调用时才加载（与 yaml 惰性同模式）。
      const { validateRunLine } = require('../contracts/schemas');
      const check = validateRunLine(line);
      if (!check.ok) {
        return { ok: false, error: makeError('ERR_LOG_WRITE', `run.jsonl 行不符合 schema：${check.errors.join('；')}`) };
      }
      // B3 修复：末行是完整 JSON 但缺末尾换行时（崩溃/外部写入的坏尾形态），追加前先补
      // 换行——否则 appendFileSync 直接拼接成单行两个 JSON，list() 逐行 JSON.parse 失败
      // 丢弃整行（新旧两条一起丢）。scanForLastValidLine 的 keepEnd=size+1 使 truncated
      // 判假、坏尾修复不触发，故此处以「文件尾字节非 \n」兜底。
      let linePrefix = '';
      if (fsPort.existsSync(logFile)) {
        const st = fsPort.statSync(logFile);
        if (st.size > 0) {
          const fd = fsPort.openSync(logFile, 'r');
          try {
            const tailByte = Buffer.alloc(1);
            fsPort.readSync(fd, tailByte, 0, 1, st.size - 1);
            if (tailByte[0] !== 0x0a) linePrefix = '\n';
          } finally {
            fsPort.closeSync(fd);
          }
        }
      }
      fsPort.appendFileSync(logFile, linePrefix + JSON.stringify(line) + '\n', 'utf8');
      return { ok: true, seq };
    } catch (e) {
      return { ok: false, error: makeError('ERR_LOG_WRITE', `日志写入失败 ${logFile}：${e.message}`) };
    } finally {
      releaseLock(fsPort, lockPath, { pid: process.pid, fd: a.fd });
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

/**
 * 读取主文件（+ .1）最后一个合法 seq（只读，不截断坏尾；调用方须已持锁）。
 * @param {object} fsPort
 * @param {string} logFile
 * @returns {number}
 */
function readLastSeq(fsPort, logFile) {
  const main = readLastSeqFromFile(fsPort, logFile);
  if (main > 0) return main;
  return readLastSeqFromFile(fsPort, logFile + '.1');
}

/** 只读版 loadSeqFromFile（不截断坏尾）。 */
function readLastSeqFromFile(fsPort, file) {
  if (!fsPort.existsSync(file)) return 0;
  try {
    const stat = fsPort.statSync(file);
    if (stat.size === 0) return 0;
    const fd = fsPort.openSync(file, 'r');
    try {
      const windowStart = Math.max(0, stat.size - 4096);
      let buf = Buffer.alloc(stat.size - windowStart);
      fsPort.readSync(fd, buf, 0, buf.length, windowStart);
      let found = scanForLastValidLine(buf, windowStart);
      if (found.seq === null && windowStart > 0) {
        buf = Buffer.alloc(stat.size);
        fsPort.readSync(fd, buf, 0, buf.length, 0);
        found = scanForLastValidLine(buf, 0);
      }
      return found.seq || 0;
    } finally {
      fsPort.closeSync(fd);
    }
  } catch (_) {
    return 0;
  }
}

/**
 * 在锁内读取下一可用 seq（M-13：跨进程全局唯一；不做写入）。
 * 与 append 共用同一把锁（<logFile 同目录>/.runlog.lock），互斥保证无重复。
 * @param {object} fsPort
 * @param {string} logFile run.jsonl 路径
 * @returns {{ok: boolean, seq?: number, error?: Error}}
 */
function nextRunSeq(fsPort, logFile) {
  const lockPath = path.join(path.dirname(logFile), RUNLOG_LOCK_FILE);
  const a = acquireLock(fsPort, lockPath, { waitMs: RUNLOG_LOCK_WAIT_MS, refreshMs: 0 });
  if (!a.ok) {
    return { ok: false, error: makeError('ERR_LOG_WRITE', `日志锁获取失败 ${lockPath}：${a.error.message}`, { cause: a.error }) };
  }
  try {
    const seq = readLastSeq(fsPort, logFile);
    return { ok: true, seq: seq + 1 };
  } finally {
    releaseLock(fsPort, lockPath, { pid: process.pid, fd: a.fd });
  }
}

module.exports = { createRunLog, nextRunSeq, readLastSeq, RUNLOG_LOCK_FILE };
