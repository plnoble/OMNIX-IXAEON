/**
 * V3 验收：独立验证（零依赖档）跑的程序连不出去。
 *
 * 来由（整合方 2026-10-05，为「验收先行」查沙箱）：零依赖档靠 Node 权限模型，实测它拦住了
 * 起子进程、读写副本外的文件，**没有拦联网**。验证跑的是执行器（Codex 或用户的模型）写的代码：
 * 能读整份项目副本，又能联网，就能把副本发到任何地方。验收先行会让「跑模型写的测试」成为常态，
 * 这个口子要先堵上。
 *
 * 条件：
 * 1. 验证程序里的联网都失败：fetch、http、https、net、tls、http2、dgram、dns、WebSocket、
 *    process.binding。本机监听着的 HTTP 端口和 UDP 端口，一个请求、一个包都没收到。
 * 2. 零依赖档只跑「node 脚本 [参数…]」和「node -e 代码」这两种写法。脚本名（或 -e）之前带了
 *    别的启动参数就不跑，并如实说明是哪个参数：预加载（--require / -r / --import / --loader）、
 *    环境文件（--env-file，里面能写 NODE_OPTIONS）这些都会抢在断网之前执行，调试端口
 *    （--inspect）会开监听。不逐个去认，没见过的一律不跑。-e 的代码后面再跟参数也不跑。
 *    原来就有的规矩不变：命令自带的 --permission / --allow-fs-* 被去掉，照跑。
 * 3. 该能做的照做：读写副本里的文件、node:test、退出码如实；脚本名后面的参数原样传给脚本。
 * 4. `-e` 的命令同样拦。
 *
 * 这是进程内的拦截，不是操作系统级的隔离（那是依赖档的沙箱）。条件 1 列的是已知的入口。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCheck } from '../../src/execution/executor.js';

let http: Server;
let udp: UdpSocket;
let httpPort = 0;
let udpPort = 0;
let httpHits = 0;
let udpHits = 0;
let cwd: string;

beforeAll(async () => {
  http = createServer((_req, res) => {
    httpHits += 1;
    res.end('ok');
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpPort = (http.address() as { port: number }).port;
  udp = createSocket('udp4');
  udp.on('message', () => {
    udpHits += 1;
  });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  udpPort = udp.address().port;
});

afterAll(() => {
  http.close();
  udp.close();
});

beforeEach(() => {
  httpHits = 0;
  udpHits = 0;
  cwd = mkdtempSync(join(tmpdir(), 'ixa-v3-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const write = (name: string, body: string) => writeFileSync(join(cwd, name), body);
const run = (...args: string[]) => defaultCheck([process.execPath, ...args], cwd);
/** 等一小会儿：万一有包发出去了，让本机的监听来得及收到。 */
const settle = () => new Promise((r) => setTimeout(r, 300));
const lastJson = (output: string) =>
  JSON.parse(output.trim().split('\n').pop() ?? 'null') as Record<string, string>;

