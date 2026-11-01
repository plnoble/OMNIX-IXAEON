/**
 * DG1 验收测试：接力的 DSH 网关跟桌面版走（每棒只取网关段，不抄副本）。
 *
 * 逐条对应规格的验收条件：
 * - 条件 1：合成桌面版配置（顶层三项 `ui-settings-general`、`llm-pi-ai`（两个网关，其中一个叫
 *   `magpie`）、`mcp-servers`）+ 合成接力补丁 → 起棒时替身 DSH 收到的参数是
 *   `--profile headless --patch <A> --patch <接力补丁> …`；A 的内容正好是 `llm-pi-ai` 那一项（逐字），
 *   里面没有 `ui-settings-general`、`mcp-servers`。
 * - 条件 2：棒结束（正常、替身崩溃、超时三种）后 A 都不在了。
 * - 条件 3：桌面版配置不存在 / 没有 `llm-pi-ai` 项 → 参数和现在一样，输出那一行提示。
 * - 条件 4：`DSH_HOME` 指向另一个目录 → 从那里读。
 * - 条件 5：记账、日志、飞书通知里都找不到合成网关的地址和 `apiKeyEnv` 的值。
 *
 * 全部用合成配置和替身 DSH（复制一份 node 当 `DeepSeek Harness.exe`，cli.js 是替身），
 * 不读、不碰用户真实的 `~/.dsh`、`~/.ixaeon/relay`，也不调真模型。
 */
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_NOT_FOUND_LINE,
  runTurn,
  type RelayConfig,
  type RelayState,
  type Turn,
} from '../../src/index.js';
import { makeWorld } from './l6-harness.js';

const REPO = process.cwd();
const LAUNCHER = join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs');
const FAKE_MODE = 'DG1_FAKE_MODE';
const CAPTURE = 'DG1_CAPTURE';
const ARGS_OUT = 'DG1_ARGS_OUT';
/** 条件 5 的合成标记：真实配置里不会有这两个串。 */
const MARK_ADDRESS = 'https://dg1-gateway.example.invalid/v1';
const MARK_KEY_ENV = 'DG1_SYNTHETIC_KEY_ENV';

/** 桌面版补丁里 `llm-pi-ai` 那一项（验收条件 1 要的「逐字」原文）。 */
const GATEWAY_ITEM = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      newapi:',
  `        baseURL: ${MARK_ADDRESS}`,
  `        apiKeyEnv: ${MARK_KEY_ENV}`,
  '        models:',
  '          - id: auto/claude-opus-5-5',
  '      magpie:',
  '        baseURL: http://127.0.0.1:59998/magpie',
  '        apiKeyEnv: DG1_MAGPIE_KEY_ENV',
  '        models:',
  '          - id: synthetic/magpie-one',
  '',
].join('\n');

/** 另一份带别的网关的配置：DSH_HOME 那条测试用它证明没读错家目录。 */
const WRONG_ITEM = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      wrong-gateway:',
  '        models:',
  '          - id: wrong/model',
  '',
].join('\n');

const desktopConfig = (body: string | null) =>
  [
    '- id: ui-settings-general',
    '  config:',
    '    theme: dark',
    ...(body ? [body.trimEnd()] : []),
    '- id: mcp-servers',
    '  config:',
    '    chrome-devtools:',
    '      command: npx',
    '      args: [chrome-devtools-mcp]',
    '',
  ].join('\n');

/** 替身 DSH：把收到的参数落盘；`ok` 再把第一个 `--patch` 的内容抄一份、把参数打到 stdout。 */
const FAKE_CLI = [
  "const fs = require('node:fs');",
  'const args = process.argv.slice(2);',
  'if (process.env.DG1_ARGS_OUT) fs.writeFileSync(process.env.DG1_ARGS_OUT, JSON.stringify({ args }));',
  "const mode = process.env.DG1_FAKE_MODE || 'ok';",
  "if (mode === 'hang') { setInterval(() => {}, 1000); }",
  "else if (mode === 'crash') { process.exit(7); }",
  'else {',
  '  const patches = [];',
  "  for (let i = 0; i < args.length; i++) if (args[i] === '--patch' && args[i + 1]) patches.push(args[i + 1]);",
  '  if (patches[0] && process.env.DG1_CAPTURE) fs.copyFileSync(patches[0], process.env.DG1_CAPTURE);',
  "  process.stdout.write(JSON.stringify({ args }) + '\\n');",
  '}',
  '',
].join('\n');

const savedEnv = new Map<string, string | undefined>();
const setEnv = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
};
const dirs: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

interface Scene {
  root: string;
  home: string;
  dshHome: string;
  install: string;
  relayPatch: string;
  capture: string;
  argsOut: string;
  dataDir: string;
}

