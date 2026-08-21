'use strict';
// index.js — shared-core CJS 聚合出口（require 消费方：launcher 等）
// ESM 消费方走 index.mjs（createRequire 再导出垫片）。
// 导出集合 == index.mjs 再导出集合（CI/单测断言防漂移）。
module.exports = {
  // ids
  ...require('./ids'),
  // contracts
  ...require('./contracts/errors'),
  ...require('./contracts/constants'),
  ...require('./contracts/schemas'),
  ...require('./contracts/state-machine'),
  // profile
  ...require('./profile/patch'),
  ...require('./profile/merge'),
  // fs
  ...require('./fs/path-safe'),
  ...require('./fs/atomic'),
  ...require('./fs/lock'),
  ...require('./fs/snapshot'),
  ...require('./fs/runlog'),
  ...require('./fs/tree-util'),
  ...require('./fs/utf8'),
  // security
  ...require('./security/shell'),
  ...require('./security/net'),
  // format
  ...require('./format/hotpack')
};
