/**
 * dseam-skillmcp —— profile cordis.patch.yml 受管块编辑器。
 *
 * 阶段 4（R-v5-12 / H-16）：统一四写者契约（CONTRACT.md §4/§5）：
 *   - marker：`## dseam-skillmcp:mcp`（单行）；旧 `# >>> dseam-skillmcp:mcp:begin/end`
 *     形态在读取时兼容识别（迁移期：下次写时清理为契约块）；
 *   - 写入走 shared profile/merge 同语义的分节保留合并 + 共享文件锁
 *     `<profile>/.dsh-patch.lock`（与 launcher/hotplug/C# 同一把锁）；
 *   - 标记之外的内容逐字节保留，永不整文件覆盖。
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, openSync, writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync, statSync, lstatSync, readdirSync, closeSync, fsyncSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { findPatchBlock, patchMarker, acquireLock, releaseLock } from "../vendor-shared/index.mjs";
export const PANEL_MCP_BLOCK_BEGIN = "# >>> dseam-skillmcp:mcp:begin";
export const PANEL_MCP_BLOCK_END = "# <<< dseam-skillmcp:mcp:end";
/** 契约单行 marker（CONTRACT.md §4；owner=dseam-skillmcp, id=mcp）。 */
export const PANEL_MCP_BLOCK_MARKER = patchMarker("dseam-skillmcp", "mcp");
export const MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";
export const MANAGED_ROW_ID_PREFIX = "dseam-mcp-";
/** 读取 patch 文件；缺失/读失败统一带路径报错。 */
export async function readPatchFile(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        throw new Error("无法读取 cordis.patch.yml（" + path + "）：" + (error instanceof Error ? error.message : String(error)));
    }
}
/** 校验整份 patch 文本：可解析且顶层是数组。不解出/写回任何值。 */
export async function validatePatchText(raw) {
    const doc = parseDocument(raw, { logLevel: "silent" });
    if (doc.errors.length > 0) {
        throw new Error("cordis.patch.yml 解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
    }
    const parsed = doc.toJS();
    if (!Array.isArray(parsed))
        throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
}
/** 把 YAML 解析出的顶层条目拍平成 patch 行。 */
function flattenPatchRows(entries) {
    const rows = [];
    if (!Array.isArray(entries))
        return rows;
    const pushRow = (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return;
        const row = value;
        if (typeof row.id === "string" || typeof row.name === "string") {
            const normalized = { ...row };
            if (typeof row.id !== "string")
                delete normalized.id;
            if (typeof row.name !== "string")
                delete normalized.name;
            if (typeof row.disabled !== "boolean")
                delete normalized.disabled;
            if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config))
                delete normalized.config;
            rows.push(normalized);
        }
    };
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry))
            continue;
        const record = entry;
        if (Array.isArray(record.insert)) {
            for (const row of record.insert)
                pushRow(row);
        }
        else {
            pushRow(record);
        }
    }
    return rows;
}
/** 提取契约单行 marker 之后的受管块文本（marker 行起至下一个 marker 或 EOF）。 */
function extractNewBlockText(raw) {
    const lines = raw.split("\n");
    const start = lines.findIndex((line) => line.trim() === PANEL_MCP_BLOCK_MARKER);
    if (start === -1)
        return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].trim() === PANEL_MCP_BLOCK_MARKER) { end = i; break; }
    }
    return lines.slice(start + 1, end).join("\n");
}
/** 提取受管行：先契约单行 marker，再旧 begin/end 形态（迁移期读兼容）。 */
export function extractManagedRows(raw) {
    const newBlock = extractNewBlockText(raw);
    if (newBlock !== null) {
        const doc = parseDocument(newBlock, { logLevel: "silent" });
        if (doc.errors.length > 0)
            throw new Error("受管块解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
        const parsed = doc.toJS();
        if (!Array.isArray(parsed))
            throw new Error("受管块内容必须是 YAML 数组");
        return flattenPatchRows(parsed);
    }
    const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
    const end = raw.indexOf(PANEL_MCP_BLOCK_END);
    if (begin < 0 && end < 0)
        return [];
    if (begin < 0 || end < 0 || end < begin)
        throw new Error("cordis.patch.yml 中 dseam-skillmcp 受管块标记不完整（begin/end 必须成对）");
    const blockStart = raw.indexOf("\n", begin);
    if (blockStart < 0)
        throw new Error("cordis.patch.yml 受管块格式损坏");
    const blockText = raw.slice(blockStart + 1, end);
    const doc = parseDocument(blockText, { logLevel: "silent" });
    if (doc.errors.length > 0)
        throw new Error("受管块解析失败：" + String(doc.errors[0]?.message ?? doc.errors[0]));
    const parsed = doc.toJS();
    if (!Array.isArray(parsed))
        throw new Error("受管块内容必须是 YAML 数组");
    return flattenPatchRows(parsed);
}
/** 解析整份 patch 并返回其中所有 MCP 客户端行（不区分是否受管）。 */
export function listMcpPatchRows(raw) {
    const doc = parseDocument(raw, { logLevel: "silent" });
    if (doc.errors.length > 0)
        return [];
    const parsed = doc.toJS();
    if (!Array.isArray(parsed))
        return [];
    return flattenPatchRows(parsed).filter((row) => row.name === MCP_PLUGIN_NAME);
}
/** 生成受管块内容（单个 YAML 顶层数组项；marker 单独成行由合并层负责）。 */
export function generateManagedBlock(rows) {
    if (rows.length === 0)
        return "";
    return stringify([{ insert: rows }], { indent: 2, lineWidth: 0 }).replace(/\n+$/, "");
}
/** 旧 begin/end 形态的块范围（迁移期清理用）；无旧标记返回 null。 */
function legacyBlockRange(raw) {
    const begin = raw.indexOf(PANEL_MCP_BLOCK_BEGIN);
    const end = raw.indexOf(PANEL_MCP_BLOCK_END);
    if (begin < 0 && end < 0)
        return null;
    if (begin < 0 || end < 0 || end < begin)
        throw new Error("cordis.patch.yml 中 dseam-skillmcp 受管块标记不完整（begin/end 必须成对）");
    const lineStart = raw.lastIndexOf("\n", begin - 1) + 1;
    const afterEnd = raw.indexOf("\n", end);
    const lineEnd = afterEnd < 0 ? raw.length : afterEnd + 1;
    return { start: lineStart, end: lineEnd };
}
/**
 * 替换受管块（契约 marker 分节合并；旧 begin/end 形态先清理迁移）。
 * 标记之外的所有字节原样保留；永不整文件覆盖。
 */
export function replaceManagedBlock(raw, rows) {
    const block = generateManagedBlock(rows);
    // 1) 迁移：清理旧 begin/end 形态块
    let text = raw;
    const legacy = legacyBlockRange(raw);
    if (legacy !== null)
        text = raw.slice(0, legacy.start) + raw.slice(legacy.end);
    // 2) 空 profile 模板 `[]`：替换为受管块（流式空数组后追加会破坏结构）
    if (block !== "") {
        const lines = text.split(/\r?\n/);
        const meaningful = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
        if (meaningful.length === 1 && meaningful[0] === "[]") {
            const index = text.lastIndexOf("[]");
            return text.slice(0, index) + PANEL_MCP_BLOCK_MARKER + "\n" + block + "\n" + text.slice(index + 2);
        }
    }
    // 3) 分节合并（与 shared mergePatchFile 同语义：替换目标块或追加；其余原样保留）
    return applyMergeInMemory(text.replace(/\r\n/g, "\n"), "dseam-skillmcp", "mcp", block);
}
/** 内存版分节合并（复用 shared findPatchBlock/patchMarker 语义；文件写盘在调用方）。 */
function applyMergeInMemory(text, owner, id, blockYaml) {
    const marker = patchMarker(owner, id);
    const blockText = blockYaml === "" ? "" : `${marker}\n${blockYaml}\n`;
    const located = findPatchBlock(text, owner, id);
    if (located.found) {
        const lines = text.split("\n");
        const head = lines.slice(0, located.start).join("\n");
        const tail = lines.slice(located.end).join("\n");
        const headText = head === "" ? "" : head + "\n";
        return headText + blockText + tail;
    }
    if (blockText === "")
        return text;
    const base = text === "" ? "" : (text.endsWith("\n") ? text : text + "\n");
    return base + blockText;
}
// node:fs 直连端口（共享 lock 契约需要）
const nodeFsPort = {
    readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync,
    openSync, closeSync, fsyncSync, renameSync, unlinkSync, rmSync, readdirSync, copyFileSync,
};
/** 同目录临时文件 + rename 原子写；Windows 上 rename 覆盖失败时退化为 rm+rename。 */
export async function writeFileAtomic(path, content) {
    const temp = join(dirname(path), ".dseam-skillmcp-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
    try {
        await writeFile(temp, content, "utf8");
        try {
            await rename(temp, path);
        }
        catch (error) {
            if (error === null || typeof error !== "object" || !["EPERM", "EEXIST", "EACCES"].includes(error.code ?? ""))
                throw error;
            await rm(path, { force: true });
            await rename(temp, path);
        }
    }
    finally {
        await rm(temp, { force: true }).catch(() => { });
    }
}
/**
 * 以共享文件锁 `<profile>/.dsh-patch.lock` 执行 fn（CONTRACT.md §5 四写者协议；
 * token/探活/过期语义与 launcher/hotplug/C# 一致）。获取超时 5 秒。
 */
export async function withPatchLock(path, fn) {
    const lockPath = join(dirname(path), ".dsh-patch.lock");
    const a = acquireLock(nodeFsPort, lockPath, { waitMs: 5000, refreshMs: 5000 });
    if (!a.ok)
        throw new Error("等待 cordis.patch.yml 写锁超时（" + a.error.message + "）");
    try {
        return await fn();
    }
    finally {
        releaseLock(nodeFsPort, lockPath, { pid: process.pid, fd: a.fd });
    }
}
/**
 * 读取 patch 文件、替换受管块、校验、加锁原子写回。
 * 返回写回后的完整文本。
 */
export async function writeManagedRows(path, rows) {
    return withPatchLock(path, async () => {
        const raw = await readPatchFile(path);
        const next = replaceManagedBlock(raw, rows);
        await validatePatchText(next);
        await writeFileAtomic(path, next);
        return next;
    });
}