/** 每种联网方式各试一次，把结果打印成一行 JSON。成功记 ALLOWED，失败记 blocked。 */
function probeScript(): string {
  const url = `http://127.0.0.1:${httpPort}/`;
  return `
const out = {};
const T = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
const attempt = async (name, fn) => {
  try { await T(fn()); out[name] = 'ALLOWED'; } catch (e) { out[name] = 'blocked'; }
};
const connectVia = (mod, method, ...args) => new Promise((res, rej) => {
  const s = mod[method](...args, () => { s.end?.(); res(); });
  s.on('error', rej);
});
await attempt('fetch', () => fetch('${url}'));
await attempt('http', async () => { const m = await import('node:http'); await new Promise((res, rej) => m.get('${url}', (r) => { r.resume(); r.on('end', res); }).on('error', rej)); });
await attempt('https', async () => { const m = await import('node:https'); await new Promise((res, rej) => { const q = m.get('https://127.0.0.1:${httpPort}/', () => res()); q.on('socket', (s) => s.on('connect', res)); q.on('error', rej); }); });
await attempt('net', async () => connectVia(await import('node:net'), 'connect', ${httpPort}, '127.0.0.1'));
await attempt('net 具名引入', async () => { const { createConnection } = await import('node:net'); await connectVia({ createConnection }, 'createConnection', ${httpPort}, '127.0.0.1'); });
await attempt('net 经 require', async () => { const { createRequire } = await import('node:module'); const net = createRequire(import.meta.url)('net'); await new Promise((res, rej) => { const s = new net.Socket(); s.on('error', rej); s.connect(${httpPort}, '127.0.0.1', () => { s.end(); res(); }); }); });
await attempt('tls', async () => { const m = await import('node:tls'); await new Promise((res, rej) => { const s = m.connect({ port: ${httpPort}, host: '127.0.0.1' }); s.on('error', rej); s.on('connect', res); setTimeout(res, 1500); }); });
await attempt('http2', async () => { const m = await import('node:http2'); await new Promise((res, rej) => { const c = m.connect('${url}'); c.on('error', rej); c.on('connect', res); setTimeout(res, 1500); }); });
await attempt('dgram', async () => { const m = await import('node:dgram'); const s = m.createSocket('udp4'); await new Promise((res, rej) => s.send('x', ${udpPort}, '127.0.0.1', (e) => (e ? rej(e) : res()))); s.close(); });
// 自带一个不查 DNS 的解析函数：拦 dns 拦不到它，得 dgram / net 自己拦
const ownLookup = (host, options, cb) => cb(null, '127.0.0.1', 4);
await attempt('dgram 自带解析', async () => { const m = await import('node:dgram'); const s = m.createSocket({ type: 'udp4', lookup: ownLookup }); await new Promise((res, rej) => s.send('x', ${udpPort}, 'localhost', (e) => (e ? rej(e) : res()))); s.close(); });
await attempt('net 自带解析', async () => { const m = await import('node:net'); await new Promise((res, rej) => { const s = m.connect({ port: ${httpPort}, host: 'localhost', lookup: ownLookup }, () => { s.end(); res(); }); s.on('error', rej); }); });
await attempt('dns.lookup', async () => { const m = await import('node:dns'); await new Promise((res, rej) => m.lookup('localhost', (e) => (e ? rej(e) : res()))); });
await attempt('dns/promises', async () => { const m = await import('node:dns/promises'); await m.lookup('localhost'); });
await attempt('dns.Resolver', async () => { const m = await import('node:dns'); const r = new m.Resolver(); await new Promise((res, rej) => r.resolve4('localhost', (e) => (e ? rej(e) : res()))); });
await attempt('WebSocket', async () => { const ws = new WebSocket('ws://127.0.0.1:${httpPort}/'); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(res, 1500); }); });
await attempt('process.binding', async () => { process.binding('tcp_wrap'); });
console.log(JSON.stringify(out));
process.exit(0);
`;
}

/** 用预加载时存下来的入口（如果存到了的话）去连。 */
function useSavedScript(): string {
  return `
process.getBuiltinModule('node:fs').writeFileSync('ran.txt', 'x');
const saved = globalThis.__saved;
const out = { preloaded: Boolean(saved) };
if (saved) {
  try { await saved.fetch('http://127.0.0.1:${httpPort}/'); out.fetch = 'ALLOWED'; } catch { out.fetch = 'blocked'; }
  try {
    const net = process.getBuiltinModule('node:net');
    await new Promise((res, rej) => { const s = new net.Socket(); s.on('error', rej); saved.connect.call(s, ${httpPort}, '127.0.0.1', () => { s.end(); res(); }); });
    out.net = 'ALLOWED';
  } catch { out.net = 'blocked'; }
}
console.log(JSON.stringify(out));
process.exit(0);
`;
}
const SAVE_CJS = `const net = require('node:net'); globalThis.__saved = { connect: net.Socket.prototype.connect, fetch: globalThis.fetch };`;
const SAVE_MJS = `const net = process.getBuiltinModule('node:net'); globalThis.__saved = { connect: net.Socket.prototype.connect, fetch: globalThis.fetch };`;

describe('V3 条件 1：验证程序连不出去', () => {
  it('每种联网方式都失败，本机监听的端口一个请求、一个包都没收到', async () => {
    write('probe.mjs', probeScript());
    const r = await run('probe.mjs');
    expect(r.ran).toBe(true);
    expect(r.exitCode, r.output).toBe(0);
    const out = lastJson(r.output);
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(16);
    for (const [way, result] of Object.entries(out)) {
      expect(result, `${way} 应该连不出去`).toBe('blocked');
    }
    await settle();
    expect(httpHits).toBe(0);
    expect(udpHits).toBe(0);
  });
});

