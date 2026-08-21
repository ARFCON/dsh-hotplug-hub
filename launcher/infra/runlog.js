'use strict';
// infra/runlog.js — JSONL 日志（由 shared-core 单一真源再导出，零副本）
// M-28 的 append 写前 schema 校验已下沉到 shared-core fs/runlog 内部（锁内对
// 真实构造行执行），本文件为 launcher 消费缝，不再叠加任何本地行为。
module.exports = require('@dsh/shared-core/fs/runlog');
