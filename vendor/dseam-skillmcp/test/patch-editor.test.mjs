// test/patch-editor.test.mjs — dseam 受管块编辑器（阶段 4：契约 marker + 四写者锁）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PANEL_MCP_BLOCK_MARKER, PANEL_MCP_BLOCK_BEGIN, PANEL_MCP_BLOCK_END,
  extractManagedRows, listMcpPatchRows, generateManagedBlock, replaceManagedBlock,
  writeManagedRows, validatePatchText,
} from '../lib/patch-editor.js'

let dir = null
let patchFile = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dseam-pe-'))
  patchFile = join(dir, 'cordis.patch.yml')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const rows = [
  { id: 'dseam-mcp-1', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', command: 'dseam' } },
]

describe('契约格式生成与读取', () => {
  it('generateManagedBlock：单个顶层数组项（内层 2 空格）', () => {
    const block = generateManagedBlock(rows)
    expect(block.startsWith('- insert:\n')).toBe(true)
    expect(block).toContain('dseam-mcp-1')
    expect(block).not.toContain('# >>>')
  })

  it('replaceManagedBlock：新格式分节合并（marker 单独成行，其余保留）', () => {
    const raw = '# 顶部注释\n- insert:\n    - id: other\n      name: \'x\'\n      config: {}\n'
    const next = replaceManagedBlock(raw, rows)
    expect(next).toContain('# 顶部注释')
    expect(next).toContain('other')
    expect(next).toContain(PANEL_MCP_BLOCK_MARKER)
    expect(next).toContain('dseam-mcp-1')
    // 可解析
    validatePatchText(next)
    // 提取受管行
    const got = extractManagedRows(next)
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe('dseam-mcp-1')
  })

  it('旧 begin/end 形态读取兼容 + 写时清理迁移', () => {
    const legacy = `# 顶部注释\n${PANEL_MCP_BLOCK_BEGIN}\n- insert:\n    - id: dseam-mcp-old\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {}\n${PANEL_MCP_BLOCK_END}\n`
    const got = extractManagedRows(legacy)
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe('dseam-mcp-old')
    // 写时清理为契约块
    const next = replaceManagedBlock(legacy, rows)
    expect(next).not.toContain(PANEL_MCP_BLOCK_BEGIN)
    expect(next).not.toContain(PANEL_MCP_BLOCK_END)
    expect(next).toContain(PANEL_MCP_BLOCK_MARKER)
    expect(next).toContain('# 顶部注释')
    expect(extractManagedRows(next)[0].id).toBe('dseam-mcp-1')
  })

  it('空文件 / `[]` 模板：写入生成合法结构', () => {
    const fromEmpty = replaceManagedBlock('', rows)
    expect(extractManagedRows(fromEmpty)).toHaveLength(1)
    const fromTemplate = replaceManagedBlock('[]\n', rows)
    validatePatchText(fromTemplate)
    expect(extractManagedRows(fromTemplate)[0].id).toBe('dseam-mcp-1')
    // 清空行 → 删除块
    const cleared = replaceManagedBlock(fromTemplate, [])
    expect(extractManagedRows(cleared)).toHaveLength(0)
  })
})

describe('writeManagedRows（锁内原子写）', () => {
  it('写回后文件合法且锁已释放', async () => {
    writeFileSync(patchFile, '# 顶部注释\n')
    const next = await writeManagedRows(patchFile, rows)
    expect(next).toContain(PANEL_MCP_BLOCK_MARKER)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toContain('# 顶部注释')
    expect(text).toContain('dseam-mcp-1')
    // 四写者共享锁文件（<profile>/.dsh-patch.lock）已释放
    expect(existsSync(join(dir, '.dsh-patch.lock'))).toBe(false)
    expect(existsSync(join(dir, 'cordis.patch.yml.panel.lock'))).toBe(false)
    // 再写（覆盖）：块被替换而非重复
    const rows2 = [{ id: 'dseam-mcp-2', name: '@deepseek-ai/dsh-mcp-client', config: {} }]
    const next2 = await writeManagedRows(patchFile, rows2)
    expect(next2.match(/## dseam-skillmcp:mcp/g)).toHaveLength(1)
    expect(extractManagedRows(next2)).toHaveLength(1)
    expect(extractManagedRows(next2)[0].id).toBe('dseam-mcp-2')
  })
})

describe('listMcpPatchRows', () => {
  it('全文件 MCP 行（含受管与未受管）', () => {
    const raw = `${PANEL_MCP_BLOCK_MARKER}\n- insert:\n    - id: dseam-mcp-1\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {}\n- insert:\n    - id: manual\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {}\n`
    const rowsAll = listMcpPatchRows(raw)
    expect(rowsAll).toHaveLength(2)
  })
})
