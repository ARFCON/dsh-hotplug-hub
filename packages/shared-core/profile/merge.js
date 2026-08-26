'use strict';
// profile/merge.js — cordis.patch.yml 分节保留合并（H-16 / R-v5-12，CONTRACT.md 钉死）
//
// 契约（跨语言一致，C# 侧等价实现见 release/src/PatchContract.cs）：
//   - marker：`## <owner>:<id>`（读兼容单 `#`——识别 `# <owner>:<id>` 与
//     `## <owner>:<id>` 两种形态；owner/id 字符集 [A-Za-z0-9._-]）；
//   - 块 = marker 行起，至下一个 marker 行（或 EOF）止；内容为单个 YAML 顶层
//     数组项（缩进 0，内层 4/2 空格）；
//   - 合并语义：按 marker 切分 → 替换目标块 → 其余块/注释/空行原样保留；
//     目标块不存在则追加到文件末尾；永不整文件覆盖、永不触碰其他块；
//   - 旧无 marker 文件视为 `desktop` owner 整体保留（灰度窗口，版本门控终止）；
//   - 旧 C# `# 插件管理…` 块（非本 marker 形态）：JS 写者不识别也不清理——该块由
//     创建它的 C# 桌面端在下次写盘时自清（release/src/Main.cs 迁移逻辑）；本模块的
//     分节保留语义保证它原样留存、不被误伤（兼容性审计结论，见 CONTRACT.md §4）。
//   - 写盘走 shared fs/atomic（随机 tmp + wx + rename）；调用方负责持锁
//     （<profile>/.dsh-patch.lock，见 CONTRACT.md 锁协议）。
const { makeError } = require('../contracts/errors');
const { writeFileAtomic } = require('./../fs/atomic');

// marker 行：`# <owner>:<id>` 或 `## <owner>:<id>`（读兼容单 #；# 后必须空白，
// 避免误匹配 `##hotplug:x` 等紧凑注释形态）
const PATCH_MARKER_RE = /^#{1,2}\s+([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)\s*$/;

/**
 * 构造契约 marker 行。
 * @param {string} owner
 * @param {string} id
 * @returns {string} `## <owner>:<id>`
 */
function patchMarker(owner, id) {
  return `## ${owner}:${id}`;
}

/**
 * 在文本中定位目标块（marker 形态 `#`/`##` 均可）。
 * @param {string} text 已归一化（\n）的全文
 * @param {string} owner
 * @param {string} id
 * @returns {{found: boolean, start?: number, end?: number}}
 *   found=true 时 start=marker 行索引，end=下一个 marker 行索引（或行数，EOF）
 */
function findPatchBlock(text, owner, id) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = PATCH_MARKER_RE.exec(lines[i]);
    if (m && m[1] === owner && m[2] === id) { start = i; break; }
  }
  if (start === -1) return { found: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (PATCH_MARKER_RE.test(lines[i])) { end = i; break; }
  }
  return { found: true, start, end };
}

/**
 * 分节保留合并：把 blockYaml（单个 YAML 顶层数组项文本）合并进 cordis.patch.yml。
 * 目标块存在 → 替换；不存在 → 追加。其余内容原样保留。
 * @param {object} fsPort fs 端口（须含 readFileSync/existsSync/writeFileAtomic 所需方法）
 * @param {string} filePath cordis.patch.yml 路径
 * @param {string} owner 写入方 owner（hotplug / dseam-skillmcp / desktop / launcher）
 * @param {string} id 块 id（如 packId / mcp / 插件 loaderId）
 * @param {string} blockYaml 块内容（不含 marker 行；缩进 0 的单个顶层数组项）
 * @param {object} [opts]
 * @param {string} [opts.errorCode] 写失败错误码（默认 ERR_INSTALL_FAILED）
 * @returns {{ok: boolean, changed?: boolean, marker?: string, error?: Error}}
 */
