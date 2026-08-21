// memoryhub-list.mjs — 读取 memory-hub 活动条目（JSON）
// 上游适配（H-1）：记忆根 = resolveDshRoot()/memory-hub（优先级
// DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh，单一真源 shared-core），
// 与 dsh-memory-hub 插件一致；DSH_MEMORY_HUB_DIR 显式覆盖仍优先（调试/测试用）。
import { MemoryStore } from '../dsh-hotplug-hub/dsh-memory-hub/lib/store.mjs'
import path from 'node:path'
import { resolveDshRoot } from '../packages/shared-core/contracts/constants.js'

const hubDir = process.env.DSH_MEMORY_HUB_DIR || path.join(resolveDshRoot(process.env).dshRoot, 'memory-hub')
const store = new MemoryStore(hubDir)
const rows = store.allEntries().slice(0, 50).map(({ packId, entry }) => ({
  packId,
  id: entry.id,
  title: entry.title || entry.name || '',
  type: entry.type || '',
  body: entry.body || '',
  keywords: entry.keywords || [],
  updatedAt: entry.updatedAt || '',
}))
console.log(JSON.stringify(rows))
