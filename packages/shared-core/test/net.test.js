'use strict';
// test/net.test.js — TLS 默认拒自签 + ca 钉定 + zip 成员校验（M-39）+ env 净化
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { httpsGetText, validateZipEntryPath, sanitizeChildEnv, CHILD_ENV_BLOCKLIST } = require('../security/net');

describe('validateZipEntryPath（zip slip 防护）', () => {
  it('接受合法相对成员', () => {
    for (const p of ['a.txt', 'dir/b.txt', 'dir/sub/c.txt', 'a-b_c.d/e.json']) {
      expect(validateZipEntryPath(p).ok, p).toBe(true);
    }
  });
  it('拒绝：绝对/盘符/UNC/反斜杠/.. /空段/NUL/超长', () => {
    for (const p of ['', '/etc/passwd', 'C:/x', 'C:\\x', '\\\\server\\share', 'a\\b', '../x', 'a/../../x', './x', 'a//b', 'a\u0000b', 'x'.repeat(4097)]) {
      const r = validateZipEntryPath(p);
      expect(r.ok, JSON.stringify(p)).toBe(false);
    }
  });

  it('拒绝：Windows 保留名/尾点空格/ADS/非法字符（根治：NTFS 归一化 zip-slip 与设备名/流写入面）', () => {
    for (const p of ['CON', 'a/../b', 'a/.. /b', 'a/NUL.txt', 'a/COM1', 'a/x.', 'a/x ', 'a/b:c', 'a/b*c', 'a/b?c', 'a/b|c', 'a/b<c', 'a/b>c', 'a/b"c', 'a/\u0001b']) {
      const r = validateZipEntryPath(p);
      expect(r.ok, JSON.stringify(p)).toBe(false);
    }
  });
});

