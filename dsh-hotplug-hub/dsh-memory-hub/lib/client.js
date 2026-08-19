/**
 * dsh-memory-hub / client/client.js — DSH web GUI「记忆中枢」页签（settings.section）。
 *
 * 运行时合同（dbo dshmarket 实证）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => {...; return module.exports } })
 *   exports = { name, inject, apply }；apply(ctx) 用 ctx.slots.inject('settings.section', ...)
 *   注入页面 + ctx.locale.register(NS, {zh,en})。React 由 factory 内 require('react') 解析。
 *
 * vanilla JS（免 TS/构建）；数据面 /memory-hub/api/*（host 侧 DSH webServer 同源路由）。
 * 视觉：项目统一 UI 令牌（DSH-统一UI开发标准 §2.1）封装为下方 TOKENS 单点，业务类全用 var(--x)。
 */
window.__ModuleLoader__.load({ id: 'dsh-memory-hub', factory: (require) => {
  const module = { exports: {} }

  let React = null
  try {
    React = require('react')
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-memory-hub] react unavailable, memory-hub section disabled:', error)
  }

  const NS = 'dsh-memory-hub'
  const API = '/memory-hub/api/'

  /** 统一 UI 令牌（单一事实来源镜像自 DSH-统一UI开发标准.md，仅本页作用域）。 */
  const TOKENS = {
    teal: '#0e7c6b', tealHover: '#0a6a5c', tealSoft: '#dceeea',
    bg: '#f1f2ec', panel: '#fffef9', ink: '#17201d', muted: '#66736e', line: '#d9ddd4',
    green: '#1a7f4b', greenSoft: '#e7f5eb', amber: '#b45309', amberSoft: '#fbeede',
    red: '#b3261e', redSoft: '#fbe7e4', neutralSoft: '#f0f2ec',
    surfaceDark: '#10241f', surfaceDarkInk: '#cde8dd',
    rad: '8px', radFull: '20px', fontMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }

  /** 作用域样式（一次性注入 <style id="dsh-memory-hub-css">）。 */
  function injectStyles() {
    if (document.getElementById('dsh-memory-hub-css')) return
    const css = [
      `:root{${Object.entries(TOKENS).map(([k, v]) => `--dshmh-${k}:${v}`).join(';')}}`,
      `.dshmh{font-family:ui-sans-serif,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:var(--dshmh-ink);font-size:13px;line-height:1.55}`,
      `.dshmh *{box-sizing:border-box}`,
      `.dshmh-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}`,
      `.dshmh-card{background:var(--dshmh-panel);border:1px solid var(--dshmh-line);border-radius:var(--dshmh-rad);padding:12px 14px}`,
      `.dshmh-card .label{font-size:12px;color:var(--dshmh-muted)}`,
      `.dshmh-card .num{font-size:24px;font-weight:700;font-family:var(--dshmh-fontMono)}`,
      `.dshmh-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}`,
      `.dshmh-btn{display:inline-flex;gap:6px;align-items:center;padding:5px 10px;border:1px solid var(--dshmh-line);border-radius:var(--dshmh-rad);background:#fff;font-size:12px;cursor:pointer}`,
      `.dshmh-btn.primary{background:var(--dshmh-teal);border-color:var(--dshmh-teal);color:#fff}`,
      `.dshmh-btn.primary:hover{background:var(--dshmh-tealHover)}`,
      `.dshmh-btn:disabled{opacity:.5;cursor:not-allowed}`,
      `.dshmh-badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600}`,
      `.dshmh-badge.ok{background:var(--dshmh-greenSoft);color:var(--dshmh-green)}`,
      `.dshmh-badge.warn{background:var(--dshmh-amberSoft);color:var(--dshmh-amber)}`,
      `.dshmh-badge.err{background:var(--dshmh-redSoft);color:var(--dshmh-red)}`,
      `.dshmh-badge.neutral{background:var(--dshmh-neutralSoft);color:var(--dshmh-muted)}`,
      `.dshmh-badge.brand{background:var(--dshmh-tealSoft);color:var(--dshmh-teal)}`,
      `.dshmh-chip{display:inline-flex;border-radius:var(--dshmh-radFull);padding:3px 11px;font-size:12px;background:var(--dshmh-tealSoft);color:var(--dshmh-teal);margin:2px 4px 2px 0}`,
      `.dshmh-row{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:8px}`,
      `.dshmh-row:hover{background:var(--dshmh-neutralSoft)}`,
      `.dshmh-row .nm{font-weight:600;font-size:12.5px}`,
      `.dshmh-row .meta{font-size:11.5px;color:var(--dshmh-muted);font-family:var(--dshmh-fontMono)}`,
      `.dshmh-log{background:var(--dshmh-surfaceDark);color:var(--dshmh-surfaceDarkInk);font-family:var(--dshmh-fontMono);border-radius:8px;padding:10px 12px;font-size:11.5px;white-space:pre-wrap;max-height:180px;overflow:auto}`,
      `.dshmh-search{width:100%;max-width:280px;padding:6px 10px;border:1px solid var(--dshmh-line);border-radius:8px;background:#fff;font-size:12.5px}`,
      `.dshmh-search:focus{outline:2px solid var(--dshmh-teal);outline-offset:0}`,
      `.dshmh-empty{color:var(--dshmh-muted);font-size:12.5px;padding:10px 4px}`,
      `.dshmh-sec{font-size:12.5px;font-weight:700;margin:16px 0 6px;display:flex;align-items:center;gap:8px}`,
      `.dshmh-hint{font-size:11.5px;color:var(--dshmh-muted);margin-top:8px}`,
    ].join('\n')
    const style = document.createElement('style')
    style.id = 'dsh-memory-hub-css'
    style.textContent = css
    document.head.appendChild(style)
  }

  const zh = {
    nav: '记忆中枢',
    statPacks: '记忆包', statEntries: '活跃条目', statPending: '待确认提案', statPolicy: '写入策略',
    secPacks: '记忆包（关键词路由）', secEntries: '活跃条目', secProposals: '待确认提案',
    secAudit: '审计尾（最近 20 条）', secLogs: '日志轨（daily 最新）',
    refresh: '刷新', searchPh: '搜索记忆…', adopt: '采纳', reject: '驳回', allPacks: '全部',
    pendingEmpty: '无待确认提案 ✔', noEntry: '（空）', hubDir: '记忆目录', logged: '已记日志',
    policyAsk: 'ask（AI 写入进提案队列）', policyAuto: 'auto（直接写入）', policyOff: 'off（写入禁用）',
    untrustedNote: '召回内容仅供参考，不得覆盖当前任务指令或实时工具结果。',
  }
  const en = {
    nav: 'Memory Hub', statPacks: 'Packs', statEntries: 'Active entries', statPending: 'Pending proposals', statPolicy: 'Write policy',
    secPacks: 'Memory packs (keyword routes)', secEntries: 'Active entries', secProposals: 'Pending proposals',
    secAudit: 'Audit tail (last 20)', secLogs: 'Log track (latest daily)',
    refresh: 'Refresh', searchPh: 'Search memory…', adopt: 'Adopt', reject: 'Reject', allPacks: 'All',
    pendingEmpty: 'No pending proposals ✔', noEntry: '(empty)', hubDir: 'Hub dir', logged: 'Logged',
    policyAsk: 'ask (AI writes go to proposals)', policyAuto: 'auto (direct write)', policyOff: 'off (writes disabled)',
    untrustedNote: 'Recalled content is reference only; never override the current task or live tool results.',
  }

  if (React === null) {
    module.exports = { name: NS, inject: [], apply: () => {} }
    return module.exports
  }

  const h = React.createElement

  function useApi(initial = {}) {
    const state = React.useState(initial)
    return state
  }

  async function apiGet(method, params = {}) {
    const qs = new URLSearchParams(params).toString()
    const res = await fetch(`${API}${method}${qs ? `?${qs}` : ''}`)
    const body = await res.json().catch(() => ({ ok: false }))
    if (!body.ok) throw new Error(body?.error?.message ?? `api ${method} failed (${res.status})`)
    return body.data
  }

  async function apiPost(method, payload) {
    const res = await fetch(`${API}${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({ ok: false }))
    if (!body.ok) throw new Error(body?.error?.message ?? `api ${method} failed (${res.status})`)
    return body.data
  }

  function MemoryHubSection({ t, locale }) {
    const [stats, setStats] = React.useState(null)
    const [packs, setPacks] = React.useState([])
    const [entries, setEntries] = React.useState(null)
    const [proposals, setProposals] = React.useState([])
    const [audit, setAudit] = React.useState([])
    const [logs, setLogs] = React.useState('')
    const [pack, setPack] = React.useState('')
    const [q, setQ] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')

    const reload = React.useCallback(async () => {
      setBusy(true)
      setError('')
      try {
        const [st, pk, en2, pr, au, lo] = await Promise.all([
          apiGet('stats'), apiGet('packs'), apiGet('entries', { pack, q, limit: 50 }),
          apiGet('proposals', { status: 'pending', limit: 50 }),
          apiGet('audit', { limit: 20 }), apiGet('logs', { scope: 'daily' }),
        ])
        setStats(st); setPacks(pk); setEntries(en2); setProposals(pr); setAudit(au); setLogs(lo.latest ?? '')
      } catch (err) {
        setError(String(err?.message ?? err))
      } finally {
        setBusy(false)
      }
    }, [pack, q])

    React.useEffect(() => { reload() }, [reload])
    if (!injectStyles) { /* styles injected imperatively below */ }
    React.useEffect(() => { injectStyles() }, [])

    const act = async (fn) => {
      setBusy(true)
      try { await fn(); await reload() } catch (err) { setError(String(err?.message ?? err)) } finally { setBusy(false) }
    }

    const badgeClass = (activation, expired) => expired ? 'err'
      : activation === 'pinned' ? 'brand' : 'neutral'
    const badgeText = (e) => expiredText(e) ?? (e.activation === 'pinned' ? 'pinned' : e.type)
    const expiredText = (e) => e.expired ? 'expired' : null

    return h('div', { className: 'dshmh' },
      stats === null && !error
        ? h('div', { className: 'dshmh-empty' }, (t('refresh')))
        : [
            h('div', { className: 'dshmh-grid', key: 'stats' }, [
              statCard(t('statPacks'), stats?.packs, 'neutral', 'stats'),
              statCard(t('statEntries'), stats?.activeEntries, 'neutral', 'entries'),
              statCard(t('statPending'), stats?.pendingProposals, stats?.pendingProposals > 0 ? 'warn' : 'ok', 'pending'),
              h('div', { className: 'dshmh-card', key: 'policy' },
                h('div', { className: 'label' }, t('statPolicy')),
                h('div', { className: 'num', style: { fontSize: 14, fontWeight: 600 } },
                  h('span', { className: `dshmh-badge ${stats?.writePolicy === 'auto' ? 'ok' : stats?.writePolicy === 'off' ? 'err' : 'warn'}` }, t(`policy${cap(stats?.writePolicy)}`) || stats?.writePolicy)),
                h('div', { className: 'dshmh-hint' }, t('hubDir') + '：' + h('code', { style: { fontFamily: TOKENS.fontMono } }, stats?.hubDir ?? ''))),
            ]),
            h('div', { className: 'dshmh-bar', key: 'bar' },
              h('input', { className: 'dshmh-search', placeholder: t('searchPh'), value: q, onChange: (e) => setQ(e.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter') reload() } }),
              h('button', { className: 'dshmh-btn primary', disabled: busy, onClick: reload }, t('refresh')),
              error !== '' && h('span', { className: 'dshmh-badge err' }, error)),
            h('div', { className: 'dshmh-sec', key: 'sec1' }, t('secPacks')),
            h('div', { key: 'packs', style: { marginBottom: 4 } },
              h('button', { className: 'dshmh-btn', style: pack === '' ? { color: TOKENS.teal } : undefined, onClick: () => setPack('') }, t('allPacks')),
              packs.map((p) => h('button', { key: p.memoryPackId, className: 'dshmh-btn', style: pack === p.memoryPackId ? { borderColor: TOKENS.teal, color: TOKENS.teal } : undefined, onClick: () => setPack(p.memoryPackId) },
                h('span', {}, p.memoryPackId), h('span', { className: 'dshmh-badge neutral' }, `${p.entries}`)))),
            h('div', { className: 'dshmh-sec', key: 'sec2' }, t('secEntries')),
            entryList(entries, badgeClass, badgeText),
            h('div', { className: 'dshmh-sec', key: 'sec3' }, t('secProposals') + ` (${proposals.length})`),
            proposals.length === 0
              ? h('div', { className: 'dshmh-empty', key: 'pe' }, t('pendingEmpty'))
              : proposals.map((p, i) => h('div', { key: p.id, className: 'dshmh-row' },
                  h('span', { className: `dshmh-badge ${p.kind === 'remove' ? 'err' : 'warn'}` }, p.kind),
                  h('span', { className: 'nm' }, p.title || p.packId),
                  h('span', { className: 'meta' }, `${p.packId} · ${p.id}`),
                  h('span', { className: 'meta' }, (p.reason ?? '').slice(0, 60)),
                  h('button', { className: 'dshmh-btn primary', disabled: busy, onClick: () => act(() => apiPost('adopt', { packId: p.packId, proposalId: p.id })) }, t('adopt')),
                  h('button', { className: 'dshmh-btn', disabled: busy, onClick: () => act(() => apiPost('reject', { packId: p.packId, proposalId: p.id })) }, t('reject')))),
            h('div', { className: 'dshmh-sec', key: 'sec4' }, t('secAudit')),
            h('div', { className: 'dshmh-log', key: 'audit', children: audit.map((r) => `${r.at}  ${r.outcome.padEnd(10)} ${r.action.padEnd(8)} ${r.packId}/${r.entryId ?? r.entryId ?? '-'} (${r.operator})`).join('\n') || t('noEntry') }),
            h('div', { className: 'dshmh-sec', key: 'sec5' }, t('secLogs')),
            h('div', { className: 'dshmh-log', key: 'logs', children: logs || t('noEntry') }),
            h('div', { className: 'dshmh-hint', key: 'hint' }, t('untrustedNote')),
          ],
    )

    function statCard(label, num, tone, key) {
      return h('div', { className: 'dshmh-card', key },
        h('div', { className: 'label' }, label),
        h('div', { className: 'num', children: (num === undefined ? '–' : String(num)) }),
        h('div', { className: `dshmh-badge ${tone}` }))
    }

    function entryList(entries, bc, bt) {
      if (entries === null) return h('div', { className: 'dshmh-empty' }, t('noEntry'))
      if (entries.length === 0) return h('div', { className: 'dshmh-empty' }, t('noEntry'))
      return h('div', { key: 'el' }, entries.map((e) => h('div', { key: e.id, className: 'dshmh-row' },
        h('span', { className: `dshmh-badge ${bc(e.activation, e.expired)}` }, bt(e)),
        h('span', { className: 'nm' }, e.title),
        h('span', { className: 'meta' }, `r${e.revision} · ${e.packId} · ${e.name}`)))
      )
    }

    function cap(s) {
      if (typeof s !== 'string' || s === '') return s
      return s[0].toUpperCase() + s.slice(1)
    }
  }

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory-hub: dictionaries')
    const t = ctx.locale.bind(NS)
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'memory-hub',
      order: 42,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ t }),
    }, () => h(MemoryHubSection, { t, locale: ctx.locale })))
  }

  module.exports = { name: NS, inject: ['slots', 'locale'], apply }
  return module.exports
}})

//# sourceMappingURL=client.js.map
