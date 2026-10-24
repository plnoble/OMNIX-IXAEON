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
const msgEvent = (o: {
  id: string;
  text?: string;
  type?: string;
  mentions?: number;
  chatId?: string;
  sender?: string;
}) => ({
  header: { event_type: 'im.message.receive_v1' },
  event: {
    message: {
      message_id: o.id,
      chat_id: o.chatId ?? 'oc_bound',
      chat_type: 'group',
      message_type: o.type ?? 'text',
      mentions: Array.from({ length: o.mentions ?? 1 }, (_, i) => ({
        key: `@_user_${i + 1}`,
        id: { open_id: 'ou_bot' },
      })),
      content: JSON.stringify({ text: o.text ?? '@_user_1 76 要' }),
    },
    sender: { sender_id: { open_id: o.sender ?? 'ou_owner' } },
  },
});

/**
 * 假事件源：把 eventsFile 里的合成事件一条条喂给 onEvent，然后挂着不退（真 SDK 也是一直挂着）。
 * 整合方改（2026-10-24）：喂完最后一条再过 2 秒，假事件源自己 `process.exit(0)`——
 * `relay.mjs` 是包了一层的（外层 spawnSync 里面那层），测试杀外层杀不到里面那层，会留下孤儿进程。
 */
const fakeSource = (eventsFile: string): string => {
  const file = join(tmp('ixa-l16-src-'), 'fake-source.mjs');
  writeFileSync(
    file,
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      `const f = ${JSON.stringify(eventsFile)};`,
      "const events = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];",
      'export async function startEventSource(onEvent) {',
      '  for (const e of events) {',
      '    await onEvent(e);',
      '    await new Promise((r) => setTimeout(r, 300));',
      '  }',
      '  setTimeout(() => process.exit(0), 2000);',
      '  await new Promise(() => {});',
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
    stdout: () => stdout,
    stderr: () => stderr,
    /**
     * 等进程自己退（假事件源喂完 2 秒后退）；最多 timeout 毫秒，到了就杀掉，返回 'timeout'。
     * 整合方改（2026-10-24）：原来等 stdout 里出现「收到：…」——规格只要求把它发到群里，
     * 没要求打到 stdout，实现写对了也过不了；而且一看到就杀，后面那两条（重复的、不认的）还没喂到。
     */
    async done(timeout = 30_000): Promise<number | null | 'timeout'> {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => {
          child.kill();
          r('timeout');
        }, timeout);
      });
      const r = await Promise.race([closed, late]);
      clearTimeout(timer);
      return r;
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
    expect(await p.done(), p.stdout() + p.stderr()).not.toBe('timeout');
    expect(p.stdout()).toContain('收听中');
    const lines = inboxLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'om_1', text: '76 要' });
    expect(Number.isNaN(Date.parse(String(lines[0]!.at)))).toBe(false); // at 是 ISO 时间
    // 整合方补：群里一共只收到这一句（重复的不再回、不认的不回）
    expect(fake.texts).toHaveLength(1);
    expect(fake.texts[0]).toContain('收到：76 要。下一棒交给整合方。');
    expect(p.stdout()).toContain('没理：');
    expect(`${p.stdout()}${p.stderr()}`).not.toContain(SECRET);
  }, 60_000);

  it('整合方补：「收到」后面只带原话的前 50 个字', async () => {
    const fake = await fakeFeishu();
    const { dataDir } = setup({ chatId: 'oc_bound', ownerOpenId: 'ou_owner' });
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: fake.url, secret: 's' })}\n`,
      'utf8',
    );
    const long = `${'甲'.repeat(50)}乙乙乙`;
    const p = listen(
      dataDir,
      ['listen'],
      eventsFile([msgEvent({ id: 'om_long', text: `@_user_1 ${long}` })]),
    );
    expect(await p.done(), p.stdout() + p.stderr()).not.toBe('timeout');
    expect(inboxLines(dataDir)[0]).toMatchObject({ id: 'om_long', text: long }); // 记全文
    expect(fake.texts).toHaveLength(1);
    expect(fake.texts[0]).toContain(`收到：${'甲'.repeat(50)}。下一棒交给整合方。`);
    expect(fake.texts[0]).not.toContain('乙');
  }, 60_000);

  it('--bind：文件里多了 chatId、ownerOpenId，appId/appSecret 原样，退出码 0', async () => {
    const fake = await fakeFeishu();
    const { dataDir } = setup({}); // 只有 appId、appSecret
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: fake.url, secret: 's' })}\n`,
      'utf8',
    );
    // 整合方补：前面先来一条别的群、别的人、没 @ 的——「第一条 @ 了机器人的文字消息」才算
    const ev = eventsFile([
      msgEvent({ id: 'om_noise', chatId: 'oc_other', sender: 'ou_stranger', mentions: 0 }),
      msgEvent({ id: 'om_bind' }),
    ]);
    const p = listen(dataDir, ['listen', '--bind'], ev);
    const code = await p.done();
    expect(code, p.stdout() + p.stderr()).toBe(0);
    expect(`${p.stdout()}${p.stderr()}`).not.toContain(SECRET);
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
    const code = await p.done();
    expect(code).toBe(2);
    expect(p.stdout()).toContain('还没绑定：先跑 relay listen --bind');
    expect(p.stdout()).not.toContain('收听中');
    expect(`${p.stdout()}${p.stderr()}`).not.toContain(SECRET);
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
    // 整合方改（2026-10-24）：原来等 stdout 出现「收到」（见上面 done() 的说明）。
    // 再补一条：连接层报错、报错原文里带着 appSecret（SDK 的报错可能带凭据）→ 打出来的要换成 <已隐藏>。
    const src = join(tmp('ixa-l16-src-'), 'throwing-source.mjs');
    writeFileSync(
      src,
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const app = JSON.parse(readFileSync(join(process.env.IXAEON_RELAY_DIR, 'feishu-app.json'), 'utf8'));",
        'export async function startEventSource() {',
        "  throw new Error('合成：连不上飞书，凭据 ' + app.appSecret);",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const r = spawnSync(process.execPath, [CLI, 'listen'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, IXAEON_RELAY_DIR: dataDir, IXAEON_RELAY_EVENT_SRC: src },
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain(SECRET);
    expect(out).toContain('<已隐藏>');
    expect(fake.texts).toEqual([]);
  }, 60_000);

  it('feishu-app.json 不在、不是 JSON、缺 appId/appSecret → 当没配，不起收听（退出码 2）', async () => {
    const run = (content: string | null) => {
      const dataDir = tmp('ixa-l16-bad-');
      if (content !== null) writeFileSync(join(dataDir, 'feishu-app.json'), content, 'utf8');
      return spawnSync(process.execPath, [CLI, 'listen'], {
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
    };
    // 整合方改（2026-10-24）：原来坏文件写的是「不是 JSON」，再查输出里没有「不是 JSON」——
    // 实现说「feishu-app.json 不是 JSON」反而过不了，又查不出有没有把文件内容打出来。
    // 换成一份带着合成密钥的坏 JSON，查密钥没漏出来。
    const cases = [
      null,
      `{"appId": "cli_synthetic_not_real", "appSecret": "${SECRET}"`,
      `${JSON.stringify({ appId: 'cli_synthetic_not_real' })}\n`,
      `${JSON.stringify({ appSecret: SECRET, chatId: 'oc_bound', ownerOpenId: 'ou_owner' })}\n`,
    ];
    for (const c of cases) {
      const r = run(c);
      const out = `${r.stdout}${r.stderr}`;
      expect(r.status, out).toBe(2);
      expect(out).toContain('feishu-app.json');
      expect(out).not.toContain('收听中');
      expect(out).not.toContain(SECRET);
    }
  }, 120_000);
});
