'use strict';
// test/qa4-infra-extra.test.js — QA4：infra/contracts 细节补测
// classifyStateSignals 阈值边界 / makeError 保留字段剔除 / mergeState 空补丁 /
// defaultRoots 与 home 反推（隔离红线）/ candidatePaths 三平台 / resolveVersion 异常 /
// runlog includeRotated 顺序 / tree-util 条目类型与链接删除。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createFsPort } = require('../ports/fs');
const { makeError, exitCodeForCode } = require('../contracts/errors');
const { defaultRoots } = require('../contracts/constants');
const { mergeState, createEmptyState } = require('../infra/store');
const { createRunLog } = require('../infra/runlog');
const { candidatePaths } = require('../infra/harness');
const { resolveVersion } = require('../domain/resolve');
const { classifyStateSignals } = require('../domain/classify');
const { entryType, removePath } = require('../infra/tree-util');
const { tempDir, isolatedEnv } = require('./helpers');

const fsPort = createFsPort(fs);

describe('QA4 classifyStateSignals（CRASH_LOOP 阈值边界）', () => {
  function st(launch) {
    return { launch };
  }

  it('retries 达阈值 + lastExit 非 0 → CRASH_LOOP', () => {
    const out = classifyStateSignals(st({ lastExit: 1, retries: 3 }));
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('CRASH_LOOP');
  });

  it('retries 未达阈值 → 无信号（单次崩溃不足）', () => {
    expect(classifyStateSignals(st({ lastExit: 1, retries: 2 }))).toHaveLength(0);
    expect(classifyStateSignals(st({ lastExit: 1, retries: 0 }))).toHaveLength(0);
  });

  it('lastExit=0（健康退出）→ 无信号', () => {
    expect(classifyStateSignals(st({ lastExit: 0, retries: 3 }))).toHaveLength(0);
  });

  it('lastExit=null（detach 存活中）→ 无信号', () => {
    expect(classifyStateSignals(st({ lastExit: null, retries: 3 }))).toHaveLength(0);
    expect(classifyStateSignals(st({ lastExit: undefined, retries: 3 }))).toHaveLength(0);
  });

  it('launch 缺失 / state 缺失 → 空数组', () => {
    expect(classifyStateSignals(null)).toEqual([]);
    expect(classifyStateSignals({})).toEqual([]);
    expect(classifyStateSignals(st(null))).toEqual([]);
  });
});

describe('QA4 makeError（保留字段剔除契约）', () => {
  it('extra.code/message/exitCode 一律被剔除，childExitCode 等保留', () => {
    const e = makeError('ERR_INSTALL_FAILED', 'msg', {
      exitCode: 1,
      code: 'ERR_LAUNCH_EXIT',
      message: 'evil',
      childExitCode: 7,
      cause: new Error('root')
    });
    expect(e.code).toBe('ERR_INSTALL_FAILED');
    expect(e.message).toBe('msg');
    expect(e.exitCode).toBe(6); // 契约推导，不被 extra 改写
    expect(e.childExitCode).toBe(7);
    expect(e.cause).toBeInstanceOf(Error);
  });

  it('无 code 兜底 isLauncherError 语义', () => {
    expect(exitCodeForCode(null)).toBe(1);
    expect(exitCodeForCode('')).toBe(1);
    expect(exitCodeForCode('ERR_UNKNOWN_X')).toBe(1);
  });
});

describe('QA4 mergeState（空补丁与字段白名单）', () => {
  it('patch=null / 非对象 → 深拷贝原样返回', () => {
    const base = createEmptyState('demo');
    base.phase = 'INSTALLED';
    expect(mergeState(base, null).phase).toBe('INSTALLED');
    expect(mergeState(base, 'junk').phase).toBe('INSTALLED');
    expect(mergeState(base, 42).phase).toBe('INSTALLED');
  });

  it('patch 只允许 resolved/assemblySha256/phase/install/launch，heal/rollback 永不被覆盖', () => {
    const base = createEmptyState('demo');
    base.heal.quarantined = ['pkg-x'];
    base.rollback.snapshot = { dir: 'x' };
    const p = mergeState(base, {
      heal: { quarantined: [] },
      rollback: { snapshot: null },
      assemblySha256: 'abc',
      phase: 'CHECKED'
    });
    expect(p.heal.quarantined).toEqual(['pkg-x']);
    expect(p.rollback.snapshot).toEqual({ dir: 'x' });
    expect(p.assemblySha256).toBe('abc');
    expect(p.phase).toBe('CHECKED');
  });
});

describe('QA4 defaultRoots / createCore（根与隔离 home 推导）', () => {
  it('defaultRoots 按 baseDir/home 推导四根', () => {
    const r = defaultRoots('C:/base', 'C:/home');
    expect(r.assemblyDir).toBe('C:\\base\\assembly');
    expect(r.sandboxRoot).toBe('C:\\base\\sandbox\\.sandbox');
    expect(r.profilesRoot).toBe('C:\\home\\.dsh\\profiles');
    expect(r.storeRoot).toBe('C:\\home\\.dsh\\hotplug-store');
  });

  it('只注入 roots 时 home 从 storeRoot 反推（A2 隔离红线：绝不静默回退真实 homedir）', () => {
    const core = createCore({ roots: { storeRoot: 'C:/iso-home/.dsh/hotplug-store' } });
    expect(core.config.home).toBe('C:/iso-home');
  });

  it('storeRoot 不符合 .dsh 结构时回退 os.homedir（记录行为）', () => {
    const core = createCore({ roots: { storeRoot: 'C:/weird/root' } });
    expect(core.config.home).toBe(os.homedir());
  });
});

