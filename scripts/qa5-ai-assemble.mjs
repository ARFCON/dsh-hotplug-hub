#!/usr/bin/env node
/**
 * scripts/qa5-ai-assemble.mjs — AI 装配间真实全链路测试（进程隔离红线，多平台）
 *
 * 用法（任选其一 provider）：
 *   # DeepSeek
 *   DSH_DEEPSEEK_API_KEY=sk-xxx node scripts/qa5-ai-assemble.mjs [需求文本]
 *   # OpenCode Go（hy3 / kimi-k3 等）
 *   DSH_AI_PROVIDER=opencode DSH_OPENCODE_API_KEY=sk-xxx node scripts/qa5-ai-assemble.mjs [需求文本]
 *   # 任意 OpenAI 兼容端点
 *   DSH_AI_BASE_URL=https://... DSH_AI_MODEL=... DSH_AI_API_KEY=sk-xxx node scripts/qa5-ai-assemble.mjs [需求文本]
 *   # 人设（缺省 maid 小织女仆）：DSH_QA5_PERSONA=neko
 *   # 第二轮对话指令（缺省「再加一个全文搜索插件」）：DSH_QA5_FOLLOWUP=...
 *
 * 验证链（网关级，与产品路径一致）：
 *   真实 LLM 调用（网关 aiChat 首轮，人设注入）→ 权威 shared-core parseHotpack
 *   校验 → 会话落盘（隔离根 ai-sessions/）→ 第二轮 aiChat 对话式修改（续接同一
 *   会话）→ 网关 importPack 落盘（隔离根）→ 网关 status 可见已导入包。
 *   任何一环失败 exit 非 0。
 *
 * 隔离与安全（P5 铁律）：
 *   - API key 只经环境变量注入；不硬编码、不打印、不落盘（错误信息脱敏）；
 *   - 显式删除 NODE_TLS_REJECT_UNAUTHORIZED / NODE_OPTIONS / CA / SSL 变量
 *     （fetch 恒为系统默认证书校验，TLS 铁律）；
 *   - DSH_HOME / HOME / USERPROFILE / LOCALAPPDATA / PATH 全部指向 os.tmpdir()
 *     下唯一隔离目录，结束即删；不触碰真实 ~/.dsh / harness；
 *   - 会话与网关产物仅落盘于隔离根内，随目录删除。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HotplugGateway } from '../dsh-hotplug-hub/lib/gateway.js'

// 净化子进程/本进程环境（TLS 铁律 + 注入面）
for (const k of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
  delete process.env[k]
}

// provider 由 DSH_AI_PROVIDER 或 key 变量存在性推断；key 缺失由网关 resolveAiProvider 报错
const provider = process.env.DSH_AI_PROVIDER || (process.env.DSH_OPENCODE_API_KEY ? 'opencode' : 'deepseek')
const persona = process.env.DSH_QA5_PERSONA || 'maid'
const hasKey = Boolean(
  process.env.DSH_AI_API_KEY || process.env.DSH_DEEPSEEK_API_KEY || process.env.DSH_OPENCODE_API_KEY
)
if (!hasKey) {
  console.error('FAIL: 缺少 API Key 环境变量（DSH_AI_API_KEY / DSH_DEEPSEEK_API_KEY / DSH_OPENCODE_API_KEY，隔离注入不落盘）')
  process.exitCode = 2
} else {
  const input = process.argv[2] || '帮我组一个做笔记和知识管理的插件包'
  const followup = process.env.DSH_QA5_FOLLOWUP || '再加一个全文搜索插件，版本要新的'

  // ---- 隔离根（P5：零真实域写入） ----
  const isoRoot = mkdtempSync(join(tmpdir(), 'qa5-ai-root-'))
  const isoDsh = join(isoRoot, '.dsh')
  process.env.DSH_HOME = isoDsh
  process.env.HOME = isoRoot
  process.env.USERPROFILE = isoRoot
  process.env.LOCALAPPDATA = join(isoRoot, 'AppData', 'Local')
  process.env.PATH = join(isoRoot, 'bin')
  process.env.DSH_PROFILE = 'web'
  mkdirSync(join(isoRoot, 'bin'), { recursive: true })

  let exitCode = 0
  try {
    console.log(`== QA5 AI 装配间真实全链路（provider=${provider}，persona=${persona}，隔离根=${isoRoot}）==`)
    console.log(`需求：${input}`)

    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })

    // 1) 网关 aiChat 首轮（真实 LLM 调用，多平台 + 人设；key 经 env，网关内不打印）
    console.log('[1/4] 网关 aiChat 首轮（真实 LLM，人设=' + persona + '）…')
    const first = await gateway.aiChat({ input, persona })
    if (!first.ok) {
      console.error(`FAIL: aiChat 首轮：${first.message}`)
      exitCode = 1
    } else {
      const d1 = first.data
      const pack1 = d1.pack
      if (!pack1 || !Array.isArray(pack1.plugins) || pack1.plugins.length === 0) {
        console.error('FAIL: 首轮产物缺失插件清单')
        exitCode = 1
      } else {
        const sessionId = d1.session.id
        console.log(`PASS: 首轮产物通过权威校验（id=${pack1.id}，plugins=${pack1.plugins.length}，name=${pack1.name}）`)
        console.log(`PASS: 人设回复：${d1.reply}`)
        for (const p of pack1.plugins) {
          console.log(`  - ${p.id} | ${p.name}@${p.version} | ${p.source.type}`)
        }
        console.log('  README 长度：' + (d1.readme || '').length + ' 字符')

        // 2) 会话落盘 + 第二轮对话式修改（续接同一会话）
        console.log(`[2/4] 会话落盘 + 第二轮对话（sessionId=${sessionId}）…`)
        const second = await gateway.aiChat({ input: followup, sessionId, persona })
        if (!second.ok) {
          console.error(`FAIL: aiChat 第二轮：${second.message}`)
          exitCode = 1
        } else {
          const d2 = second.data
          if (d2.session.id !== sessionId) {
            console.error('FAIL: 第二轮会话 id 不一致（会话未续接）')
            exitCode = 1
          } else {
            console.log(`PASS: 会话续接成功（turn=${d2.session.turn}，persona=${d2.session.persona}）`)
            console.log(`PASS: 第二轮回复：${d2.reply}`)
            if (d2.pack) {
              const diff = d2.diff || { added: [], removed: [], changed: [] }
              console.log(`PASS: 产物已更新（plugins=${d2.pack.plugins.length}；新增 ${diff.added.length} / 移除 ${diff.removed.length} / 调整 ${diff.changed.length}）`)
              if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
                for (const a of diff.added) console.log(`  + ${a.id} | ${a.name}@${a.version}`)
                for (const r of diff.removed) console.log(`  - ${r.id} | ${r.name}@${r.version}`)
                for (const c of diff.changed) console.log(`  ~ ${c.id} | ${c.from.version} → ${c.to.version}`)
              }
            } else {
              console.log('PASS: 第二轮为纯对话回复（产物未变，符合对话语义）')
            }

            // 3) 网关 importPack（落盘隔离根；用最新产物）
            const pack = d2.pack || pack1
            console.log('[3/4] 网关 importPack（落盘隔离根）…')
            const imported = await gateway.importPack(JSON.stringify(pack))
            if (!imported.ok) {
              console.error(`FAIL: importPack：${imported.message ?? imported.error}`)
              exitCode = 1
            } else {
              console.log(`PASS: 已导入（${imported.pack.id}，${imported.pack.plugins} 个插件）`)

              // 4) 网关 status 可见
              console.log('[4/4] 网关 status 验证…')
              const st = gateway.status()
              const found = (st.packs || []).some((p) => p.id === imported.pack.id)
              if (found) {
                console.log('PASS: status 可见已导入包')
                console.log('== 结果：PASS（真实首轮装配 → 会话落盘 → 对话式修改 → 权威校验 → 导入 → 可见，全链路可用）==')
              } else {
                console.error('FAIL: status 未列出已导入包')
                exitCode = 1
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`FAIL: 脚本异常：${e.message}`)
    exitCode = 1
  } finally {
    rmSync(isoRoot, { recursive: true, force: true })
    console.log(`隔离根已清理（${isoRoot}）`)
  }

  // 注：不用 process.exit() 硬退——undici 连接池在 Windows 上与 process.exit 存在
  // libuv handle 竞态（uv async close assert 崩溃）；设置 exitCode 后自然退出即可。
  process.exitCode = exitCode
}
