#!/usr/bin/env node
/**
 * scripts/serve-demo.mjs — 小织女仆 · 装配间 本地演示服务（进程隔离，P5 铁律）
 *
 * 把 HotplugGateway（AI 装配间 aiChat + 包管理）跑在**临时隔离根**上，通过
 * 本地 HTTP 服务暴露给浏览器：
 *   GET  /               演示页（人设化对话装配 + 包列表/激活）
 *   POST /api/chat       aiChat（首轮/对话轮，会话持久化于隔离根 ai-sessions/）
 *   GET  /api/status     已导入包 / 激活状态
 *   POST /api/import     一键导入产物
 *   POST /api/activate   激活包（隔离根内真实挂载，重启隔离根即失效）
 *   POST /api/deactivate 卸载
 *
 * 隔离与安全：
 *   - DSH_HOME/HOME/USERPROFILE/LOCALAPPDATA/PATH 指向 mkdtemp 唯一隔离根，
 *     退出（Ctrl+C / 进程结束）即整根删除——真实 ~/.dsh 零触碰；
 *   - API key 只经服务端环境变量（DSH_AI_API_KEY / DSH_DEEPSEEK_API_KEY /
 *     DSH_OPENCODE_API_KEY）读取；页面可选的 key 输入仅随请求内存传递，
 *     不落盘、不进日志、不进会话文件（网关三重脱敏）；
 *   - 删除 NODE_OPTIONS / TLS/CA/SSL 变量（TLS 铁律）；
 *   - 绑定 127.0.0.1（仅本机）。
 *
 * 用法：
 *   DSH_AI_PROVIDER=opencode DSH_OPENCODE_API_KEY=sk-xxx \
 *     node scripts/serve-demo.mjs [--port 3939]
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HotplugGateway } from '../dsh-hotplug-hub/lib/gateway.js'

// ---- 隔离根（P5：零真实域写入） ----
const isoRoot = mkdtempSync(join(tmpdir(), 'dsh-demo-root-'))
const isoDsh = join(isoRoot, '.dsh')
process.env.DSH_HOME = isoDsh
process.env.HOME = isoRoot
process.env.USERPROFILE = isoRoot
process.env.LOCALAPPDATA = join(isoRoot, 'AppData', 'Local')
process.env.PATH = join(isoRoot, 'bin')
process.env.DSH_PROFILE = 'web'
mkdirSync(join(isoRoot, 'bin'), { recursive: true })
for (const k of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
  delete process.env[k]
}

const provider = process.env.DSH_AI_PROVIDER || (process.env.DSH_OPENCODE_API_KEY ? 'opencode' : 'deepseek')
const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 3939)
const gateway = new HotplugGateway({ reflect: { provide: () => {} } })

// ---- 演示页（内嵌：人设化对话装配 + 包管理） ----
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>小织女仆 · 装配间（隔离演示）</title>
<style>
  body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#101418;color:#e8ecf1;margin:0;padding:24px;display:flex;justify-content:center}
  .wrap{width:100%;max-width:860px;display:grid;gap:14px}
  h1{font-size:18px;margin:0}
  .sub{font-size:12px;color:#8b95a1;margin-top:4px}
  .card{background:#171d24;border:1px solid #2a333d;border-radius:10px;padding:14px;display:grid;gap:10px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  label{font-size:12px;color:#8b95a1}
  select,input,textarea{background:#101418;border:1px solid #2a333d;color:#e8ecf1;border-radius:8px;padding:8px 10px;font:13px inherit}
  textarea{width:100%;min-height:90px;resize:vertical;box-sizing:border-box}
  button{background:#1f2937;border:1px solid #374151;color:#e8ecf1;border-radius:8px;padding:8px 16px;cursor:pointer;font:13px inherit}
  button:hover{border-color:#4b5563}
  button.primary{background:#0e7490;border-color:#0e7490;color:#fff}
  button:disabled{opacity:.5;cursor:default}
  .chat{background:#101418;border:1px solid #2a333d;border-radius:10px;padding:10px;min-height:260px;max-height:420px;overflow-y:auto;display:grid;gap:2px}
  .msg{display:flex;gap:8px;padding:8px 4px;border-bottom:1px dashed #232c35}
  .msg:last-child{border-bottom:0}
  .role{flex:0 0 26px;height:26px;line-height:26px;text-align:center;border-radius:50%;background:#1f2937;font-size:14px}
  .body{flex:1;min-width:0;display:grid;gap:4px}
  .text{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
  .err .text{color:#f87171}
  .pack{background:#171d24;border:1px solid #2a333d;border-radius:8px;padding:6px 10px;font-size:12px;color:#8b95a1;display:flex;gap:8px;flex-wrap:wrap}
  .notice{font-size:12px;padding:6px 10px;border-radius:8px}
  .notice.ok{background:#064e3b;color:#6ee7b7}
  .notice.bad{background:#7f1d1d;color:#fca5a5}
  .item{background:#101418;border:1px solid #2a333d;border-radius:8px;padding:8px 10px;font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .tag{font-size:11px;background:#1f2937;border-radius:6px;padding:2px 8px;color:#9ca3af}
  .tag.green{color:#6ee7b7}
  .code{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9ca3af;background:#101418;border-radius:8px;padding:8px;max-height:180px;overflow:auto;white-space:pre-wrap}
</style></head><body><div class="wrap">
  <div><h1>🧹 小织女仆 · 装配间 <span style="font-size:12px;color:#8b95a1">（进程隔离演示 · <span id="isoInfo">…</span>）</span></h1>
  <div class="sub">首轮：描述需求装配插件包；之后直接对话调整（「换掉 xx 插件」「加个功能」）。Key 只经服务端环境变量，本页不留存任何凭据。</div></div>
  <div class="card"><div class="row">
    <label>装配女仆</label>
    <select id="persona"><option value="maid">小织女仆 🧹</option><option value="butler">执事管家 🎩</option><option value="neko">咪咪猫娘 🐱</option><option value="assistant">标准助手 🤖</option></select>
    <label>服务商</label>
    <select id="provider">
      <option value="opencode" ${provider === 'opencode' ? 'selected' : ''}>OpenCode（deepseek-v4-flash）</option>
      <option value="deepseek" ${provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
    </select>
    <label>Key（可选，仅本次会话内存）</label>
    <input type="password" id="apiKey" placeholder="留空 = 服务端环境变量" autocomplete="off" style="flex:1;min-width:180px">
    <button id="newBtn">新会话</button>
  </div></div>
  <div class="card"><div class="chat" id="chat"><div class="text" style="color:#8b95a1">主人，欢迎来到装配间～描述您需要的插件能力，小织为您把插件织成包！</div></div>
    <textarea id="input" placeholder="描述你的工作场景和需要的插件能力；装配完成后继续对话调整（Ctrl+Enter 发送）"></textarea>
    <div class="row"><button class="primary" id="sendBtn">发送</button><span class="tag" id="turnTag"></span></div></div>
  <div id="notice"></div>
  <div class="card"><div class="row"><b style="font-size:13px">已导入的包</b><button id="refreshBtn">刷新</button></div><div id="packs"><div class="sub">暂无</div></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let sessionId = null, turn = 0;
const iso = document.createElement('div');
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function addMsg(role, text, pack, diff, err){
  const el = document.createElement('div');
  el.className = 'msg' + (err ? ' err' : '');
  el.innerHTML = '<div class="role">' + (role==='user'?'🧑':'🧹') + '</div><div class="body"><div class="text">' + esc(text) + '</div>' +
    (pack ? '<div class="pack"><b>'+esc(pack.name)+'</b><span>· '+(pack.plugins?pack.plugins.length:0)+' 个插件</span>' +
      (diff && (diff.added||[]).length+(diff.removed||[]).length+(diff.changed||[]).length>0 ? '<span>· 本轮调整 +'+(diff.added||[]).length+' -'+(diff.removed||[]).length+' ~'+(diff.changed||[]).length+'</span>' : '') + '</div>' : '') + '</div>';
  $('chat').appendChild(el);
  $('chat').scrollTop = $('chat').scrollHeight;
}
async function api(path, body){
  const r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
  return r.json();
}
async function send(){
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  addMsg('user', text);
  $('sendBtn').disabled = true; $('sendBtn').textContent = '装配中…';
  try {
    const r = await api('/api/chat', {input:text, persona:$('persona').value, provider:$('provider').value, apiKey:$('apiKey').value||undefined, sessionId});
    if (!r.ok) { addMsg('assistant', '装配失败：' + (r.message||r.error||''), null, null, true); return; }
    const d = r.data;
    sessionId = d.session.id;
    turn = d.session.turn;
    $('turnTag').textContent = '第 ' + turn + ' 轮';
    if (d.reply) addMsg('assistant', d.reply, d.pack||null, d.diff||null);
    if (d.pack) notice('ok', '已生成：' + d.pack.name);
    loadPacks();
  } catch(e){ addMsg('assistant', '请求失败：' + e.message, null, null, true); }
  finally { $('sendBtn').disabled = false; $('sendBtn').textContent = '发送'; }
}
function notice(kind, text){
  const n = $('notice');
  n.innerHTML = '<div class="notice ' + kind + '">' + esc(text) + '</div>';
  setTimeout(()=>{ n.innerHTML=''; }, 6000);
}
async function loadPacks(){
  const r = await api('/api/status');
  const packs = (r.packs||[]);
  $('packs').innerHTML = packs.length === 0 ? '<div class="sub">暂无</div>' :
    packs.map((p)=>'<div class="item"><span>'+esc(p.name)+'</span><span class="tag">'+esc(p.version||'')+'</span><span class="tag">'+(p.plugins||[]).length+' 个插件</span>'+(p.active?'<span class="tag green">激活中</span>':'')+
      (p.active?'':'<button data-act="'+esc(p.id)+'">激活</button>')+'<button data-remove="'+esc(p.id)+'">移除</button></div>').join('');
  document.querySelectorAll('[data-act]').forEach((b)=>b.addEventListener('click', async ()=>{
    await api('/api/activate', {packId:b.dataset.act}); notice('ok','已激活：'+b.dataset.act+'（重启隔离根后生效）'); loadPacks();
  }));
  document.querySelectorAll('[data-remove]').forEach((b)=>b.addEventListener('click', async ()=>{
    await api('/api/deactivate', {packId:b.dataset.remove});
    if (confirm('移除这个包？')) { await api('/api/remove', {packId:b.dataset.remove}); }
    loadPacks();
  }));
}
$('sendBtn').addEventListener('click', send);
$('input').addEventListener('keydown', (e)=>{ if (e.key==='Enter' && (e.ctrlKey||e.metaKey)) send(); });
$('newBtn').addEventListener('click', ()=>{ if (!confirm('开始新会话？')) return; sessionId=null; turn=0; $('chat').innerHTML='<div class="text" style="color:#8b95a1">主人，欢迎来到装配间～</div>'; $('turnTag').textContent=''; });
$('refreshBtn').addEventListener('click', loadPacks);
loadPacks();
</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const send = (code, obj, ctype = 'application/json') => {
    res.writeHead(code, { 'Content-Type': ctype, 'Cache-Control': 'no-store' })
    res.end(ctype === 'application/json' ? JSON.stringify(obj) : obj)
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') { send(200, PAGE, 'text/html; charset=utf-8'); return }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = {}
      try { body = JSON.parse(await readBody(req)) } catch { /* 空体 */ }
      const method = url.pathname.slice(5)
      if (method === 'chat') {
        const r = await gateway.aiChat({
          input: typeof body.input === 'string' ? body.input : '',
          provider: typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined,
          persona: typeof body.persona === 'string' && body.persona !== '' ? body.persona : undefined,
          sessionId: typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined,
          apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey : undefined,
        })
        send(r.ok ? 200 : 400, r)
        return
      }
      if (method === 'status') { send(200, gateway.status()); return }
      if (method === 'import') {
        const r = gateway.importPack(typeof body.pack === 'string' ? body.pack : JSON.stringify(body.pack || {}))
        send(r.ok ? 200 : 400, r)
        return
      }
      if (method === 'activate') { send(200, await gateway.activate(String(body.packId || ''))); return }
      if (method === 'deactivate') { send(200, await gateway.deactivate()); return }
      if (method === 'remove') { send(200, await gateway.removePack(String(body.packId || ''))); return }
      send(404, { ok: false, error: '未知接口' })
      return
    }
    send(404, { ok: false, error: 'not found' })
  } catch (e) {
    send(500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
})

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1 << 20) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

server.listen(port, '127.0.0.1', () => {
  console.log('')
  console.log('🧹 小织女仆 · 装配间（进程隔离演示）已启动')
  console.log(`   URL:  http://127.0.0.1:${port}/`)
  console.log(`   隔离根: ${isoRoot}（Ctrl+C 退出即整根删除，真实 ~/.dsh 零触碰）`)
  console.log(`   AI:   provider=${provider}（key 经服务端环境变量，不落盘）`)
  console.log('')
})

function cleanup() {
  try { rmSync(isoRoot, { recursive: true, force: true }) } catch { /* ok */ }
  console.log(`隔离根已清理（${isoRoot}）`)
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => { cleanup(); process.exit(0) })
    setTimeout(() => process.exit(0), 800)
  })
}