describe('sanitizeChildEnv', () => {
  it('删除全部 TLS/Node 注入变量，保留其它', () => {
    const env = {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_OPTIONS: '--require=x',
      NODE_EXTRA_CA_CERTS: '/x.pem',
      SSL_CERT_FILE: '/x',
      SSL_CERT_DIR: '/d',
      PATH: '/usr/bin',
      HOME: '/home'
    };
    const out = sanitizeChildEnv(env);
    expect(CHILD_ENV_BLOCKLIST).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    for (const k of CHILD_ENV_BLOCKLIST) expect(out[k]).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home');
  });

  it('keepNodeOptions：仅保留 NODE_OPTIONS，TLS/CA/SSL 仍剥离（harness 例外通道）', () => {
    const env = {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_OPTIONS: '--require=recorder.cjs',
      NODE_EXTRA_CA_CERTS: '/x.pem',
      SSL_CERT_FILE: '/x',
      SSL_CERT_DIR: '/d',
      PATH: '/usr/bin'
    };
    const out = sanitizeChildEnv(env, { keepNodeOptions: true });
    expect(out.NODE_OPTIONS).toBe('--require=recorder.cjs');
    expect(out.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(out.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(out.SSL_CERT_FILE).toBeUndefined();
    expect(out.SSL_CERT_DIR).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  it('keepNodeOptions 且源无 NODE_OPTIONS → 不注入', () => {
    const out = sanitizeChildEnv({ PATH: '/a', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { keepNodeOptions: true });
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});

describe('httpsGetText（本地 TLS 服务）', () => {
  // 生成自签证书（openssl 可用性：Windows 自带？不可用时跳过——用 node 内建 crypto 无法自签，
  // 因此用 openssl；若无 openssl 则跳过该组）
  let server = null;
  let cert = null;
  let key = null;
  let port = 0;
  let hasOpenssl = false;

  beforeAll(() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      hasOpenssl = true;
    } catch { hasOpenssl = false; }
    if (!hasOpenssl) return;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-tls-'));
      cert = path.join(dir, 'cert.pem');
      key = path.join(dir, 'key.pem');
      // 审计修复：`openssl req` 依赖系统 openssl.cnf（Windows 默认指向
      // C:\Program Files\Common Files\ssl\openssl.cnf，Anaconda 等环境该文件缺失会
      // 令证书生成失败且未被兜底 catch 捕获 → 整组崩溃）。现内嵌最小 openssl.cnf 并用
      // -config 显式指定（不依赖系统配置），含 SAN IP（Node 对 IP 校验 SAN；CN 回退已废弃）。
      const cnf = path.join(dir, 'openssl.cnf');
      fs.writeFileSync(cnf, [
        '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no', '',
        '[dn]', 'CN = 127.0.0.1', '',
        '[v3]', 'subjectAltName = IP:127.0.0.1', ''
      ].join('\n'));
      execFileSync('openssl', ['req', '-x509', '-config', cnf, '-newkey', 'rsa:2048',
        '-keyout', key, '-out', cert, '-days', '1', '-nodes'], { stdio: 'ignore' });
    } catch {
      // 证书生成失败（openssl 缺失/损坏/无可用配置）→ 整组优雅跳过，不再崩溃套件
      hasOpenssl = false;
    }
  });

  afterAll(() => {
    if (server) server.close();
  });

  function startServer(handler) {
    return new Promise((resolve) => {
      server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
  }

  it('自签证书默认拒绝（rejectUnauthorized 恒 true）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    await startServer((req, res) => { res.end('ok'); });
    const r = await httpsGetText(`https://127.0.0.1:${port}/x`, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });

  it('钉 ca 后成功（内网自签场景）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    await startServer((req, res) => { res.end('hello-tls'); });
    const r = await httpsGetText(`https://127.0.0.1:${port}/x`, { timeoutMs: 5000, ca: fs.readFileSync(cert) });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.text).toBe('hello-tls');
  });

  it('跟随重定向（≤3 跳）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    await startServer((req, res) => {
      if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); res.end(); return; }
      res.end('landed');
    });
    const r = await httpsGetText(`https://127.0.0.1:${port}/a`, { timeoutMs: 5000, ca: fs.readFileSync(cert) });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('landed');
  });

  it('协议相对重定向 //host/path 正确解析为 https://host/path（根治：不误拼同源畸形路径）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    await startServer((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { Location: `//127.0.0.1:${port}/target` }); res.end(); return; }
      if (req.url === '/target') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('protocol-relative-ok'); return; }
      res.writeHead(404);
      res.end();
    });
    const r = await httpsGetText(`https://127.0.0.1:${port}/start`, { timeoutMs: 5000, ca: fs.readFileSync(cert) });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('protocol-relative-ok');
  });

  it('裸相对重定向（无前导 /）按 RFC 3986 以当前 URL 为 base 解析（审计修复）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    await startServer((req, res) => {
      if (req.url === '/dir/start') { res.writeHead(302, { Location: 'target' }); res.end(); return; }
      if (req.url === '/dir/target') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('relative-ok'); return; }
      res.writeHead(404); res.end();
    });
    const r = await httpsGetText(`https://127.0.0.1:${port}/dir/start`, { timeoutMs: 5000, ca: fs.readFileSync(cert) });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('relative-ok');
  });

  it('跨源重定向剥离 Authorization（审计修复：凭证不外泄）', async () => {
    if (!hasOpenssl) { console.log('SKIP: openssl 不可用'); return; }
    let leakedAuth = null;
    const server2 = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      leakedAuth = req.headers.authorization || null;
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('cross-origin');
    });
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    const port2 = server2.address().port;
    await startServer((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { Location: `https://127.0.0.1:${port2}/final` }); res.end(); return; }
      res.writeHead(404); res.end();
    });
    const r = await httpsGetText(`https://127.0.0.1:${port}/start`, {
      timeoutMs: 5000, ca: fs.readFileSync(cert), headers: { Authorization: 'Bearer SECRET' }
    });
    expect(r.ok).toBe(true);
    expect(leakedAuth).toBe(null); // 跨源不得转发 Authorization
    server2.close();
  });
});
