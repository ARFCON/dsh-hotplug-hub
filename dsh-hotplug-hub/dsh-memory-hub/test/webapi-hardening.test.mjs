/**
 * dsh-memory-hub / test/webapi-hardening.test.mjs — Web API HTTP 壳加固验收（真实 handler）。
 *
 * 用最小 fake webServer 宿主驱动 index.mjs 的 mountWebApi（同源 fence 精确匹配 /
 * 写端点方法白名单 / GET 布尔归一 / 错误码 400/404/405/413/409 / restore 端点 / 日志尾部）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 最小 HTTP 请求/响应模拟（handler 消费的面：url/method/headers/on；writeHead/end） */
function makeReq({ url = '/', method = 'GET', headers = {}, body = null }) {
  const req = new EventEmitter()
  req.url = url
  req.method = method
  req.headers = headers
  if (body !== null) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  } else if (method === 'POST' || method === 'PUT') {
    process.nextTick(() => req.emit('end'))
  }
  return req
}
function makeRes() {
  const res = {
    status: 0,
    bodyText: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.bodyText = String(text ?? ''); this.finished = true },
  }
  return res
}

async function makeMounted(policy = 'auto', cfg = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-http-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { writePolicy: policy, ...cfg },
    gate: async () => ({ outcome: policy === 'auto' ? 'allowed' : 'queued', source: policy === 'auto' ? 'gate' : 'proposals' }),
  })
  const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.mjs')).href)
  let registered = null
  const ctx = {
    inject: (names, cb) => { cb({ webServer: { register: (def) => { registered = def; return () => {} } } }) },
    effect: (thunk) => thunk(),
    provide: () => {},
    get: () => undefined,
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    tools: { register: () => {} },
  }
  index.apply(ctx, { hubDir: hub, writePolicy: policy, ...cfg })
  assert.ok(registered, 'webServer.register 应被调用')
  return { hub, store, service, handler: registered.handler }
}

async function call(handler, { url, method = 'GET', headers = {}, body = null }) {
  const req = makeReq({ url, method, headers, body })
  const res = makeRes()
  await handler(req, res)
  return { status: res.status, json: JSON.parse(res.bodyText || '{}') }
}

test('fence：Host 主机名精确匹配（localhost.evil.com / 127.0.0.1.evil.com 拒绝）', async () => {
  const { handler } = await makeMounted()
  const evil1 = await call(handler, { url: '/memory-hub/api/stats', headers: { host: 'localhost.evil.com:7300' } })
  assert.equal(evil1.status, 403)
  const evil2 = await call(handler, { url: '/memory-hub/api/stats', headers: { host: '127.0.0.1.evil.com:7300' } })
  assert.equal(evil2.status, 403)
  const evil3 = await call(handler, { url: '/memory-hub/api/stats', headers: { host: '[::2]:7300' } })
  assert.equal(evil3.status, 403)
  const okLocal = await call(handler, { url: '/memory-hub/api/stats', headers: { host: 'localhost:7300' } })
  assert.equal(okLocal.status, 200)
  const okV6 = await call(handler, { url: '/memory-hub/api/stats', headers: { host: '[::1]:7300' } })
  assert.equal(okV6.status, 200)
})

test('fence：Origin 与 Host 不一致拒绝；一致放行', async () => {
  const { handler } = await makeMounted()
  const bad = await call(handler, { url: '/memory-hub/api/stats', headers: { host: 'dsh.app', origin: 'http://evil.com' } })
  assert.equal(bad.status, 403)
  const ok = await call(handler, { url: '/memory-hub/api/stats', headers: { host: 'dsh.app', origin: 'https://dsh.app' } })
  assert.equal(ok.status, 200)
})

test('写端点方法白名单：GET forget/adopt/update/reject/restore → 405', async () => {
  const { handler } = await makeMounted()
  for (const method of ['forget', 'adopt', 'update', 'reject', 'restore']) {
    const res = await call(handler, { url: `/memory-hub/api/${method}?id=mem-0000000000000000`, headers: { host: 'localhost:7300' } })
    assert.equal(res.status, 405, `${method} GET 应 405（此前 GET 即触发写）`)
  }
  // POST 正常路由（不存在的 id → 404，不是 405）
  const post = await call(handler, { url: '/memory-hub/api/forget', method: 'POST', headers: { host: 'localhost:7300' }, body: JSON.stringify({ id: 'mem-0000000000000000' }) })
  assert.equal(post.status, 404)
})

