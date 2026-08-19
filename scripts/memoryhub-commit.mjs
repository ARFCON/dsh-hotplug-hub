// memoryhub-commit.mjs — 通过 dsh-memory-hub 协议提交一条记忆
// 用法: node scripts/memoryhub-commit.mjs <packId> <title> <body>
import { MemoryStore } from '../dsh-hotplug-hub/dsh-memory-hub/lib/store.mjs'
import { MemoryHubService } from '../dsh-hotplug-hub/dsh-memory-hub/lib/service.mjs'
import os from 'node:os'
import path from 'node:path'

const hubDir = process.env.DSH_MEMORY_HUB_DIR || path.join(os.homedir(), '.dsh', 'memory-hub')
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
