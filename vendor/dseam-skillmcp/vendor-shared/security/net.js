'use strict';
// security/net.js — 网络安全：TLS 默认开 + 子进程 env 净化（H-6/M-47/M-50）
// 与 zip 成员安全（zip slip + 符号链接成员，M-39）
const https = require('https');
const { checkWindowsSafeName } = require('../fs/path-safe');

// 子进程 env 净化清单：任何被本仓库 spawn 的子进程都不得携带这些变量。
// 审计修复（进程隔离缺口）：此前只含 5 个 TLS/Node 变量，与注释声称的「npm/git/dsh
// 等包管理子进程一律全量剥离」不符——LD_PRELOAD / DYLD_* 可预加载库劫持原生子进程，
// GIT_* 可注入 git clone 的命令/配置。现补齐动态链接器与 git 注入面。
const CHILD_ENV_BLOCKLIST = [
  // TLS 校验 / Node 行为（不可被静默关闭 / 不可被注入）
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // 动态链接器注入面（pnpm/git/curl/tar 等原生子进程可被预加载库劫持）
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  // git 命令/配置注入面（git clone 子进程）
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  // 审计修复：补「指向外部 config 文件」的注入路径变量——GIT_CONFIG_GLOBAL/SYSTEM
  // 可让 git 从攻击者指定文件读配置（如 `[core] sshCommand=恶意`），与
  // GIT_CONFIG_PARAMETERS/COUNT 主向量同属配置注入面，须一并剥离。
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM'
];

/**
 * 净化子进程环境变量：删除可削弱 TLS / 可注入 Node 行为的变量。
 * R3（Windows 大小写）：env 名在 Windows OS 层大小写不敏感，而 `{...env}` 展开保留
 * 原始大小写、精确大小写 delete 会漏掉 `node_options` / `git_ssh_command` 等变体
 * （封锁清单可被绕过）。win32 下按「大写化比较」剥离全部大小写变体；POSIX env
 * 大小写敏感（`node_options` 是另一个变量），保持精确匹配语义不变。
 * @param {object} env 源环境（通常 process.env）
 * @param {object} [opts]
 * @param {boolean} [opts.keepNodeOptions] 保留 NODE_OPTIONS（仅限已验证的 DSH
 *   harness 场景——launcher launch.js：harness 经 N44 校验且本就执行 profile
 *   代码，NODE_OPTIONS 透传无边际风险，且 QA 录制器（DoD-2 recorder）依赖该
 *   注入通道；npm/git/dsh 等包管理子进程一律全量剥离；win32 下大小写变体同样保留）
 * @returns {object} 净化后的副本
 */
function sanitizeChildEnv(env = {}, opts = {}) {
  const out = { ...env };
  if (process.platform === 'win32') {
    const blocked = new Set(CHILD_ENV_BLOCKLIST.map((k) => k.toUpperCase()));
    for (const key of Object.keys(out)) {
      const upper = key.toUpperCase();
      if (upper === 'NODE_OPTIONS' && opts.keepNodeOptions === true) continue;
      if (blocked.has(upper)) delete out[key];
    }
    return out;
  }
  for (const key of CHILD_ENV_BLOCKLIST) {
    if (key === 'NODE_OPTIONS' && opts.keepNodeOptions === true) continue;
    delete out[key];
  }
  return out;
}

// 重定向时须剥离的敏感请求头（跨源重定向凭证外泄防护；同源保留）。
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** 返回剥离敏感请求头后的 headers 副本（不修改入参）。 */
function stripSensitiveHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) delete out[key];
  }
  return out;
}

/**
 * GET 文本（默认拒绝自签：rejectUnauthorized 恒为 true 且置合并末位，不可被
 * 调用方选项覆盖；TLS 失败即返回 {ok:false}，绝不降级为不校验）。
 * 重定向最多跟随 3 跳；响应体上限 1MB。
 * @param {string} url
 * @param {object} [opts]
 * @param {string|Buffer} [opts.ca] 自定义 CA（内网自签环境钉 CA 用）
 * @param {number} [opts.timeoutMs] 超时（默认 15000）
 * @param {object} [opts.headers] 附加请求头
 * @returns {Promise<{ok: boolean, status: number, text: string}>}
 */