test('GET 布尔归一：includeExpired=true（字符串）生效', async () => {
  const { handler, service } = await makeMounted()
  const { writeFileSync, mkdirSync } = await import('node:fs')
  await service.commit({ entry: { title: '过期事实', keywords: ['过期'], expiresAt: '2000-01-01' } })
  const withoutFlag = await call(handler, { url: '/memory-hub/api/search?q=' + encodeURIComponent('过期'), headers: { host: 'localhost:7300' } })
  assert.equal(withoutFlag.json.data.count, 0, '过期默认排除')
  const withFlag = await call(handler, { url: '/memory-hub/api/search?q=' + encodeURIComponent('过期') + '&includeExpired=true', headers: { host: 'localhost:7300' } })
  assert.equal(withFlag.json.data.count, 1, 'GET includeExpired=true 应生效（旧缺陷：字符串 true !== true 永不生效）')
})

test('错误码映射：INVALID_INPUT → 400；未知方法 → 404；畸形 URL → 400', async () => {
  const { handler } = await makeMounted()
  const bad = await call(handler, { url: '/memory-hub/api/adopt', method: 'POST', headers: { host: 'localhost:7300' }, body: '{}' })
  assert.equal(bad.status, 400, '参数缺失应 400（旧为 404 语义错配）')
  assert.equal(bad.json.error.code, 'INVALID_INPUT')
  const unknown = await call(handler, { url: '/memory-hub/api/nosuch', headers: { host: 'localhost:7300' } })
  assert.equal(unknown.status, 404)
  const subdir = await call(handler, { url: '/memory-hub/api/a/b', headers: { host: 'localhost:7300' } })
  assert.equal(subdir.status, 404)
})

test('POST body 超上限（>1MB）→ 413 PAYLOAD_TOO_LARGE', async () => {
  const { handler } = await makeMounted()
  const big = JSON.stringify({ q: 'x'.repeat(1100 * 1024) })
  const res = await call(handler, { url: '/memory-hub/api/update', method: 'POST', headers: { host: 'localhost:7300' }, body: big })
  assert.equal(res.status, 413, `实际 ${res.status}`)
})

test('logs.latest 取尾部（最新日志可见）', async () => {
  const { handler, service } = await makeMounted()
  service.log({ scope: 'daily', text: '旧行AAAA' })
  service.log({ scope: 'daily', text: '新行ZZZZ' })
  const res = await call(handler, { url: '/memory-hub/api/logs?scope=daily', headers: { host: 'localhost:7300' } })
  const latest = res.json.data.latest
  assert.ok(latest.includes('新行ZZZZ'), '最新行必须在 tail 切片中')
  assert.ok(latest.indexOf('新行ZZZZ') > latest.indexOf('旧行AAAA'), '顺序为时间正序（新在后）')
})

test('restore 端点：归档条目可恢复（含审计与双态清理）', async () => {
  const { handler, service, store } = await makeMounted()
  const r = await service.commit({ entry: { title: '待恢复' } })
  const id = r.entry.id
  const removed = await call(handler, { url: '/memory-hub/api/forget', method: 'POST', headers: { host: 'localhost:7300' }, body: JSON.stringify({ id }) })
  assert.equal(removed.status, 200)
  const restored = await call(handler, { url: '/memory-hub/api/restore', method: 'POST', headers: { host: 'localhost:7300' }, body: JSON.stringify({ packId: 'global-pack', name: r.entry.name }) })
  assert.equal(restored.status, 200, JSON.stringify(restored.json))
  assert.equal(restored.json.data.restored.id, id)
  assert.ok(store.findById(id), '恢复后活跃可见')
  assert.equal(store.allArchived().filter((a) => a.entry.id === id).length, 0, '归档副本已清理（无双态）')
})

test('缓存头：所有响应 no-store（数据面不缓存）', async () => {
  const { handler } = await makeMounted()
  const req = makeReq({ url: '/memory-hub/api/stats', headers: { host: 'localhost:7300' } })
  const res = makeRes()
  await handler(req, res)
  assert.equal(res.headers['cache-control'], 'no-store')
})
