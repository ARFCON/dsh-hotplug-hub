'use strict';
// test/fixtures/runlog-child.cjs — 日志子进程夹具：追加 N 条（M-13 并发 seq 实证）
// 用法：node runlog-child.cjs <logFile> <count>
const fs = require('fs');
const path = require('path');
const { createRunLog } = require('../../fs/runlog');

const [logFile, count] = process.argv.slice(2);

const nodeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  appendFileSync: fs.appendFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  readSync: fs.readSync.bind(fs),
  ftruncateSync: fs.ftruncateSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  rmSync: fs.rmSync.bind(fs)
};

const log = createRunLog(nodeFs, path.resolve(logFile), {});
for (let i = 0; i < Number(count); i += 1) {
  const r = log.append({ stream: 'stdout', line: `line-${i}` });
  if (!r.ok) process.exit(1);
}
process.exit(0);
