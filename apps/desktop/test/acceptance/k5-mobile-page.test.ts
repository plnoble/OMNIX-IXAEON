/**
 * K5 验收 条件 5（以及「要什么」里的手机页结构）：规格 docs/委派/K5-手机只读页.md。
 *
 * 条件 5：手机页在 390px 宽的视口下，四个按钮排成一行，没有横向滚动（规格要求截图）。
 * 这一份做无浏览器的结构核对：viewport 宽度=device-width、四个按钮的名字与顺序、
 * 四列等宽网格（`minmax(0, 1fr)`，不允许按钮撑破一列）、样式与脚本都内联、60 秒刷新。
 * 真正的 390px 截图在实现那一棒的真机检查里跑（本棒只交测试，实现还没有）。
 *
 * 另外核对「要什么」里写了、编号条件没单列的手机页内容：顶部「N 分钟前更新」、
 * 默认显示总览、四个按钮是 总览/等你处理/额度/项目。
 */
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\合成\\ixaeon.exe' },
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
  shell: {},
}));

interface MobileAddress {
  host: string;
  port: number;
}

interface MobileServerLike {
  readonly address: MobileAddress | null;
  apply(): Promise<void>;
  stop(): Promise<void>;
}

type MobileServerCtor = new (opts: { db: CoreDatabase }) => MobileServerLike;

type JsdomLike = new (html: string) => { window: { document: Document } };

let JsdomCtor: JsdomLike | null = null;
let MobileServer: MobileServerCtor | null = null;

beforeAll(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- jsdom 没随包带类型，仓库也没装 @types/jsdom
    // @ts-ignore 只用来把页面 HTML 解析成 DOM，不跑布局
    const jsdom = (await import('jsdom')) as { JSDOM?: JsdomLike };
    JsdomCtor = typeof jsdom.JSDOM === 'function' ? jsdom.JSDOM : null;
  } catch {
    JsdomCtor = null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- 实现还没写；@ts-ignore 在实现写出来后也不报「多余指令」
    // @ts-ignore 实现在 apps/desktop/src/main/server/mobileServer.ts，锁定测试之后才写（B 档先只推测试）
    const mod = (await import('../../src/main/server/mobileServer.js')) as {
      MobileServer?: MobileServerCtor;
    };
    MobileServer = typeof mod.MobileServer === 'function' ? mod.MobileServer : null;
  } catch {
    MobileServer = null;
  }
});

// 现场端口用 43193：这份和 k5-mobile-server.test.ts 会并行跑，别抢条件 2 的 43192。
const PORT = 43193;
const dirs: string[] = [];
let db: CoreDatabase | null = null;
let server: MobileServerLike | null = null;

function serverCtor(): MobileServerCtor {
  if (!MobileServer) {
    throw new Error(
      'MobileServer 还没实现：本任务是 B 档，先只推测试，实现等整合方锁定后写（见规格 K5）',
    );
  }
  return MobileServer;
}

/** 把服务返回的 HTML 解析成 DOM（只做结构核对，没有布局）。 */
function parse(html: string): Document {
  if (!JsdomCtor) throw new Error('jsdom 不可用：测试环境里解析不了手机页 HTML');
  return new JsdomCtor(html).window.document;
}

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(path: string, host = `127.0.0.1:${PORT}`): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path, headers: { Host: host }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 和主进程里的顺序一样：saveMobileSettings → runtime.mobileServer.apply()。 */
async function startMobile(): Promise<void> {
  const dir = tempDir('ixaeon-k5-page-');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env.IXAEON_RELAY_DIR = tempDir('ixaeon-k5-page-relay-');
  server = new (serverCtor())({ db });

  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db, mobileServer: server });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  const entry = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([ch]) => ch === 'ixaeon:saveMobileSettings');
  if (!entry) throw new Error('没有注册 IPC：saveMobileSettings');
  const handler = entry[1] as (event: unknown, input?: unknown) => Promise<unknown>;
  await handler({}, { enabled: true, port: PORT });
}

afterEach(async () => {
  try {
    await server?.stop();
  } catch {
    /* 已经停了 */
  }
  server = null;
  try {
    if (db?.open) db.close();
  } catch {
    /* 已关 */
  }
  db = null;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

describe('条件 5：手机页结构与 390px 四列', () => {
  it('viewport 是 device-width；四个按钮 总览/等你处理/额度/项目；四列等宽；样式脚本内联', async () => {
    await startMobile();
    const res = await request('/m');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toContain('text/html');

    const doc = parse(res.body);

    const viewport = doc.querySelector('meta[name="viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport?.getAttribute('content') ?? '').toMatch(/width\s*=\s*device-width/);

    // 四个并排按钮：名字与顺序照规格
    const labels = ['总览', '等你处理', '额度', '项目'];
    const buttons = Array.from(doc.querySelectorAll('button'));
    const tabs = buttons.filter((b) => labels.includes((b.textContent ?? '').trim()));
    expect(tabs.map((b) => (b.textContent ?? '').trim())).toEqual(labels);

    // 样式和脚本都内联：没有外链 stylesheet，也没有 src 脚本
    expect(doc.querySelectorAll('link[rel="stylesheet"]').length).toBe(0);
    expect(Array.from(doc.querySelectorAll('script')).some((s) => s.hasAttribute('src'))).toBe(
      false,
    );

    const styles = Array.from(doc.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    // 一排四个等宽列，列宽允许缩到 0（否则 390px 下按钮会把页面撑宽）
    expect(styles).toMatch(/display\s*:\s*grid/);
    expect(styles).toMatch(
      /grid-template-columns\s*:\s*repeat\(\s*4\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)/,
    );
    // 页面主体不能有写死的、比 390px 还宽的最小宽度
    const widths = Array.from(styles.matchAll(/min-width\s*:\s*(\d+)px/g)).map((m) => Number(m[1]));
    expect(widths.filter((w) => w > 390)).toEqual([]);

    // 顶部「N 分钟前更新」
    expect(res.body).toContain('分钟前更新');

    // 默认显示总览：页面里总览那个块带打开/选中标记
    const overview = doc.querySelector('[data-view="overview"]');
    expect(overview).not.toBeNull();
    expect(res.body).toContain('总览');
  });

  it('每 60 秒刷新一次：内联脚本里有 60000 毫秒的定时器', async () => {
    await startMobile();
    const res = await request('/m');
    const doc = parse(res.body);
    const scripts = Array.from(doc.querySelectorAll('script'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(scripts).toMatch(/setInterval\s*\(/);
    // 整合方改严（2026-10-31）：60000 必须是 setInterval 的间隔参数——
    // 只查「有 60000」时，算「N 分钟前」的 /60000 就能让 30 秒刷新也过
    expect(scripts).toMatch(/setInterval\s*\([\s\S]*?,\s*60_?000\s*\)/);
  });
});
