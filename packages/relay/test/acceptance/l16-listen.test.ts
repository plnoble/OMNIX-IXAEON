/**
 * L16 验收测试（二）：收听进程（规格条件 2、7，对应契约第 1、4 条）。
 *
 * 逐条对应：
 * - 一条认的 → `inbox.jsonl` 多一行、假飞书收到 `收到：76 要。下一棒交给整合方。`；
 *   同一个 `id` 再来一次 → 不多记、不再回；不认的 → 不记、不回。
 * - `--bind`：`feishu-app.json` 里只有 `appId`、`appSecret`，来一条 @ 机器人的消息 →
 *   文件里多了 `chatId`、`ownerOpenId`，原来两项不变，退出码 0。
 * - 没绑定又没带 `--bind` → 退出码 2、打 `还没绑定：先跑 relay listen --bind`。
 * - 条件 7（隐私）：上面所有输出、报错里都找不到合成的 `appSecret`。
 *
 * 飞书 SDK 那一层用**假的事件源**代替（测试里不连真飞书）：`relay listen` 读环境变量
 * `IXAEON_RELAY_EVENT_SRC`（一个模块路径，导出和生产一样的 `startEventSource`），测试给它
 * 一个按顺序吐合成事件的模块。往群里回话照旧走 L3 的自定义机器人（假飞书收）。
 * 数据目录、工作目录全在临时目录；原话用合成的（「76 要」）；`appSecret` 是合成的假密钥。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const SECRET = 'synthetic-secret-not-real';
const dirs: string[] = [];
const servers: Array<() => Promise<void>> = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const c of servers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fakeFeishu() {
  const texts: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { content?: { text?: string } };
      texts.push(body.content?.text ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  servers.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${port}/synthetic`, texts };
}

/** 合成一条群里 @ 机器人说 `<text>` 的 im.message.receive_v1 事件。 */
const msgEvent = (o: { id: string; text?: string; type?: string; mentions?: number }) => ({
  header: { event_type: 'im.message.receive_v1' },
  event: {
    message: {
      message_id: o.id,
      chat_id: 'oc_bound',
      chat_type: 'group',
      message_type: o.type ?? 'text',
      mentions: Array.from({ length: o.mentions ?? 1 }, (_, i) => ({
        key: `@_user_${i + 1}`,
        id: { open_id: 'ou_bot' },
      })),
      content: JSON.stringify({ text: o.text ?? '@_user_1 76 要' }),
    },
    sender: { sender_id: { open_id: 'ou_owner' } },
  },
});

