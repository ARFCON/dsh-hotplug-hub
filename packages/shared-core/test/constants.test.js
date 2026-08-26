'use strict';
// test/constants.test.js — 常量与根域解析
const path = require('path');
const os = require('os');
const {
  PACK_ID_RE, GITHUB_MIRRORS, RESERVED_WIN_NAMES, resolveDshRoot, dshRootPaths,
  PROFILES_DIR, STORE_DIR, MEMORY_DIR, HOTPLUG_DIR, PATCH_LOCK_FILE, SCHEMA_VERSION, HOTPACK_VERSION
} = require('../contracts/constants');

describe('常量', () => {
  it('GITHUB_MIRRORS 契约主集 = 3（R-v5-5）', () => {
    expect(GITHUB_MIRRORS).toEqual([
      'https://ghfast.top/',
      'https://gh-proxy.com/',
      'https://ghproxy.net/'
    ]);
  });
  it('RESERVED_WIN_NAMES 含全部保留设备名', () => {
    for (const n of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
      expect(RESERVED_WIN_NAMES.has(n)).toBe(true);
    }
    expect(RESERVED_WIN_NAMES.has('COMA')).toBe(false);
  });
  it('版本常量', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(HOTPACK_VERSION).toBe('1.0');
  });
  it('根后缀常量与锁文件名', () => {
    expect(PROFILES_DIR).toBe('profiles');
    expect(STORE_DIR).toBe('hotplug-store');
    expect(MEMORY_DIR).toBe('memory-hub');
    expect(HOTPLUG_DIR).toBe('hotplug-hub');
    expect(PATCH_LOCK_FILE).toBe('.dsh-patch.lock');
  });
});

describe('resolveDshRoot（优先级 DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh）', () => {
  it('DSH_HOTPLUG_ROOT 设定：整个根域落其下（H-1）', () => {
    const r = resolveDshRoot({ DSH_HOTPLUG_ROOT: 'C:/qa/root' });
    expect(r.home).toBe(path.resolve('C:/qa/root'));
    expect(r.dshRoot).toBe(path.join(path.resolve('C:/qa/root'), '.dsh'));
    const p = dshRootPaths(r);
    expect(p.storeDir).toBe(path.join(r.dshRoot, 'hotplug-store'));
    expect(p.profilesDir).toBe(path.join(r.dshRoot, 'profiles'));
  });
  it('DSH_HOME 设定：本身即 .dsh 域目录', () => {
    const r = resolveDshRoot({ DSH_HOME: 'C:/home/me/.dsh' });
    expect(r.dshRoot).toBe(path.resolve('C:/home/me/.dsh'));
    expect(r.home).toBe(path.resolve('C:/home/me'));
  });
  it('缺省：<homedir>/.dsh', () => {
    const r = resolveDshRoot({});
    expect(r.dshRoot).toBe(path.join(os.homedir(), '.dsh'));
    expect(r.home).toBe(os.homedir());
  });
  it('DSH_HOTPLUG_ROOT 空白视为未设定', () => {
    const r = resolveDshRoot({ DSH_HOTPLUG_ROOT: '   ', DSH_HOME: 'C:/x/.dsh' });
    expect(r.dshRoot).toBe(path.resolve('C:/x/.dsh'));
  });
  it('无参调用默认读 process.env（JSDoc 与实现对齐：DSH_HOTPLUG_ROOT 生效）', () => {
    const saved = process.env.DSH_HOTPLUG_ROOT;
    const savedHome = process.env.DSH_HOME;
    try {
      process.env.DSH_HOTPLUG_ROOT = 'C:/qa/bare-root';
      delete process.env.DSH_HOME;
      const r = resolveDshRoot();
      expect(r.home).toBe(path.resolve('C:/qa/bare-root'));
      expect(r.dshRoot).toBe(path.join(path.resolve('C:/qa/bare-root'), '.dsh'));
    } finally {
      if (saved === undefined) delete process.env.DSH_HOTPLUG_ROOT; else process.env.DSH_HOTPLUG_ROOT = saved;
      if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    }
  });
  it('dshRootPaths 全部由 dshRoot 派生', () => {
    const r = resolveDshRoot({ DSH_HOTPLUG_ROOT: 'D:/iso' });
    const p = dshRootPaths(r);
    expect(p.profilesDir).toBe(path.join(r.dshRoot, PROFILES_DIR));
    expect(p.storeDir).toBe(path.join(r.dshRoot, STORE_DIR));
    expect(p.memoryDir).toBe(path.join(r.dshRoot, MEMORY_DIR));
    expect(p.hotplugDir).toBe(path.join(r.dshRoot, HOTPLUG_DIR));
  });
});

describe('正则与 launcher 一致性', () => {
  it('PACK_ID_RE 行为', () => {
    expect(PACK_ID_RE.test('abc')).toBe(true);
    expect(PACK_ID_RE.test('A1_b-c.d')).toBe(true);
    expect(PACK_ID_RE.test('-abc')).toBe(false);
    expect(PACK_ID_RE.test('x'.repeat(65))).toBe(false);
  });
});