describe('QA4 candidatePaths（三平台候选）', () => {
  it('darwin 候选含 Applications 两形态', () => {
    const list = candidatePaths('darwin', {}, '/Users/u');
    // 首项为字面量（正斜杠），home 派生项经 path.join（平台分隔符）
    expect(list).toContain('/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop');
    expect(list).toContain(path.join('/Users/u', 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'));
  });

  it('linux 候选含 /usr/local/bin 与 ~/.local/bin', () => {
    const list = candidatePaths('linux', {}, '/home/u');
    expect(list).toContain('/usr/local/bin/dsh');
    expect(list).toContain(path.join('/home/u', '.local', 'bin', 'dsh'));
  });

  it('win32 候选含 LOCALAPPDATA/ProgramFiles 回退', () => {
    const list = candidatePaths('win32', {}, 'C:\\Users\\u');
    expect(list[0]).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe');
    expect(list).toContain('C:\\Program Files\\DSH Desktop\\DSH Desktop.exe');
    expect(list).toContain('C:\\Program Files (x86)\\DSH Desktop\\DSH Desktop.exe');
  });
});

describe('QA4 resolveVersion（registry 异常容错）', () => {
  it('registry.availableVersions 抛异常 → warning 不冒泡 FATAL（C2）', () => {
    const r = resolveVersion('pkg-a', '^1.0.0', {
      availableVersions: () => { throw new Error('registry down'); }
    });
    expect(r.pinned).toBe(false);
    expect(r.warning).toContain('registry 查询失败');
    expect(r.error).toBeUndefined();
  });

  it('availableVersions 非函数 → 按无 registry 处理', () => {
    const r = resolveVersion('pkg-a', '^1.0.0', { availableVersions: 'not-fn' });
    expect(r.pinned).toBe(false);
    expect(r.warning).toContain('无 registry 数据');
  });

  it('仅含预发布版本时 includePrerelease 二次尝试（C2：beta 期插件可解析）', () => {
    const r = resolveVersion('pkg-a', '^1.0.0', {
      availableVersions: () => ['1.0.0-beta.1', '1.0.0-beta.2']
    });
    expect(r.pinned).toBe(true);
    expect(r.resolvedVersion).toBe('1.0.0-beta.2');
    expect(r.source).toBe('registry-prerelease');
  });
});

describe('QA4 runlog includeRotated（合并顺序）', () => {
  it('.1 条目在前、主文件在后（时间序合并）', () => {
    const dir = tempDir('qa4log-');
    const file = path.join(dir, 'run.jsonl');
    const log1 = createRunLog(fsPort, file, { maxBytes: 100, now: () => 1000 });
    log1.append({ stream: 'stdout', line: 'a' });
    log1.append({ stream: 'stdout', line: 'b' }); // 触发滚动
    const log2 = createRunLog(fsPort, file, { maxBytes: 100, now: () => 2000 });
    log2.append({ stream: 'stdout', line: 'c' });
    const all = log2.list({ includeRotated: true });
    expect(all.map((e) => e.line)).toEqual(['a', 'b', 'c']);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]); // 跨滚动全局递增
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('QA4 tree-util（条目类型与链接删除）', () => {
  it('entryType 区分 file/dir/link', () => {
    const dir = tempDir('qa4t-');
    const f = path.join(dir, 'f.txt');
    const d = path.join(dir, 'sub');
    const l = path.join(dir, 'ln');
    fs.writeFileSync(f, 'x');
    fs.mkdirSync(d);
    try { fs.symlinkSync(f, l); } catch (_) { /* 环境不支持则跳过 */ }
    expect(entryType(fs.lstatSync(f))).toBe('file');
    expect(entryType(fs.lstatSync(d))).toBe('dir');
    if (fs.existsSync(l)) expect(entryType(fs.lstatSync(l))).toBe('link');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removePath 删除符号链接本身（不触碰目标）', () => {
    const dir = tempDir('qa4r-');
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(target, 'keep-me');
    try {
      fs.symlinkSync(target, link);
      removePath(fsPort, link);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('keep-me');
    } catch (_) { /* symlink 不可用环境跳过断言 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removePath 递归删除目录树', () => {
    const dir = tempDir('qa4d-');
    const sub = path.join(dir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'x.txt'), 'x');
    removePath(fsPort, dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('QA4 isolatedEnv（隔离红线基础）', () => {
  it('隔离 env 覆盖全部主机探测入口且清除 NODE_OPTIONS', () => {
    const env = isolatedEnv('C:/iso');
    expect(env.HOME).toBe('C:/iso');
    expect(env.USERPROFILE).toBe('C:/iso');
    expect(env.LOCALAPPDATA).toBe('C:/iso');
    expect(env.ProgramFiles).toBe('C:/iso');
    expect(env.PATH).toBe('C:/iso');
    expect(env.DSH_HOME).toBe('C:/iso');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});