function mergePatchFile(fsPort, filePath, owner, id, blockYaml, opts = {}) {
  const marker = patchMarker(owner, id);
  const blockYamlNorm = String(blockYaml).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const errorCode = opts.errorCode || 'ERR_INSTALL_FAILED';
  // 防御（审计修复）：blockYaml 内若含列 0 的 marker 形态行（`# x:y` / `## x:y`），
  // findPatchBlock 会把它误判为块边界——替换路径因此非幂等、内容逐次重复（实测）。
  // 此类行无法无歧义地表示为「单个 YAML 顶层数组项」，显式拒绝而非静默损坏文件。
  for (const line of blockYamlNorm.split('\n')) {
    if (PATCH_MARKER_RE.test(line)) {
      return { ok: false, error: makeError(errorCode, `块内容含 marker 形态行，无法安全合并：${JSON.stringify(line)}`) };
    }
  }
  const blockText = `${marker}\n${blockYamlNorm}\n`;
  try {
    const raw = fsPort.existsSync(filePath) ? fsPort.readFileSync(filePath, 'utf8') : '';
    const text = String(raw).replace(/\r\n/g, '\n');
    const located = findPatchBlock(text, owner, id);
    let next;
    if (located.found) {
      const lines = text.split('\n');
      const head = lines.slice(0, located.start).join('\n');
      const tail = lines.slice(located.end).join('\n');
      // 拼接：head（保留原结尾换行语义） + 新块 + tail
      const headText = head === '' ? '' : head + '\n';
      const tailText = tail === '' ? '' : tail;
      next = headText + blockText + tailText;
    } else {
      // 追加：文件为空 → 直接块；非空 → 确保以 \n 结尾后追加
      const base = text === '' ? '' : (text.endsWith('\n') ? text : text + '\n');
      next = base + blockText;
    }
    if (next === text) return { ok: true, changed: false, marker };
    const w = writeFileAtomic(fsPort, filePath, next, { errorCode });
    if (!w.ok) return w;
    return { ok: true, changed: true, marker };
  } catch (e) {
    return { ok: false, error: makeError(errorCode, `合并 patch 失败 ${filePath}：${e.message}`, { cause: e }) };
  }
}

/**
 * 移除目标块（按 marker 匹配，不按 id 内容匹配——迁移规则 §9）。
 * @param {object} fsPort
 * @param {string} filePath
 * @param {string} owner
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.errorCode]
 * @returns {{ok: boolean, removed?: boolean, error?: Error}}
 */
function removePatchBlock(fsPort, filePath, owner, id, opts = {}) {
  const errorCode = opts.errorCode || 'ERR_INSTALL_FAILED';
  try {
    if (!fsPort.existsSync(filePath)) return { ok: true, removed: false };
    const text = String(fsPort.readFileSync(filePath, 'utf8')).replace(/\r\n/g, '\n');
    const located = findPatchBlock(text, owner, id);
    if (!located.found) return { ok: true, removed: false };
    const lines = text.split('\n');
    const head = lines.slice(0, located.start).join('\n');
    const tail = lines.slice(located.end).join('\n');
    // 清理接缝处的多余空行（head 结尾与 tail 开头各至多保留一个换行）。
    // 注（审计结论）：此「接缝空行清理」与 C# MergePatchSection("") 的「空行原样保留」
    // 存在低危漂移——C# 删除时保留相邻块尾随空行，JS 删除时清理接缝空行。两者产物
    // 均为合法 YAML 且语义等价（空行对 YAML 无意义），且本清理被消费者测试（B11
    // 「文件尾不留双空行缝」）锁定为预期行为，故保留 JS 侧清理语义、不对齐 C#。
    let next = head.replace(/\n+$/, '');
    if (tail !== '') next = next === '' ? tail : next + '\n' + tail.replace(/^\n+/, '');
    if (next === '') next = '';
    const w = writeFileAtomic(fsPort, filePath, next, { errorCode });
    if (!w.ok) return w;
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, error: makeError(errorCode, `移除 patch 块失败 ${filePath}：${e.message}`, { cause: e }) };
  }
}

module.exports = { mergePatchFile, removePatchBlock, findPatchBlock, patchMarker, PATCH_MARKER_RE };