/** 假事件源：把 IXAEON_RELAY_FAKE_EVENTS 里的合成事件一条条喂给 onEvent，然后挂着不退。 */
const fakeSource = (eventsFile: string): string => {
  const file = join(tmp('ixa-l16-src-'), 'fake-source.mjs');
  writeFileSync(
    file,
    [
      "import { readFileSync } from 'node:fs';",
      `const events = JSON.parse(readFileSync(${JSON.stringify(eventsFile)}, 'utf8'));`,
      'export async function startEventSource(opts) {',
      '  for (const e of events) {',
      '    await opts.onEvent(e);',
      '    await new Promise((r) => setTimeout(r, 300));',
      '  }',
      '  return { stop() {} };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
};

interface Setup {
  dataDir: string;
  writeApp(o: { appId?: string; appSecret?: string; chatId?: string; ownerOpenId?: string }): void;
}
const setup = (o: {
  appId?: string;
  appSecret?: string;
  chatId?: string;
  ownerOpenId?: string;
}): Setup => {
  const dataDir = tmp('ixa-l16-data-');
  const writeApp = (a: {
    appId?: string;
    appSecret?: string;
    chatId?: string;
    ownerOpenId?: string;
  }) => {
    writeFileSync(
      join(dataDir, 'feishu-app.json'),
      `${JSON.stringify(
        {
          appId: 'cli_synthetic_not_real',
          appSecret: SECRET,
          ...a,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  };
  writeApp(o);
  return { dataDir, writeApp };
};

/** 起 `relay listen`，collect 输出；`stop` 由测试决定什么时候杀。 */
function listen(dataDir: string, args: string[], eventsFile: string) {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      IXAEON_RELAY_DIR: dataDir,
      IXAEON_RELAY_EVENT_SRC: fakeSource(eventsFile),
    },
    windowsHide: true,
  });
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const closed = new Promise<number | null>((done) => child.on('close', done));
  return {
    child,
    closed,
    stdout: () => stdout,
    stderr: () => stderr,
    /** 等某个字样出现（最多 timeout 毫秒），没出现就杀掉并返回 false。 */
    waitFor(text: string, timeout = 15_000): Promise<boolean> {
      const started = Date.now();
      return new Promise((done) => {
        const timer = setInterval(() => {
          if (stdout.includes(text) || stderr.includes(text)) {
            clearInterval(timer);
            done(true);
          } else if (Date.now() - started > timeout) {
            clearInterval(timer);
            done(false);
          }
        }, 100);
      });
    },
  };
}
const inboxLines = (dataDir: string): Array<Record<string, unknown>> => {
  const p = join(dataDir, 'inbox.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const waitForInbox = (dataDir: string, timeout = 20_000): Promise<boolean> => {
  const started = Date.now();
  return new Promise((done) => {
    const timer = setInterval(() => {
      if (inboxLines(dataDir).length > 0) {
        clearInterval(timer);
        done(true);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        done(false);
      }
    }, 100);
  });
};
const eventsFile = (events: unknown[]): string => {
  const f = join(tmp('ixa-l16-ev-'), 'events.json');
  writeFileSync(f, JSON.stringify(events), 'utf8');
  return f;
};

describe('条件 2：relay listen', () => {
  it('认的一条 → inbox.jsonl 一行 + 假飞书收到「收到：…」；同一个 id 再来不多记；不认的不记不回', async () => {
    const fake = await fakeFeishu();
    const { dataDir } = setup({ chatId: 'oc_bound', ownerOpenId: 'ou_owner' });
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: fake.url, secret: 's' })}\n`,
      'utf8',
    );
    const ev = eventsFile([
      msgEvent({ id: 'om_1' }),
      msgEvent({ id: 'om_1' }), // 同一个 id 再来一次
      msgEvent({ id: 'om_2', mentions: 0 }), // 不认：没 @
    ]);
    const p = listen(dataDir, ['listen'], ev);
    const seen = await waitForInbox(dataDir);
    await p.closed;
    expect(seen, p.stdout() + p.stderr()).toBe(true);
    const lines = inboxLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'om_1', text: '76 要' });
    expect(typeof lines[0]!.at).toBe('string');
    expect(fake.texts.filter((t) => t.includes('收到：76 要。下一棒交给整合方。'))).toHaveLength(1);
    expect(p.stdout()).toContain('没理：');
  }, 60_000);

  it('--bind：文件里多了 chatId、ownerOpenId，appId/appSecret 原样，退出码 0', async () => {
    const fake = await fakeFeishu();
    const { dataDir } = setup({}); // 只有 appId、appSecret
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: fake.url, secret: 's' })}\n`,
      'utf8',
    );
    const ev = eventsFile([msgEvent({ id: 'om_bind' })]);
    const p = listen(dataDir, ['listen', '--bind'], ev);
    const code = await new Promise<number | null>((done) => p.child.on('close', done));
    expect(code, p.stdout() + p.stderr()).toBe(0);
    const app = JSON.parse(readFileSync(join(dataDir, 'feishu-app.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(app.chatId).toBe('oc_bound');
    expect(app.ownerOpenId).toBe('ou_owner');
    expect(app.appId).toBe('cli_synthetic_not_real');
    expect(app.appSecret).toBe(SECRET);
    expect(fake.texts.some((t) => t.includes('绑好了：以后只听你在这个群里 @ 我说的话。'))).toBe(
      true,
    );
    expect(p.stdout()).toContain('绑好了');
  }, 60_000);

  it('没绑定又没带 --bind → 退出码 2、打那一行', async () => {
    const { dataDir } = setup({});
    const ev = eventsFile([]);
    const p = listen(dataDir, ['listen'], ev);
    const code = await new Promise<number | null>((done) => p.child.on('close', done));
    expect(code).toBe(2);
    expect(p.stdout()).toContain('还没绑定：先跑 relay listen --bind');
  }, 60_000);
});

describe('条件 7：隐私', () => {
  it('收听的输出、报错里找不到合成的 appSecret', async () => {
    const fake = await fakeFeishu();
    const { dataDir } = setup({ chatId: 'oc_bound', ownerOpenId: 'ou_owner' });
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: fake.url, secret: 's' })}\n`,
      'utf8',
    );
    const ev = eventsFile([msgEvent({ id: 'om_1' })]);
    const p = listen(dataDir, ['listen'], ev);
    await waitForInbox(dataDir);
    await p.closed;
    expect(`${p.stdout()}${p.stderr()}`).not.toContain(SECRET);
  }, 60_000);

  it('feishu-app.json 不是 JSON、缺 appId/appSecret → 当没配，不起收听（退出码 2）', async () => {
    const dataDir = tmp('ixa-l16-bad-');
    writeFileSync(join(dataDir, 'feishu-app.json'), '不是 JSON', 'utf8');
    const r = spawnSync(process.execPath, [CLI, 'listen'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      env: {
        ...process.env,
        IXAEON_RELAY_DIR: dataDir,
        IXAEON_RELAY_EVENT_SRC: fakeSource(join(dataDir, 'nope.json')),
      },
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toContain('不是 JSON');
    expect(`${r.stdout}${r.stderr}`).toContain('feishu-app.json');
  }, 60_000);
});
