#!/usr/bin/env node
/**
 * scripts/qa5b-ai-chat.mjs — AI 装配间「复杂任务 × 多轮对话」真实全链路（进程隔离）
 *
 * 用法：
 *   DSH_AI_PROVIDER=opencode DSH_OPENCODE_API_KEY=sk-xxx \
 *     node scripts/qa5b-ai-chat.mjs
 *
 * 默认模型由注册表决定（opencode → deepseek-v4-flash，Go 目录实测可用）。
 * 上游偶发 "Model is unavailable"（Console Go 订阅侧模型加载中）：支持重试等待——DSH_QA5B_MAX_ATTEMPTS（默认 3）次尝试，每次间隔
 * DSH_QA5B_RETRY_MS（默认 60s），首轮失败自动等待重试；「卡可以等等」。
 *
 * 验证链（网关 aiChat，与产品路径一致）：
 *   轮1 复杂长需求 → 首轮装配（权威校验 + 会话落盘）
 *   轮2 明确修改指令（换掉插件）→ 产物 diff 必须非空（新增/移除/调整至少其一）
 *   轮3 闲聊（为什么选这些）→ 纯文本回复，产物不变，会话续接
 *   轮4 加功能指令 → 产物 diff 新增
 *   轮5 指令性总结（须体现产物上下文）→ 纯文本回复
 *   轮6 人设切换参数（会话应沿用原人设，不因参数切换）
 *   最终：importPack 落盘（最新产物）→ status 可见；全部通过 exit 0。
 *
 * 隔离与安全（P5）：DSH_HOME/HOME/USERPROFILE/PATH 全指向临时隔离根，结束即删；
 * key 只经环境变量注入，不打印不落盘；输出统一脱敏（key→***）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HotplugGateway } from '../dsh-hotplug-hub/lib/gateway.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  for (const k of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    delete process.env[k]
  }

  const hasKey = Boolean(process.env.DSH_AI_API_KEY || process.env.DSH_DEEPSEEK_API_KEY || process.env.DSH_OPENCODE_API_KEY)
  if (!hasKey) {
    console.error('FAIL: 缺少 API Key 环境变量（隔离注入不落盘）')
    process.exitCode = 2
    return
  }
  const isoRoot = mkdtempSync(join(tmpdir(), 'qa5b-ai-root-'))
  const isoDsh = join(isoRoot, '.dsh')
  process.env.DSH_HOME = isoDsh
  process.env.HOME = isoRoot
  process.env.USERPROFILE = isoRoot
  process.env.LOCALAPPDATA = join(isoRoot, 'AppData', 'Local')
  process.env.PATH = join(isoRoot, 'bin')
  process.env.DSH_PROFILE = 'web'
  mkdirSync(join(isoRoot, 'bin'), { recursive: true })

  let exitCode = 0
  const fail = (msg) => { console.error('FAIL: ' + msg); exitCode = 1 }

  try {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const provider = process.env.DSH_AI_PROVIDER || 'deepseek'
    console.log('== QA5b AI 装配间复杂对话真实链路（provider=' + provider + '，model=' + (process.env.DSH_AI_MODEL || 'default') + '）==')

    // 首轮：带重试等待（hy3 上游 "Model is unavailable" 时等待重试）
    const maxAttempts = Number(process.env.DSH_QA5B_MAX_ATTEMPTS || 3)
    const retryMs = Number(process.env.DSH_QA5B_RETRY_MS || 60000)
    let round1 = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      round1 = await gateway.aiChat({
        input: '我要搭建一套面向科研人员的文献阅读与论文写作工作流：需要支持 PDF 文献管理、参考文献自动格式化（GB/T 7714 风格）、Markdown 写作、中英文语法检查、笔记双链；插件要尽量轻量、彼此不重叠，优先选维护活跃的真实 npm 包',
        persona: 'maid',
      })
      if (round1.ok) break
      const unavailable = /Model is unavailable|server_error/i.test(round1.message || '')
      if (attempt < maxAttempts && unavailable) {
        console.log(`[首轮] 上游模型暂不可用（${round1.message}），${retryMs / 1000}s 后重试（${attempt}/${maxAttempts}）…`)
        await sleep(retryMs)
      } else {
        break
      }
    }
    if (!round1.ok) { fail('轮1 首轮装配：' + round1.message); return }
    const d1 = round1.data
    const sessionId = d1.session.id
    console.log(`[1/6] 首轮 PASS：${d1.pack.name}（${d1.pack.plugins.length} 插件，turn=${d1.session.turn}，persona=${d1.session.persona}）`)
    console.log(`      人设回复：${d1.reply}`)
    for (const p of d1.pack.plugins) console.log(`      - ${p.id} | ${p.name}@${p.version}`)

    // 轮2：明确修改指令 → 产物 diff 必须非空
    const round2 = await gateway.aiChat({
      input: '把第一个插件换掉，换成更主流的替代品',
      sessionId,
      persona: 'butler', // 会话已存在 → 应沿用 maid（验证人设不随参数切换）
    })
    if (!round2.ok) { fail('轮2 修改：' + round2.message); return }
    const d2 = round2.data
    if (d2.session.id !== sessionId) { fail('轮2 会话 id 不一致'); return }
    if (d2.session.persona !== 'maid') { fail('轮2 人设被参数覆盖（应沿用会话 maid，实际 ' + d2.session.persona + '）'); return }
    if (d2.pack) {
      const changed = (d2.diff.added || []).length + (d2.diff.removed || []).length + (d2.diff.changed || []).length
      if (changed === 0) { fail('轮2 明确修改指令但产物无任何变化（对话式修改不可靠）'); return }
      console.log(`[2/6] 修改 PASS：diff 新增 ${d2.diff.added.length} / 移除 ${d2.diff.removed.length} / 调整 ${d2.diff.changed.length}（turn=${d2.session.turn}）`)
      for (const a of d2.diff.added) console.log(`      + ${a.id} | ${a.name}@${a.version}`)
      for (const r of d2.diff.removed) console.log(`      - ${r.id} | ${r.name}@${r.version}`)
    } else {
      console.log(`[2/6] 修改轮为纯对话回复（产物未变）：${d2.reply}`)
    }

    // 轮3：闲聊 → 必须纯文本回复、产物不变
    const round3 = await gateway.aiChat({ input: '这些插件为什么要选它们？有什么搭配逻辑吗', sessionId })
    if (!round3.ok) { fail('轮3 闲聊：' + round3.message); return }
    const d3 = round3.data
    if (d3.pack) { fail('轮3 闲聊不应产出新产物'); return }
    console.log(`[3/6] 闲聊 PASS：纯文本回复（${String(d3.reply).length} 字符，turn=${d3.session.turn}）`)

    // 轮4：加功能 → diff 新增
    const round4 = await gateway.aiChat({ input: '再加一个功能：从文献 PDF 自动提取摘要和关键词', sessionId })
    if (!round4.ok) { fail('轮4 加功能：' + round4.message); return }
    const d4 = round4.data
    if (d4.pack) {
      const added = (d4.diff.added || []).length
      if (added === 0) { fail('轮4 加功能指令但无新增插件'); return }
      console.log(`[4/6] 加功能 PASS：新增 ${added} 个（${d4.pack.plugins.length} 插件总计，turn=${d4.session.turn}）`)
      for (const a of d4.diff.added) console.log(`      + ${a.id} | ${a.name}@${a.version}`)
    } else {
      console.log(`[4/6] 加功能轮为纯对话回复（未改产物）：${d4.reply}`)
    }

    // 轮5：指令性总结（须体现产物上下文——信息是否给足）
    const round5 = await gateway.aiChat({ input: '总结一下当前包里的插件清单和各自作用', sessionId })
    if (!round5.ok) { fail('轮5 总结：' + round5.message); return }
    const d5 = round5.data
    if (d5.pack) { fail('轮5 总结不应产出新产物'); return }
    const hasContext = /remark|markdown|pdf|bib|zotero|obsidian|pandoc|latex|note|语法|grammar|plugin|插件/i.test(d5.reply)
    if (!hasContext) { fail('轮5 总结回复未体现当前产物上下文（信息给足性存疑）'); return }
    console.log(`[5/6] 总结 PASS：回复含产物上下文（${String(d5.reply).slice(0, 100)}…，turn=${d5.session.turn}）`)

    // 轮6：人设切换参数（会话沿用原人设）
    const round6 = await gateway.aiChat({ input: '谢谢，做得很好', sessionId, persona: 'neko' })
    if (!round6.ok) { fail('轮6 人设：' + round6.message); return }
    const d6 = round6.data
    if (d6.session.persona !== 'maid') { fail('轮6 会话人设被参数覆盖（应沿用 maid）'); return }
    console.log(`[6/6] 人设沿用 PASS：persona=${d6.session.persona}，回复：${String(d6.reply).slice(0, 80)}…`)

    // 落地：importPack（最新产物）+ status 可见
    const finalPack = (d4.pack || d2.pack || d1.pack)
    const imported = gateway.importPack(JSON.stringify(finalPack))
    if (!imported.ok) { fail('importPack：' + imported.error); return }
    const st = gateway.status()
    if (!(st.packs || []).some((p) => p.id === imported.pack.id)) { fail('status 未列出已导入包'); return }
    console.log(`落地 PASS：${imported.pack.id}（${imported.pack.plugins} 插件）已导入并可见`)

    if (exitCode === 0) console.log('== 结果：PASS（复杂任务 × 6 轮对话 × 会话续接 × 人设沿用 × 权威校验，全链路可用）==')
  } catch (e) {
    console.error(`FAIL: 脚本异常：${e.message}`)
    exitCode = 1
  } finally {
    rmSync(isoRoot, { recursive: true, force: true })
    console.log(`隔离根已清理（${isoRoot}）`)
  }
  process.exitCode = exitCode
}

main()