/** 假安装目录 + 替身 DSH + 两处合成桌面版配置（默认家目录 / DSH_HOME）+ 合成接力补丁。 */
function makeScene(prefix: string): Scene {
  const root = mkTmp(`ixa-${prefix}-`);
  const home = join(root, 'home');
  const dshHome = join(root, 'dsh-home');
  const install = join(root, 'install');
  const dataDir = join(root, 'relay');
  const relayPatch = join(root, 'ixaeon-relay.patch.yml');
  const capture = join(root, 'captured-gateway.yml');
  const argsOut = join(root, 'seen-args.json');
  const cli = join(
    install,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  mkdirSync(dirname(cli), { recursive: true });
  copyFileSync(process.execPath, join(install, 'DeepSeek Harness.exe'));
  if (process.platform !== 'win32') chmodSync(join(install, 'DeepSeek Harness.exe'), 0o755);
  writeFileSync(cli, FAKE_CLI, 'utf8');
  for (const base of [home, dshHome]) {
    const p =
      base === home
        ? join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
        : join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, desktopConfig(GATEWAY_ITEM), 'utf8');
  }
  writeFileSync(relayPatch, '- id: approval\n  config:\n    mode: full\n', 'utf8');
  mkdirSync(dataDir, { recursive: true });
  return { root, home, dshHome, install, relayPatch, capture, argsOut, dataDir };
}

const sceneEnv = (s: Scene): Record<string, string> => ({
  IXAEON_DSH_INSTALL: s.install,
  USERPROFILE: s.home,
  HOME: s.home,
  // 宿主可能带着真的 DSH_HOME（这台机器上就有）：默认家目录那几条要把它清掉，否则会读到用户真实配置。
  DSH_HOME: '',
  [CAPTURE]: s.capture,
  [ARGS_OUT]: s.argsOut,
  [FAKE_MODE]: 'ok',
});

const configFor = (s: Scene): RelayConfig => {
  const role = {
    argv: [
      process.execPath,
      LAUNCHER,
      '--profile',
      'headless',
      '--patch',
      s.relayPatch,
      '--json',
      '读 {prompt_file}，照里面做。',
    ],
    cwd: s.root,
    timeoutMinutes: 1,
    quotaPatterns: [],
    quotaPauseMinutes: 1,
  };
  return { roles: { developer: role, integrator: role }, idleSeconds: 1 };
};

const TURN: Turn = {
  role: 'developer',
  kind: 'developer-claim',
  taskId: 'DG1',
  task: 'DG1 合成的一棒',
  status: '进行中（dev）',
};

const seenArgs = (s: Scene): string[] =>
  (JSON.parse(readFileSync(s.argsOut, 'utf8')) as { args: string[] }).args;

const runTurnOnce = async (s: Scene, opts: { timeoutMs?: number; logs?: string[] } = {}) => {
  const restore = opts.logs
    ? (() => {
        const original = console.log;
        console.log = (...a: unknown[]) => {
          opts.logs!.push(a.map(String).join(' '));
        };
        return () => {
          console.log = original;
        };
      })()
    : null;
  try {
    const state: RelayState = { stoppedReason: null, pausedUntil: {}, turns: 0 };
    return await runTurn(TURN, configFor(s), state, {
      dataDir: s.dataDir,
      turnNumber: 1,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
  } finally {
    restore?.();
  }
};

const allFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? allFiles(p) : [p];
  });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

describe('条件 1：只取 llm-pi-ai 那一项，插在接力补丁前面', () => {
  it('替身 DSH 收到的参数顺序对，A 逐字等于那一项、没有 MCP 和界面设置', async () => {
    const s = makeScene('dg1-item');
    setEnv(sceneEnv(s));
    const result = await runTurnOnce(s);
    expect(result.exitCode, result.stderrPath).toBe(0);

    const args = seenArgs(s);
    expect(args.slice(0, 2)).toEqual(['--profile', 'headless']);
    expect(args[2]).toBe('--patch');
    const temp = args[3]!;
    expect(args[4]).toBe('--patch');
    expect(resolve(args[5]!)).toBe(resolve(s.relayPatch));
    expect(args[6]).toBe('--json');
    expect(args.at(-1)).toBe(`读 ${result.promptPath}，照里面做。`);

    // A 在系统临时目录、名字随机；棒结束后已经删掉（内容在替身那里抄了一份）。
    expect(resolve(dirname(temp))).toBe(resolve(tmpdir()));
    expect(existsSync(temp)).toBe(false);
    const captured = readFileSync(s.capture, 'utf8');
    expect(captured).toBe(GATEWAY_ITEM);
    expect(captured).not.toContain('ui-settings-general');
    expect(captured).not.toContain('mcp-servers');
    expect(captured).not.toContain('chrome-devtools');
  });
});

