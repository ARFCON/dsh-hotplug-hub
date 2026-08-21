'use strict';
// test/ports-contract.test.js — ports/* 端口契约全覆盖（§8.5：ports/* 边界 100%）
// 覆盖：方法清单导出、注入实现的方法绑定（this + 参数透传）、未注入方法抛
// ERR_ENV_UNSUPPORTED（exit 12）、default*Port 空实现抛错、registry 空实现语义、
// now 系统端口（now/iso 含显式时间戳）。
const { createFsPort, defaultFsPort, FS_METHODS } = require('../ports/fs');
const { createProcPort, defaultProcPort, PROC_METHODS } = require('../ports/proc');
const { createNowPort, createSystemNowPort, defaultNowPort, NOW_METHODS } = require('../ports/now');
const { createRegistryPort, createEmptyRegistryPort, defaultRegistryPort, REGISTRY_METHODS } = require('../ports/registry');
const { createDshPort, defaultDshPort, DSH_METHODS } = require('../ports/dsh');
const { isDshError } = require('../contracts/errors');

describe('ports/* 端口契约（§8.5 边界 100%）', () => {
  const CASES = [
    ['fs', createFsPort, defaultFsPort, FS_METHODS],
    ['proc', createProcPort, defaultProcPort, PROC_METHODS],
    ['now', createNowPort, defaultNowPort, NOW_METHODS],
    ['registry', createRegistryPort, defaultRegistryPort, REGISTRY_METHODS],
    ['dsh', createDshPort, defaultDshPort, DSH_METHODS]
  ];

  for (const [name, create, defaultPort, methods] of CASES) {
    describe(`ports/${name}.js`, () => {
      it('导出方法清单与工厂（createXPort/defaultXPort）', () => {
        expect(Array.isArray(methods)).toBe(true);
        expect(methods.length).toBeGreaterThan(0);
        expect(typeof create).toBe('function');
        expect(defaultPort).toBeDefined();
        for (const m of methods) {
          expect(typeof defaultPort[m]).toBe('function');
        }
      });

      it('未注入方法抛 ERR_ENV_UNSUPPORTED（exit 12）且消息含方法名', () => {
        const port = create();
        for (const m of methods) {
          let threw = null;
          try { port[m](); } catch (e) { threw = e; }
          expect(threw, `${name}.${m} 应抛错`).not.toBeNull();
          expect(isDshError(threw)).toBe(true);
          expect(threw.code).toBe('ERR_ENV_UNSUPPORTED');
          expect(threw.exitCode).toBe(12);
          expect(threw.message).toContain('端口未注入');
          expect(threw.message).toContain(m);
        }
      });

      it('default*Port 为空实现：调用即抛 ERR_ENV_UNSUPPORTED（now/registry 默认端口为可用实现，见专门用例）', () => {
        // fs/proc/dsh 的 default*Port 是空实现（未注入即抛）；now 默认=系统时钟、
        // registry 默认=离线空实现，二者是"可用默认"，不在此断言抛错。
        if (name === 'now' || name === 'registry') return;
        for (const m of methods) {
          let threw = null;
          try { defaultPort[m](); } catch (e) { threw = e; }
          expect(threw, `${name}.default.${m} 应抛错`).not.toBeNull();
          expect(threw.code).toBe('ERR_ENV_UNSUPPORTED');
        }
      });

      it('注入实现：方法绑定 impl（this 语义）且参数原样透传', () => {
        const calls = [];
        const impl = {};
        for (const m of methods) {
          impl[m] = function (...args) { calls.push([m, this, args]); return `ret-${m}`; };
        }
        impl.tag = `tag-${name}`;
        const port = create(impl);
        for (const m of methods) {
          const ret = port[m](1, 'x');
          expect(ret).toBe(`ret-${m}`);
        }
        expect(calls.length).toBe(methods.length);
        for (const [m, self, args] of calls) {
          expect(self).toBe(impl); // bind(impl) 后 this === impl
          expect(args).toEqual([1, 'x']);
        }
      });

      it('部分注入：未注入方法仍抛错，注入方法可用', () => {
        const port = create({ [methods[0]]: () => 'ok' });
        expect(port[methods[0]]()).toBe('ok');
        let threw = null;
        try { port[methods[1]](); } catch (e) { threw = e; }
        expect(threw.code).toBe('ERR_ENV_UNSUPPORTED');
      });
    });
  }

  describe('ports/registry.js 特殊语义', () => {
    it('createEmptyRegistryPort：availableVersions → []，resolveBest → null（离线不失败）', () => {
      const p = createEmptyRegistryPort();
      expect(p.availableVersions('any-pkg')).toEqual([]);
      expect(p.resolveBest('any-pkg', '^1.0.0')).toBeNull();
    });
    it('defaultRegistryPort 即空实现（离线安全默认）', () => {
      expect(defaultRegistryPort.availableVersions('x')).toEqual([]);
      expect(defaultRegistryPort.resolveBest('x', '*')).toBeNull();
    });
  });

  describe('ports/now.js 特殊语义', () => {
    it('createSystemNowPort：now() 返回毫秒时间戳；iso() 无参=当前时间、有参=指定时间', () => {
      const p = createSystemNowPort();
      const t = p.now();
      expect(typeof t).toBe('number');
      expect(t).toBeGreaterThan(0);
      const a = p.iso();
      const b = p.iso(0);
      expect(typeof a).toBe('string');
      expect(a.endsWith('Z')).toBe(true);
      expect(new Date(a).getTime()).toBeGreaterThan(0);
      expect(b).toBe('1970-01-01T00:00:00.000Z');
    });
    it('defaultNowPort 可用（系统时钟注入的默认端口）', () => {
      expect(typeof defaultNowPort.now()).toBe('number');
      expect(typeof defaultNowPort.iso()).toBe('string');
    });
  });

  describe('ports/fs.js 方法清单完整性（与消费方契约对齐）', () => {
    it('FS_METHODS 包含锁/原子写/流所需全部方法', () => {
      for (const m of ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'mkdirSync', 'realpathSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync', 'unlinkSync', 'rmSync', 'createReadStream', 'createWriteStream']) {
        expect(FS_METHODS).toContain(m);
      }
    });
  });
});
