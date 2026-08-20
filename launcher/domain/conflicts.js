'use strict';
// domain/conflicts.js — semver 冲突矩阵（纯函数）
//
// 审计修复：
//   - I：semver 语义比较（非字符串相等）；双无版本 → warning 不漏报
//   - I：冲突即阻断（error 级冲突使 check 退出非 0、assemble 拒绝）
//   - 依赖图冲突：config.dependencies 与其它插件实际版本不满足 → error
const semver = require('semver');
const { makeError } = require('../contracts/errors');

/**
 * 检测插件集合的冲突矩阵。
 * @param {Array<object>} plugins resolved 插件列表
 * @returns {{ok: boolean, conflicts: Array<object>}}
 */
function checkConflicts(plugins) {
  const conflicts = [];
  const byName = new Map();
  const roles = new Map();

  for (const p of plugins) {
    const nameKey = String(p.name || '').toLowerCase();

    // 同名分组（大小写不敏感，N14；C2 修复：组内两两比较，不再只与组内第一个比较——
    // 无版本插件曾掩盖其后两个真实版本之间的冲突）
    if (byName.has(nameKey)) {
      const group = byName.get(nameKey);
      const v2 = semver.valid(p.resolvedVersion || p.version);
      let anyValid = false;
      for (const prev of group) {
        const v1 = semver.valid(prev.resolvedVersion || prev.version);
        if (v1) anyValid = true;
        if (v1 && v2) {
          if (semver.neq(v1, v2)) {
            conflicts.push({
              severity: 'error',
              code: 'ERR_CONFLICT_VERSION',
              type: 'version',
              plugin: p.name,
              reason: `${v1} vs ${v2}`,
              suggest: '统一版本或停用其中一个插件'
            });
          }
        }
      }
      if (v2) anyValid = true;
      // 组内含无法解析版本的成员：warning 不漏报（审计 I 修复），
      // 但 warning 不得替代 error（组内有效版本间的真实冲突已在上方报出）。
      if (!anyValid || group.some((x) => !semver.valid(x.resolvedVersion || x.version)) || !v2) {
        conflicts.push({
          severity: 'warning',
          code: 'ERR_CONFLICT_VERSION',
          type: 'version',
          plugin: p.name,
          reason: `版本信息缺失（${group.map((x) => x.resolvedVersion || x.version || '?').join(', ')} vs ${p.resolvedVersion || p.version || '?'}），无法判定`,
          suggest: '为插件补充精确版本后重新检查'
        });
      }
      group.push(p);
    } else {
      byName.set(nameKey, [p]);
    }

    // 角色冲突（P3：role 大小写不敏感归一，'Search' 与 'search' 视为同角色）
    const role = p.config && p.config.role;
    if (role) {
      const roleKey = String(role).toLowerCase();
      if (roles.has(roleKey)) {
        conflicts.push({
          severity: 'error',
          code: 'ERR_CONFLICT_ROLE',
          type: 'role',
          plugin: p.name,
          reason: `重复角色 ${role}`,
          suggest: '保留角色更完整的插件'
        });
      } else {
        roles.set(roleKey, p);
      }
    }

    // 依赖图冲突：config.dependencies 中声明对其它插件的版本约束
    const deps = (p.config && p.config.dependencies) || {};
    for (const [depName, depRange] of Object.entries(deps)) {
      const other = plugins.find((x) => x !== p && String(x.name || '').toLowerCase() === depName.toLowerCase());
      if (!other) continue;
      // C2 修复：非法依赖范围串按 warning 处理（原实现 semver.satisfies 对垃圾串
      // 返回 false → 误报 error 阻断；见 qa3-conflicts-edge.test.js 的矛盾记录）
      if (typeof depRange !== 'string' || !semver.validRange(depRange)) {
        conflicts.push({
          severity: 'warning',
          code: 'ERR_CONFLICT_DEPENDENCY',
          type: 'dependency',
          plugin: p.name,
          reason: `${p.name} 声明的依赖范围无效：${JSON.stringify(depRange)}`,
          suggest: '修正依赖范围为合法 semver 范围'
        });
        continue;
      }
      const ov = semver.valid(other.resolvedVersion || other.version);
      if (ov && !semver.satisfies(ov, depRange)) {
        conflicts.push({
          severity: 'error',
          code: 'ERR_CONFLICT_DEPENDENCY',
          type: 'dependency',
          plugin: p.name,
          reason: `${p.name} 需要 ${depName}@${depRange}，实际为 ${ov}`,
          suggest: '调整依赖范围或升级被依赖插件'
        });
      } else if (!ov) {
        // C2 修复：目标版本不可解析（github/path/非法版本）→ warning 不漏报
        // （与同名分支"双无版本→warning"哲学一致）
        conflicts.push({
          severity: 'warning',
          code: 'ERR_CONFLICT_DEPENDENCY',
          type: 'dependency',
          plugin: p.name,
          reason: `${p.name} 需要 ${depName}@${depRange}，但 ${depName} 版本不可解析，无法校验`,
          suggest: '为被依赖插件补充精确版本后重新检查'
        });
      }
    }
  }

  const hasError = conflicts.some((c) => c.severity === 'error');
  return { ok: !hasError, conflicts };
}

/**
 * 将 error 级冲突转为阻断错误。
 * @param {Array<object>} conflicts
 * @returns {{ok: boolean, error?: Error}}
 */
function assertNoBlockingConflicts(conflicts) {
  const blocking = conflicts.filter((c) => c.severity === 'error');
  if (blocking.length > 0) {
    const first = blocking[0];
    return {
      ok: false,
      error: makeError(first.code || 'ERR_CONFLICT_BLOCKED', `${first.type} 冲突：${first.reason}（${first.suggest}）`)
    };
  }
  return { ok: true };
}

module.exports = { checkConflicts, assertNoBlockingConflicts };
