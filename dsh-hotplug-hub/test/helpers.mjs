// test/helpers.mjs — 隔离环境与临时 DSH 根（P5：真实 ~/.dsh 零写入）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 建立隔离 DSH 根 + profile（web），返回 { dshHome, cleanup }。 */
export function isolatedDsh(profileName = 'web') {
  const dshHome = mkdtempSync(join(tmpdir(), 'hp-test-dsh-'))
  const profile = join(dshHome, 'profiles', profileName)
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: profileName, private: true, dependencies: {} }, null, 2))
  const cleanup = () => { try { rmSync(dshHome, { recursive: true, force: true }) } catch { /* ok */ } }
  return { dshHome, profile, cleanup }
}

/** 应用隔离 env（DSH_HOME/DSH_PROFILE/HOME/USERPROFILE/PATH…全隔离；删 NODE_OPTIONS）。 */
export function applyIsolatedEnv(dshHome) {
  const prev = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE: process.env.DSH_PROFILE,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS
  }
  process.env.DSH_HOME = dshHome
  process.env.DSH_PROFILE = 'web'
  process.env.HOME = dshHome
  process.env.USERPROFILE = dshHome
  process.env.LOCALAPPDATA = dshHome
  process.env.PATH = dshHome
  delete process.env.NODE_OPTIONS
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** 构造合法 hotpack 包对象。 */
export function samplePack(overrides = {}) {
  return {
    hotpack: '1.0',
    id: 'pack.test',
    name: 'Test Pack',
    version: '1.0.0',
    description: 'desc',
    tags: ['t1'],
    plugins: [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} },
      { id: 'b', name: 'pkg-b', source: { type: 'path', path: 'C:/tmp/pkg-b' }, config: {} },
    ],
    ...overrides,
  }
}
