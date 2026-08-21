// memoryhub-commit.mjs — 通过 dsh-memory-hub 协议提交一条记忆
// 用法: node scripts/memoryhub-commit.mjs <packId> <title> <body>
// 上游适配（H-1）：记忆根 = resolveDshRoot()/memory-hub（优先级
// DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh，单一真源 shared-core），
// 与 dsh-memory-hub 插件一致；DSH_MEMORY_HUB_DIR 显式覆盖仍优先（调试/测试用）。
import { MemoryStore } from '../dsh-hotplug-hub/dsh-memory-hub/lib/store.mjs'
import { MemoryHubService } from '../dsh-hotplug-hub/dsh-memory-hub/lib/service.mjs'
import path from 'node:path'
import { resolveDshRoot } from '../packages/shared-core/contracts/constants.js'

const hubDir = process.env.DSH_MEMORY_HUB_DIR || path.join(resolveDshRoot(process.env).dshRoot, 'memory-hub')
const store = new MemoryStore(hubDir)
const service = new MemoryHubService({ store, config: { writePolicy: 'ask', searchLimit: 4 } })

const pack = process.argv[2] || 'global.project'
const title = process.argv[3] || 'doc-read'
const body = process.argv[4] || ''
if (!store.hasPack(pack)) { store.createPack({ memoryPackId: pack, scope: 'global', keywords: ['doc', 'project'] }); }
const entry = { name: title, title, type: 'project', body, keywords: ['doc', 'dseam'], activation: 'relevant' }

try {
  const r = await service.commit({ pack, entry, reason: 'remember-doc' })
  console.log('memory-hub commit ok:', r?.proposalId ?? r?.entry?.id ?? JSON.stringify(r))
} catch (e) {
  console.error('memory-hub commit fail:', e.message)
  process.exit(1)
}
