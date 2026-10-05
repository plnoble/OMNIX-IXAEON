/**
 * V3 真机检查：零依赖档跑的程序连不出去——用应用实际用的那个可执行文件（Electron 当 node 跑）。
 *
 *   node_modules/.bin/jiti scripts/real/v3-verify-no-network.ts   （脚本会自己换到 Electron 里重跑）
 *
 * 只连本机的两个临时端口（一个 HTTP、一个 UDP），不碰外网，不碰用户的数据。
 * 打印每种联网方式的结果，和本机端口实际收到了几个请求、几个包。
 */
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCheck } from '../../packages/core/src/execution/executor.js';

// 应用里验证命令的可执行文件就是 Electron 自己（当 node 跑）。不在 Electron 里就换过去重跑一遍，
// 这样下面走的和应用里是同一条路：同一个可执行文件、同一个 Node 版本、同一套启动参数。
if (!process.versions.electron) {
  const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const electronExe = desktopRequire('electron') as unknown as string;
  // jiti 不是直接依赖，解析不到；到 pnpm 的目录里找它的命令行入口
  const pnpmDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'node_modules',
    '.pnpm',
  );
  const jitiDir = readdirSync(pnpmDir).find((d) => d.startsWith('jiti@'));
  if (!jitiDir) throw new Error('找不到 jiti（先装依赖）');
  const jitiCli = join(pnpmDir, jitiDir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs');
  const again = spawnSync(electronExe, [jitiCli, fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  process.exit(again.status ?? 1);
}

let httpHits = 0;
let udpHits = 0;
const http = createServer((_req, res) => {
  httpHits += 1;
  res.end('ok');
});
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const httpPort = (http.address() as { port: number }).port;
const udp = createSocket('udp4');
udp.on('message', () => {
  udpHits += 1;
});
await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
const udpPort = udp.address().port;

const cwd = mkdtempSync(join(tmpdir(), 'ixa-v3-real-'));
writeFileSync(
  join(cwd, 'probe.mjs'),
  `
const out = { node: process.versions.node, electron: process.versions.electron ?? null };
const T = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
const attempt = async (name, fn) => { try { await T(fn()); out[name] = '连出去了'; } catch { out[name] = '拦住'; } };
const ownLookup = (host, options, cb) => cb(null, '127.0.0.1', 4);
await attempt('fetch', () => fetch('http://127.0.0.1:${httpPort}/'));
await attempt('http', async () => { const m = await import('node:http'); await new Promise((res, rej) => m.get('http://127.0.0.1:${httpPort}/', (r) => { r.resume(); r.on('end', res); }).on('error', rej)); });
await attempt('net', async () => { const m = await import('node:net'); await new Promise((res, rej) => { const s = m.connect({ port: ${httpPort}, host: 'localhost', lookup: ownLookup }, () => { s.end(); res(); }); s.on('error', rej); }); });
await attempt('dgram', async () => { const m = await import('node:dgram'); const s = m.createSocket({ type: 'udp4', lookup: ownLookup }); await new Promise((res, rej) => s.send('x', ${udpPort}, 'localhost', (e) => (e ? rej(e) : res()))); s.close(); });
await attempt('dns', async () => { const m = await import('node:dns/promises'); await m.lookup('localhost'); });
await attempt('起子进程', async () => { const m = await import('node:child_process'); m.execFileSync(process.execPath, ['-e', '']); });
await attempt('读副本外的文件', async () => { const m = await import('node:fs'); m.readFileSync(process.execPath); });
try { (await import('node:fs')).writeFileSync('inside.txt', 'x'); out['写副本里的文件'] = '可以'; } catch { out['写副本里的文件'] = '不行'; }
console.log(JSON.stringify(out));
process.exit(0);
`,
);

let ok = false;
try {
  // 与应用里一样的调用：可执行文件是 Electron 自己，别的都用默认
  const r = await defaultCheck([process.execPath, 'probe.mjs'], cwd);
  if (!r.ran || r.exitCode !== 0) console.log('验证程序没跑成：', r.output.slice(0, 400));
  const last = r.output.trim().split('\n').pop() ?? '';
  const out = (last.startsWith('{') ? JSON.parse(last) : {}) as Record<string, string>;
  console.log('运行环境：', `Electron ${out['electron']}，Node ${out['node']}`);
  for (const [way, result] of Object.entries(out)) {
    if (way !== 'node' && way !== 'electron') console.log(`${way}：${result}`);
  }
  await new Promise((r2) => setTimeout(r2, 300));
  console.log('本机 HTTP 端口收到的请求数：', httpHits, '｜本机 UDP 端口收到的包数：', udpHits);
  const leaked = Object.entries(out).filter(([, v]) => v === '连出去了');
  ok =
    r.ran &&
    r.exitCode === 0 &&
    leaked.length === 0 &&
    httpHits === 0 &&
    udpHits === 0 &&
    out['写副本里的文件'] === '可以';
} finally {
  http.close();
  udp.close();
  rmSync(cwd, { recursive: true, force: true });
}
console.log('RESULT', ok ? '通过' : '没通过');
process.exit(ok ? 0 : 1);
