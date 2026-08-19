// launcher/core.js
// DSH-Hotplug-Hub 独立启动器核心：assemble / check / launchAndCapture / selfHeal
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASSEMBLY_DIR = path.join(ROOT, 'assembly');
const SANDBOX_ROOT = path.join(ROOT, 'sandbox', '.sandbox');
const PROFILES_ROOT = path.join(os.homedir(), '.dsh', 'profiles');
const STORE_ROOT = path.join(os.homedir(), '.dsh', 'hotplug-store');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GITHUB_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/'];

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, v) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); }
function appendLine(p, line) { ensureDir(path.dirname(p)); fs.appendFileSync(p, line + '\n', 'utf8'); }

function parseHotpack(input) {
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return { ok: false, error: '不是合法 JSON' }; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '必须是 JSON 对象' };
  if (raw.hotpack !== '1.0') return { ok: false, error: '只支持 hotpack 1.0' };
  const errors = [];
  const id = raw.id, name = raw.name, version = raw.version;
  if (typeof id !== 'string' || !PACK_ID_RE.test(id)) errors.push('id 非法');
  if (typeof name !== 'string' || !name.trim()) errors.push('name 缺失');
  if (typeof version !== 'string' || !EXACT_VERSION_RE.test(version)) errors.push('version 必须是精确版本');
  const plugins = [];
  if (!Array.isArray(raw.plugins) || raw.plugins.length === 0) errors.push('plugins 必须是非空数组');
  for (const [i, item] of (raw.plugins || []).entries()) {
    const at = `plugins[${i}]`;
    if (!item || typeof item !== 'object') { errors.push(`${at} 必须是对象`); continue; }
    const pid = item.id, pname = item.name;
    if (typeof pid !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(pid)) { errors.push(`${at}.id 非法`); continue; }
    if (typeof pname !== 'string' || !PLUGIN_NAME_RE.test(pname)) { errors.push(`${at}.name 不是合法 npm 包名`); continue; }
    const source = item.source || {};
    const type = source.type || 'npm';
    const entry = { id: pid, name: pname, source: { type }, config: item.config || {} };
    if (type === 'npm') {
      if (typeof item.version !== 'string' || !EXACT_VERSION_RE.test(item.version)) { errors.push(`${at} npm 源必须给精确 version`); continue; }
      entry.version = item.version;
    } else if (type === 'path') {
      if (!source.path) { errors.push(`${at} path 源必须给 source.path`); continue; }
      entry.source.path = source.path;
    } else if (type === 'github') {
      if (!source.repo) { errors.push(`${at} github 源必须给 repo`); continue; }
      entry.source.repo = source.repo;
      entry.source.ref = source.ref || 'main';
    } else { errors.push(`${at} source.type 只支持 npm / path / github`); continue; }
    plugins.push(entry);
  }
  if (errors.length) return { ok: false, error: errors.join('；') };
  return { ok: true, pack: { hotpack: '1.0', id, name, version, description: raw.description || '', tags: raw.tags || [], plugins } };
}

function readAssembly(id) {
  const file = path.join(ASSEMBLY_DIR, id, 'assembly.json');
  const raw = readJson(file);
  if (!raw) return { ok: false, error: `找不到 assembly: ${file}` };
  if (raw.hotpack === '1.0') return parseHotpack(raw);
  const packId = raw.packId || raw.id;
  const plugins = (raw.bundles || raw.plugins || []).map((b, i) => ({
    id: b.id || ('p' + i),
    name: b.package || b.name,
    version: b.version,
    source: b.source || { type: 'npm' },
    config: b.config || {}
  }));
  return parseHotpack({ hotpack: '1.0', id: packId, name: raw.name, version: raw.version || '0.0.1', description: raw.description, tags: raw.tags, plugins });
}

function checkConflicts(pack) {
  const conflicts = [];
  const byName = new Map();
  const roles = new Set();
  for (const plugin of (pack.plugins || [])) {
    if (byName.has(plugin.name)) {
      const prev = byName.get(plugin.name);
      if (prev.version !== plugin.version) {
        conflicts.push({ type: 'version', packId: pack.id, plugin: plugin.name, reason: `${prev.version || '?'} vs ${plugin.version || '?'}`, suggest: '停用其中一个包或统一版本' });
      }
    } else {
      byName.set(plugin.name, plugin);
    }
    const role = plugin.config && plugin.config.role;
    if (role && roles.has(role)) {
      conflicts.push({ type: 'role', packId: pack.id, plugin: plugin.name, reason: `重复角色 ${role}`, suggest: '保留角色更完整的包' });
    }
    if (role) roles.add(role);
  }
  return { ok: conflicts.length === 0, conflicts };
}

function resolveAssembly(id) {
  const parsed = readAssembly(id);
  if (!parsed.ok) return parsed;
  const pack = parsed.pack;
  const resolved = {
    assemblyId: id,
    pack,
    pinnedAt: new Date().toISOString(),
    conflicts: checkConflicts(pack).conflicts,
    healActions: []
  };
  writeJson(path.join(ASSEMBLY_DIR, id, 'resolvedAssembly.json'), resolved);
  return { ok: true, resolved };
}