describe('条件 2：正常、崩溃、超时三种结束后 A 都不在', () => {
  it('正常结束：临时补丁已删', async () => {
    const s = makeScene('dg1-normal');
    setEnv(sceneEnv(s));
    await runTurnOnce(s);
    const temp = seenArgs(s)[3]!;
    expect(existsSync(temp)).toBe(false);
  });

  it('替身崩溃（退出码 7）：临时补丁已删', async () => {
    const s = makeScene('dg1-crash');
    setEnv({ ...sceneEnv(s), [FAKE_MODE]: 'crash' });
    const result = await runTurnOnce(s);
    expect(result.exitCode).toBe(7);
    const temp = seenArgs(s)[3]!;
    expect(existsSync(temp)).toBe(false);
  });

  it('超时（替身卡住、被强杀）：临时补丁已删', async () => {
    const s = makeScene('dg1-timeout');
    setEnv({ ...sceneEnv(s), [FAKE_MODE]: 'hang' });
    const result = await runTurnOnce(s, { timeoutMs: 1_500 });
    expect(result.timedOut).toBe(true);
    const temp = seenArgs(s)[3]!;
    expect(existsSync(temp)).toBe(false);
  }, 30_000);
});

describe('条件 3：桌面版配置不存在 / 没有 llm-pi-ai 项', () => {
  it('不存在 → 参数和现在一样，打那一行提示', async () => {
    const s = makeScene('dg1-missing');
    setEnv(sceneEnv(s));
    rmSync(join(s.home, '.dsh'), { recursive: true, force: true });
    const logs: string[] = [];
    const result = await runTurnOnce(s, { logs });
    expect(result.exitCode).toBe(0);
    const args = seenArgs(s);
    expect(args).toEqual([
      '--profile',
      'headless',
      '--patch',
      s.relayPatch,
      '--json',
      `读 ${result.promptPath}，照里面做。`,
    ]);
    expect(logs).toContain(GATEWAY_NOT_FOUND_LINE);
    // 替身抄的是第一个 --patch，也就是接力补丁自己（没有加临时网关补丁）。
    expect(readFileSync(s.capture, 'utf8')).toBe(
      readFileSync(s.relayPatch, 'utf8'),
    );
  });

  it('有桌面版配置但没有 llm-pi-ai 项 → 同样不加、同样提示', async () => {
    const s = makeScene('dg1-no-item');
    setEnv(sceneEnv(s));
    writeFileSync(
      join(s.home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
      desktopConfig(null),
      'utf8',
    );
    const logs: string[] = [];
    await runTurnOnce(s, { logs });
    const args = seenArgs(s);
    expect(args.filter((a) => a === '--patch')).toHaveLength(1);
    expect(args[3]).toBe(s.relayPatch);
    expect(logs).toContain(GATEWAY_NOT_FOUND_LINE);
  });
});

describe('条件 4：DSH_HOME 指向另一个目录就从那里读', () => {
  it('默认家目录里是另一份；取到的是 DSH_HOME 那一份', async () => {
    const s = makeScene('dg1-dsh-home');
    setEnv({ ...sceneEnv(s), DSH_HOME: s.dshHome });
    writeFileSync(
      join(s.home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
      desktopConfig(WRONG_ITEM),
      'utf8',
    );
    await runTurnOnce(s);
    const captured = readFileSync(s.capture, 'utf8');
    expect(captured).toBe(GATEWAY_ITEM);
    expect(captured).toContain('magpie');
    expect(captured).not.toContain('wrong-gateway');
  });
});

describe('条件 5：记账、日志、飞书通知里都没有合成网关地址和 apiKeyEnv 的值', () => {
  it('跑一棒真调度器：数据目录（含 ledger）、输出、当天日报的飞书请求里都找不到', async () => {
    const s = makeScene('dg1-leak');
    const received: string[] = [];
    let server: Server | null = null;
    try {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (d: Buffer) => (body += d.toString('utf8')));
        req.on('end', () => {
          received.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"code":0,"msg":"ok"}');
        });
      });
      await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const w = makeWorld({ queueStatus: '待领', feishu: { url: `http://127.0.0.1:${port}/hook` } });
      dirs.push(w.root);
      const cfgPath = join(w.dataDir, 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as RelayConfig;
      cfg.roles.developer.argv = configFor(s).roles.developer.argv;
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      setEnv({ ...sceneEnv(s), DSH_HOME: s.dshHome });
      // 北京时间 21:10：这一轮会发一条日报，好把「飞书通知」也扫到。
      const r = await w.run(['once'], '2026-10-22T13:10:00.000Z');
      expect(r.status, r.stderr || r.stdout).toBe(0);
      expect(w.ledger()).toHaveLength(1);

      const leaks: string[] = [];
      const scan = (where: string, text: string) => {
        if (text.includes(MARK_ADDRESS) || text.includes(MARK_KEY_ENV)) leaks.push(where);
      };
      for (const file of allFiles(w.dataDir)) scan(file, readFileSync(file, 'utf8'));
      scan('调度器 stdout', r.stdout);
      scan('调度器 stderr', r.stderr);
      expect(received.length).toBeGreaterThan(0); // 日报确实发出去了
      received.forEach((body, i) => scan(`飞书通知 #${i}`, body));
      expect(leaks).toEqual([]);

      expect(existsSync(join(w.dataDir, 'turns', '1', 'stdout.txt'))).toBe(true);
    } finally {
      if (server) await new Promise<void>((done) => server!.close(() => done()));
    }
  }, 120_000);
});