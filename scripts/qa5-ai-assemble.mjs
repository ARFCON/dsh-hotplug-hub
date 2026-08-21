#!/usr/bin/env node
/**
 * scripts/qa5-ai-assemble.mjs — AI 组装真实全链路测试（进程隔离红线）
 *
 * 用法：
 *   DSH_DEEPSEEK_API_KEY=sk-xxx node scripts/qa5-ai-assemble.mjs [需求文本]
 *
 * 验证链（网关级，与产品路径一致）：
 *   真实 DeepSeek 调用（网关 aiAssemble）→ 权威 shared-core parseHotpack 校验 →
 *   网关 importPack 落盘（隔离根）→ 网关 status 可见已导入包。任何一环失败 exit 非 0。
 *
 * 隔离与安全（P5 铁律）：
 *   - API key 只经环境变量 DSH_DEEPSEEK_API_KEY 注入；不硬编码、不打印、不落盘
 *     （错误信息脱敏：key → ***）；
 *   - 显式删除 NODE_TLS_REJECT_UNAUTHORIZED / NODE_OPTIONS / CA / SSL 变量
 *     （fetch 恒为系统默认证书校验，TLS 铁律）；
 *   - DSH_HOME / HOME / USERPROFILE / LOCALAPPDATA / PATH 全部指向 os.tmpdir()
 *     下唯一隔离目录，结束即删；不触碰真实 ~/.dsh / harness；
 *   - 网关产物仅落盘于隔离根内（packs/<id>/hotpack.json），随目录删除。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HotplugGateway } from '../dsh-hotplug-hub/lib/gateway.js'

// 净化子进程/本进程环境（TLS 铁律 + 注入面）
for (const k of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
  delete process.env[k]
}

const API_KEY = process.env.DSH_DEEPSEEK_API_KEY || ''
if (!API_KEY) {
  console.error('FAIL: 缺少 DSH_DEEPSEEK_API_KEY 环境变量（隔离注入，不落盘）')
  process.exitCode = 2
} else {
  const input = process.argv[2] || '帮我组一个做笔记和知识管理的插件包'

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
    console.log(`== QA5 AI 组装真实全链路（model=deepseek-chat，隔离根=${isoRoot}）==`)
    console.log(`需求：${input}`)

    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })

    // 1) 网关 aiAssemble（真实 DeepSeek；key 经 env，网关内不打印）
    console.log('[1/3] 网关 aiAssemble（真实 DeepSeek 调用）…')
    const assembled = await gateway.aiAssemble({ input })
    if (!assembled.ok) {
      console.error(`FAIL: aiAssemble：${assembled.message}`)
      exitCode = 1
    } else {
      const pack = assembled.data && assembled.data.pack
      if (!pack || !Array.isArray(pack.plugins) || pack.plugins.length === 0) {
        console.error('FAIL: aiAssemble 返回产物缺失插件清单')
        exitCode = 1
      } else {
        console.log(`PASS: 产物通过权威校验（id=${pack.id}，plugins=${pack.plugins.length}，name=${pack.name}）`)
        for (const p of pack.plugins) {
          console.log(`  - ${p.id} | ${p.name}@${p.version} | ${p.source.type}`)
        }
        console.log('  README 长度：' + (assembled.data.readme || '').length + ' 字符')

        // 2) 网关 importPack（落盘隔离根）
        console.log('[2/3] 网关 importPack（落盘隔离根）…')
        const imported = gateway.importPack(JSON.stringify(pack))
        if (!imported.ok) {
          console.error(`FAIL: importPack：${imported.error}`)
          exitCode = 1
        } else {
          console.log(`PASS: 已导入（${imported.pack.id}，${imported.pack.plugins} 个插件）`)

          // 3) 网关 status 可见
          console.log('[3/3] 网关 status 验证…')
          const st = gateway.status()
          const found = (st.packs || []).some((p) => p.id === imported.pack.id)
          if (found) {
            console.log('PASS: status 可见已导入包')
            console.log(`== 结果：PASS（真实组装 → 权威校验 → 导入 → 可见，全链路可用）==`)
          } else {
            console.error('FAIL: status 未列出已导入包')
            exitCode = 1
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