function buildPatchBlock(pack) {
  const lines = [`- insert:  # hotplug:${pack.id}`];
  for (const entry of pack.plugins) {
    lines.push(`    - id: hp-${pack.id}-${entry.id}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64));
    lines.push(`      name: '${entry.name}'`);
    lines.push(`      config: ${JSON.stringify(entry.config || {})}`);
  }
  return lines.join('\n') + '\n';
}

function assemble(id) {
  const resolved = resolveAssembly(id);
  if (!resolved.ok) return resolved;
  const pack = resolved.resolved.pack;
  const sandbox = path.join(SANDBOX_ROOT, id);
  ensureDir(sandbox);
  const manifest = { name: `dsh-launcher-${id}`, version: '0.1.0', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  for (const entry of pack.plugins) {
    if (entry.source.type !== 'npm') {
      const target = entry.source.type === 'path' ? entry.source.path : path.join(STORE_ROOT, `${entry.name}@${entry.source.ref}`);
      manifest.dependencies[entry.name] = `link:${target.replace(/\\/g, '/')}`;
    }
  }
  for (const entry of pack.plugins) {
    if (entry.config && entry.config.bundlePatch === true) {
      if (!manifest.dsh.profile.bundles.includes(entry.name)) manifest.dsh.profile.bundles.push(entry.name);
    }
  }
  writeJson(path.join(sandbox, 'package.json'), manifest);
  fs.writeFileSync(path.join(sandbox, 'cordis.patch.yml'), buildPatchBlock(pack), 'utf8');
  ensureDir(path.join(sandbox, 'logs'));
  return { ok: true, sandbox, pack, steps: pack.plugins.map((p) => ({ id: p.id, name: p.name })) };
}

function syncToProfile(id) {
  const sandbox = path.join(SANDBOX_ROOT, id);
  const profile = path.join(PROFILES_ROOT, id);
  if (!fs.existsSync(path.join(sandbox, 'package.json'))) return { ok: false, error: 'sandbox 不存在，请先 assemble' };
  ensureDir(profile);
  fs.copyFileSync(path.join(sandbox, 'package.json'), path.join(profile, 'package.json'));
  fs.copyFileSync(path.join(sandbox, 'cordis.patch.yml'), path.join(profile, 'cordis.patch.yml'));
  ensureDir(path.join(profile, 'logs'));
  return { ok: true, profile };
}

function findOfficialHarness() {
  if (IS_MAC) {
    const macCandidates = [
      '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      '/Applications/DeepSeek Harness.app/Contents/MacOS/dsh',
      path.join(os.homedir(), 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop'),
      path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness')
    ];
    for (const c of macCandidates) { if (fs.existsSync(c)) return c; }
    // 退回到 dsh CLI
    return 'dsh';
  }

  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
    path.join(process.env.ProgramFiles || '', 'DSH Desktop', 'DSH Desktop.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'DSH Desktop', 'DSH Desktop.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe')
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

function launchAndCapture(id, opts = {}) {
  const synced = syncToProfile(id);
  if (!synced.ok) return synced;
  const harness = findOfficialHarness();
  if (!harness) return { ok: false, error: '未找到官方 DSH 桌面端' };
  const logFile = path.join(SANDBOX_ROOT, id, 'logs', 'run.jsonl');
  ensureDir(path.dirname(logFile));
  const env = { ...process.env, DSH_PROFILE: id };
  const args = IS_MAC && harness === 'dsh' ? ['--profile', id] : [];
  const child = spawn(harness, args, { cwd: synced.profile, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => appendLine(logFile, JSON.stringify({ t: new Date().toISOString(), stream: 'stdout', line: String(d).trim() })));
  child.stderr.on('data', (d) => appendLine(logFile, JSON.stringify({ t: new Date().toISOString(), stream: 'stderr', line: String(d).trim() })));
  child.on('error', (e) => appendLine(logFile, JSON.stringify({ t: new Date().toISOString(), stream: 'error', line: String(e.message) })));
  return { ok: true, pid: child.pid, profile: synced.profile, logFile };
}

function classifyError(line) {
  const s = String(line);
  if (/AUTH|QUOTA|RATE_LIMIT|401|403|429/.test(s)) return { code: 'AUTH_QUOTA', suggest: '检查 API Key / 配额' };
  if (/ENOENT|LINK_FAIL|Cannot find|not found/i.test(s)) return { code: 'LINK_FAIL', suggest: '检查本地路径或链接' };
  if (/network|ETIMEDOUT|ENOTFOUND|download failed|ACQUIRE_FAIL/i.test(s)) return { code: 'NETWORK_FAIL', suggest: '换镜像源重试：' + GITHUB_MIRRORS.join(' / ') };
  if (/bundles|cordis|dsh\.profile\.bundles|dsh\.bundle\.patch/i.test(s)) return { code: 'BUNDLE_CORDIS', suggest: 'bundle↔cordis 重分类' };
  return null;
}

function selfHeal(id, opts = {}) {
  const logFile = path.join(SANDBOX_ROOT, id, 'logs', 'run.jsonl');
  const resolvedFile = path.join(ASSEMBLY_DIR, id, 'resolvedAssembly.json');
  const resolved = readJson(resolvedFile) || { pack: { plugins: [] }, healActions: [] };
  const actions = [];
  if (fs.existsSync(logFile)) {
    for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cls = classifyError(line);
      if (cls) actions.push({ at: new Date().toISOString(), ...cls });
    }
  }
  const unique = Array.from(new Map(actions.map((a) => [a.code, a])).values());
  resolved.healActions = unique;
  if (opts.yes) {
    writeJson(resolvedFile, resolved);
    return { ok: true, healed: unique, note: '已把自愈建议写入 resolvedAssembly.json；请人工确认后再重启 DSH' };
  }
  return { ok: true, healed: unique, note: '预览模式：加 --yes 才会写入自愈建议' };
}

module.exports = { parseHotpack, readAssembly, resolveAssembly, assemble, checkConflicts, syncToProfile, launchAndCapture, selfHeal, findOfficialHarness, GITHUB_MIRRORS, ROOT, ASSEMBLY_DIR, SANDBOX_ROOT };