/**
 * lib/core/hotpack.js — hotpack 校验与 dshpack 桥接（v5 阶段 3 自 index.js 拆出）
 *
 * v5 重构（R-v5-11）：权威解析 = vendor-shared format/hotpack（launcher 语义基线）；
 * 此处为适配层：展示约束（name ≤214 / description ≤300）、tags 截断（12×24）、
 * pack.memory:{keep:true} 由本侧附加（不进 shared 语义）。
 * 审计修复（v5 阶段 5）：dshpackToHotpack 曾为本地分叉副本（静默跳过坏 bundle、
 * 忽略显式 bundle.id、不校验 github repo、不强制非空）——现收敛到 vendor-shared
 * 单一桥接（H-11b/c：npm 缺版本显式报错、id 由显式 id 派生、github repo 必填、
 * bundles 非空），本侧只叠加展示适配。
 */
import { parseHotpack as sharedParseHotpack, dshpackToHotpack as sharedDshpackToHotpack } from '../../vendor-shared/index.mjs'

const SHARED_OPTS = { maxNameLength: 214, maxDescLength: 300, allowLegacy: false }

/** 展示适配：tags 截断（12×24）+ memory:{keep:true}（hotplug 附加语义）。
 *  审计修复（R3）：tag 截断按【码点】而非 UTF-16 码元——String.slice(0,24) 会把
 *  代理对（emoji 等增补平面字符）劈成孤立高/低代理（与 market.js truncateCodePoints
 *  修复的同类问题）；Array.from 按码点切分，截断点永不落在代理对中间。 */
function adapt(pack) {
  return {
    ...pack,
    tags: pack.tags.slice(0, 12).map((tag) => Array.from(tag).slice(0, 24).join('')),
    memory: { keep: true },
  }
}

export function parseHotpack(input) {
  const r = sharedParseHotpack(input, SHARED_OPTS)
  // 审计修复：保留 shared 的 CLI 域错误码（code）——此前只透传 message，错误码被
  // 网关归一为 ERR_HOTPLUG_FAILED/exit 1，32 码契约从不透传（ERR_ASSEMBLY_* 应 exit 3）。
  if (!r.ok) return { ok: false, code: r.code, error: r.message }
  return { ok: true, pack: adapt(r.pack) }
}

/** .dshpack.json（规划格式）→ hotpack v1 转换（vendor-shared 单一桥接 + 展示适配）。 */
export function dshpackToHotpack(text) {
  const r = sharedDshpackToHotpack(text, SHARED_OPTS)
  if (!r.ok) return { ok: false, code: r.code, error: r.message }
  return { ok: true, pack: adapt(r.pack) }
}