function httpsGetText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs === undefined ? 15000 : opts.timeoutMs;
  const headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : {};
  const hops = opts._hops === undefined ? 0 : opts._hops;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const requestOptions = {
      ...(opts.ca ? { ca: opts.ca } : {}),
      headers,
      // 合并末位：rejectUnauthorized 恒 true，调用方无法覆盖
      rejectUnauthorized: true
    };
    let req;
    try {
      req = https.get(url, requestOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
          res.resume();
          // 统一按 RFC 3986 以「当前 URL」为 base 解析重定向目标，覆盖四种形态：
          // 绝对 URL（https://…）、协议相对（//host/path）、绝对路径（/path）、
          // 裸相对路径（relpath）。此前只处理前三种，裸相对 302 被 fail-closed 拒绝
          // （审计修复）；解析失败或非 https 目标一律显式拒绝并 settle，绝不降级/崩溃。
          let next;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch (_) {
            done({ ok: false, status: 0, text: '' });
            return;
          }
          if (!next.startsWith('https:')) {
            // 只允许继续 https 重定向（拒绝 http/ftp/file 降级）
            done({ ok: false, status: 0, text: '' });
            return;
          }
          // 审计修复（凭证外泄）：跨域重定向时剥离敏感请求头（Authorization/Cookie/
          // Proxy-Authorization），防止凭证经恶意/第三方重定向目标外泄；同源重定向保留全部头。
          let nextHeaders = headers;
          try {
            if (new URL(url).origin !== new URL(next).origin) nextHeaders = stripSensitiveHeaders(headers);
          } catch (_) {
            nextHeaders = stripSensitiveHeaders(headers); // origin 解析失败保守剥离
          }
          done(httpsGetText(next, { ...opts, headers: nextHeaders, _hops: hops + 1 }));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (data.length < 1000000) data += chunk; });
        res.on('end', () => done(res.statusCode === 200 ? { ok: true, status: 200, text: data } : { ok: false, status: res.statusCode, text: '' }));
      });
    } catch (_) {
      // https.get 对非法 URL（非 http(s) scheme / 畸形 URL）同步抛错——归一为失败，不裸抛
      done({ ok: false, status: 0, text: '' });
      return;
    }
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) { /* 忽略 */ } });
    req.on('error', () => done({ ok: false, status: 0, text: '' }));
  });
}

/**
 * 校验 zip 成员路径（zip slip 防护，M-39）：
 * 拒绝空/绝对路径/盘符/UNC/.. 段/反斜杠/NUL/超长；成员一律正斜杠相对路径。
 * @param {unknown} entryPath
 * @returns {{ok: boolean, error?: Error}}
 */
function validateZipEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    return { ok: false, error: new Error('zip 成员路径必须是非空字符串') };
  }
  if (entryPath.length > 4096) {
    return { ok: false, error: new Error('zip 成员路径过长（>4096）') };
  }
  if (entryPath.includes('\u0000')) {
    return { ok: false, error: new Error('zip 成员路径不得包含 NUL') };
  }
  if (entryPath.includes('\\')) {
    return { ok: false, error: new Error(`zip 成员路径不得使用反斜杠：${JSON.stringify(entryPath)}`) };
  }
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath) || entryPath.startsWith('//')) {
    return { ok: false, error: new Error(`zip 成员路径不得为绝对/盘符/UNC：${JSON.stringify(entryPath)}`) };
  }
  const segments = entryPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, error: new Error(`zip 成员路径不得包含空段或 . / ..：${JSON.stringify(entryPath)}`) };
    }
    // 审计修复（根治，Windows zip-slip）：单段名须过 Windows 安全名（保留设备名 /
    // 尾点空格 / 控制字符 / 非法字符）。此前 '.. '（尾空格被 NTFS 归一化为 '..'）、
    // 'CON'（保留设备名）、'a:b'（ADS）均被放行，解包到 Windows 时构成穿越/设备名/
    // 流写入面。复用 checkWindowsSafeName 单一真源（与 ids.validateSourcePath 同源）。
    const w = checkWindowsSafeName(seg, 'zip 成员路径段');
    if (!w.ok) return { ok: false, error: new Error(w.error.message) };
  }
  return { ok: true };
}

module.exports = { httpsGetText, validateZipEntryPath, sanitizeChildEnv, CHILD_ENV_BLOCKLIST };
