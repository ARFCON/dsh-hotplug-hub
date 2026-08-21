'use strict';
// infra/lock.js — 统一文件锁（H-4/M-12，由 shared-core 单一真源再导出，零副本）
//
// v1（目录锁）→ v2（文件锁）迁移规则见 CONTRACT.md §5：
// 检测到目标为目录形态 → 读 owner：pid 存活且未过期 → 等待；否则清理重建为文件锁。
module.exports = require('@dsh/shared-core/fs/lock');
