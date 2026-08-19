// memoryhub-list.mjs — 读取 memory-hub 活动条目（JSON）
import { MemoryStore } from '../dsh-hotplug-hub/dsh-memory-hub/lib/store.mjs'
import os from 'node:os'
import path from 'node:path'

const hubDir = process.env.DSH_MEMORY_HUB_DIR || path.join(os.homedir(), '.dsh', 'memory-hub')
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
