'use strict';
// test/audit-net.test.js — security/net.js 两处修复的回归测试
//   Bug A（已修）：httpsGetText 跟随重定向时对 Location 做 scheme 校验，非 https 目标
//          （http:/ftp:/file: 等）显式拒绝并 settle——不再裸抛 ERR_INVALID_PROTOCOL（进程级
//          uncaughtException）、不再 TLS 降级、首 Promise 恒 settle。
//   Bug B（已修）：sanitizeChildEnv 的 CHILD_ENV_BLOCKLIST 补齐动态链接器（LD_/DYLD_*）
//          与 git 命令/配置注入面（GIT_*），与「包管理子进程一律全量剥离」契约一致。
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { httpsGetText, sanitizeChildEnv, CHILD_ENV_BLOCKLIST } = require('../security/net');

describe('Bug A：httpsGetText 拒绝非 https 重定向（不降级 / 不崩溃 / Promise 恒 settle）', () => {
  let cert = null;
  let key = null;
  let hasOpenssl = false;
  let server = null;
  const sockets = new Set();

  beforeAll(() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      hasOpenssl = true;
    } catch { hasOpenssl = false; }
    if (!hasOpenssl) return;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-redir-'));
      cert = path.join(dir, 'cert.pem');
      key = path.join(dir, 'key.pem');
      const cnf = path.join(dir, 'openssl.cnf');
      fs.writeFileSync(cnf, [
        '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no', '',
        '[dn]', 'CN = 127.0.0.1', '',
        '[v3]', 'subjectAltName = IP:127.0.0.1', ''
      ].join('\n'));
      execFileSync('openssl', ['req', '-x509', '-config', cnf, '-newkey', 'rsa:2048',
        '-keyout', key, '-out', cert, '-days', '1', '-nodes'], { stdio: 'ignore' });
    } catch {
      hasOpenssl = false;
    }
  });

  afterEach(async () => {
    if (server) {
      for (const s of sockets) { try { s.destroy(); } catch (_) { /* 忽略 */ } }
      await new Promise((r) => server.close(() => r()));
      server = null;
      sockets.clear();
    }
  });

  function startServer(handler) {
    return new Promise((resolve) => {
      server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  // 记录每一次 https.get 的 URL，第一次放行真实请求；第二次（若发生）返回假 req。
  function spyRedirectFollow() {
    const realGet = https.get.bind(https);
    const urls = [];
    const spy = vi.spyOn(https, 'get').mockImplementation(function (url, opts, cb) {
      const href = typeof url === 'string' ? url : (url && url.href);
      urls.push(href);
      if (urls.length === 1) return realGet(url, opts, cb);
      const fake = new EventEmitter();
      fake.setTimeout = () => fake;
      fake.destroy = () => {};
      return fake;
    });
    return { spy, urls };
  }

  it('302 到 http:// → 拒绝跟随（不发起第二次请求、不降级、Promise settle 为失败）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    const port = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:9/evil' });
      res.end();
    });
    const { spy, urls } = spyRedirectFollow();
    try {
      const r = await httpsGetText(`https://127.0.0.1:${port}/x`, { ca: fs.readFileSync(cert), timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      // 非 https 目标被显式拒绝：仅第一次请求发出，无第二次（无 TLS 降级、无裸抛）
      expect(urls.length).toBe(1)
      expect(urls[0]).toBe(`https://127.0.0.1:${port}/x`)
    } finally {
      spy.mockRestore()
    }
  })

  it('302 到 file:// → 同样拒绝跟随（任意非 https scheme 一律拒绝）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    const port = await startServer((req, res) => {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    });
    const { spy, urls } = spyRedirectFollow();
    try {
      const r = await httpsGetText(`https://127.0.0.1:${port}/x`, { ca: fs.readFileSync(cert), timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(urls.length).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('302 到同源 https:// 仍正常跟随（合法重定向不误伤）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    const target = await startServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); })
    const origin = await startServer((req, res) => {
      res.writeHead(302, { Location: `https://127.0.0.1:${target}/final` })
      res.end()
    })
    // 不 spy：origin 恒 302，能取到 'ok' 即证明 https 重定向被正确跟随（ca 透传至第二跳）
    const r = await httpsGetText(`https://127.0.0.1:${origin}/x`, { ca: fs.readFileSync(cert), timeoutMs: 3000 })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('ok')
  })
})

describe('Bug B：sanitizeChildEnv 剥离动态链接器与 git 注入面', () => {
  it('LD_PRELOAD / DYLD_* / GIT_* 等注入变量被剥离，PATH 保留', () => {
    const env = {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_OPTIONS: '--require=evil.cjs',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp/evil-libs',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      DYLD_LIBRARY_PATH: '/tmp/evil-libs',
      GIT_SSH_COMMAND: 'malicious-command',
      GIT_CONFIG_PARAMETERS: "'core.sshCommand=evil'",
      PATH: '/usr/bin'
    }
    const out = sanitizeChildEnv(env)
    expect(out.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(out.NODE_OPTIONS).toBeUndefined()
    expect(out.LD_PRELOAD).toBeUndefined()
    expect(out.LD_LIBRARY_PATH).toBeUndefined()
    expect(out.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(out.DYLD_LIBRARY_PATH).toBeUndefined()
    expect(out.GIT_SSH_COMMAND).toBeUndefined()
    expect(out.GIT_CONFIG_PARAMETERS).toBeUndefined()
    expect(out.PATH).toBe('/usr/bin') // PATH 保留：子进程仍需解析可执行文件
  })

  it('CHILD_ENV_BLOCKLIST 覆盖 TLS/Node + 动态链接器 + git 注入面', () => {
    expect(CHILD_ENV_BLOCKLIST).toEqual(expect.arrayContaining([
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'DYLD_FRAMEWORK_PATH',
      'GIT_SSH_COMMAND',
      'GIT_SSH',
      'GIT_ASKPASS',
      'GIT_EXEC_PATH',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT'
    ]))
  })
})
