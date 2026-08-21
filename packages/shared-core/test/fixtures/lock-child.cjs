'use strict';
// test/fixtures/lock-child.cjs — 锁子进程夹具：acquire → 记录 → 持有 → 释放
// 用法：node lock-child.cjs <lockPath> <holdMs> <eventLog> <owner> [staleMs]
const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock } = require('../../fs/lock');

const [lockPath, holdMs, eventLog, owner] = process.argv.slice(2);
const staleMs = process.argv[6] ? Number(process.argv[6]) : undefined;

const nodeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  ftruncateSync: fs.ftruncateSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs)
};

function log(ev) {
  fs.appendFileSync(eventLog, `${Date.now()} ${ev} ${owner}\n`);
}

(async () => {
  const r = await new Promise((resolve) => {
    // acquireLock 是同步的；放到 setImmediate 里执行保证顺序
    setImmediate(() => resolve(acquireLock(nodeFs, lockPath, { owner, staleMs, waitMs: 5000, pollMs: 20, refreshMs: 0 })));
  });
  if (!r.ok) {
    log('acquire-fail');
    process.exit(2);
  }
  log('acquired');
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  const rel = releaseLock(nodeFs, lockPath, { owner, pid: process.pid, fd: r.fd, refresh: undefined });
  log(rel.ok ? 'released' : 'release-fail');
  process.exit(rel.ok ? 0 : 3);
})();