describe('V3 条件 2：脚本名之前带了别的启动参数就不跑', () => {
  // [说明, 命令, 输出里要点名的那个参数]
  const cases: Array<[string, string[], string]> = [
    ['--require 文件', ['--require', './save.cjs', 'use.mjs'], '--require'],
    ['-r 文件', ['-r', './save.cjs', 'use.mjs'], '-r'],
    ['--require=文件', ['--require=./save.cjs', 'use.mjs'], '--require'],
    ['--import 文件', ['--import', './save.mjs', 'use.mjs'], '--import'],
    ['--import=文件', ['--import=./save.mjs', 'use.mjs'], '--import'],
    ['--loader', ['--loader=./save.mjs', 'use.mjs'], '--loader'],
    ['--env-file（里面能写 NODE_OPTIONS）', ['--env-file=./opts.env', 'use.mjs'], '--env-file'],
    ['--inspect', ['--inspect=127.0.0.1:0', 'use.mjs'], '--inspect'],
    [
      '带单独取值的参数，后面藏着预加载',
      ['--conditions', 'x', '--require', './save.cjs', 'use.mjs'],
      '--conditions',
    ],
    ['没见过的参数', ['--some-future-flag', 'use.mjs'], '--some-future-flag'],
    [
      '-e 的代码后面再跟参数',
      ['-e', "require('node:fs').writeFileSync('ran.txt', 'x')", '--require', './save.cjs'],
      '--require',
    ],
  ];
  for (const [label, args, flag] of cases) {
    it(`${label}：不跑，说明是哪个参数；脚本没被执行，连不出去`, async () => {
      write('save.cjs', SAVE_CJS);
      write('save.mjs', SAVE_MJS);
      write('opts.env', 'NODE_OPTIONS=--require ./save.cjs\n');
      write('use.mjs', useSavedScript());
      const r = await run(...args);
      expect(r.ran, r.output).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(r.output).toContain(flag);
      expect(existsSync(join(cwd, 'ran.txt')), '脚本不该被执行').toBe(false);
      await settle();
      expect(httpHits).toBe(0);
    });
  }

  it('不带别的启动参数：照跑，联网入口没有被谁抢先存下', async () => {
    write('use.mjs', useSavedScript());
    const r = await run('use.mjs');
    expect(r.ran).toBe(true);
    expect(r.exitCode, r.output).toBe(0);
    expect(lastJson(r.output)['preloaded']).toBe(false);
    expect(existsSync(join(cwd, 'ran.txt'))).toBe(true);
  });

  it('原来就有的规矩不变：命令自带的 --permission / --allow-fs-* 被去掉，照跑', async () => {
    write('use.mjs', useSavedScript());
    const r = await run(
      '--permission',
      '--allow-fs-read=C:/',
      '--allow-fs-write',
      'C:/',
      'use.mjs',
    );
    expect(r.ran, r.output).toBe(true);
    expect(r.exitCode, r.output).toBe(0);
  });
});

describe('V3 条件 3：该能做的照做', () => {
  it('读写副本里的文件、node:test 通过：退出码 0', async () => {
    write('data.txt', '合成内容');
    write(
      'ok.test.mjs',
      `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
test('读写副本里的文件', () => {
  assert.equal(readFileSync(new URL('./data.txt', import.meta.url), 'utf8'), '合成内容');
  writeFileSync(new URL('./written.txt', import.meta.url), '写得进去');
});
`,
    );
    const r = await run('ok.test.mjs');
    expect(r.ran).toBe(true);
    expect(r.exitCode, r.output).toBe(0);
    expect(readFileSync(join(cwd, 'written.txt'), 'utf8')).toBe('写得进去');
  });

  it('node:test 不通过：退出码不是 0', async () => {
    write(
      'bad.test.mjs',
      `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('故意不过', () => assert.equal(1, 2));
`,
    );
    const r = await run('bad.test.mjs');
    expect(r.ran).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it('脚本名后面的参数原样传给脚本（长得像预加载参数也不动）', async () => {
    write('args.mjs', 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(0);');
    const r = await run('args.mjs', '--require', 'x', '--import=y', '--inspect');
    expect(r.exitCode, r.output).toBe(0);
    expect(JSON.parse(r.output.trim().split('\n').pop()!)).toEqual([
      '--require',
      'x',
      '--import=y',
      '--inspect',
    ]);
  });
});

describe('V3 条件 4：-e 的命令同样拦', () => {
  it('-e 里的 fetch 连不出去', async () => {
    const code = `fetch('http://127.0.0.1:${httpPort}/').then(() => console.log('ALLOWED'), () => console.log('blocked')).finally(() => process.exit(0))`;
    const r = await run('-e', code);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).toContain('blocked');
    expect(r.output).not.toContain('ALLOWED');
    await settle();
    expect(httpHits).toBe(0);
  });
});
