/**
 * L10 验收测试的共用骨架：临时裸仓库当 origin + 整合方/开发各一份克隆 + 合成的队列与配置 + 替身角色。
 *
 * 替身照 L2b 的做法：拉一次 origin/main、把队列第 70 行改成这一棒该改的状态、提交、推回 origin、
 * 最后打 `RELAY-DONE 70 <新状态>`。这样看门人下一轮读 origin/main 就能看到状态变了。
 *
 * 全在临时目录里跑；不调真模型、不连 GitHub。数据目录用 IXAEON_RELAY_DIR 指到临时目录。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = process.cwd();
export const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
/** 调度器眼里的「现在」定死在北京时间上午 10 点：晚上 9 点以后跑会多一条日报。 */
export const MORNING = '2026-10-22T02:00:00.000Z';

export function findJiti(): string {
  const candidates: string[] = [];
  const pnpm = join(REPO, 'node_modules', '.pnpm');
  try {
    for (const dir of readdirSync(pnpm)) {
      if (dir.startsWith('jiti@')) {
        candidates.push(join(pnpm, dir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
      }
    }
  } catch {
    /* 没有 .pnpm 就看下一个 */
  }
  candidates.push(join(REPO, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('找不到 jiti 的 CLI');
  return found;
}

/** 替身角色：开发者把「待领」改成「测试待审（整合方）」，整合方把后者改成「已完成」。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const opt = (n) => argv[argv.indexOf(n) + 1];',
  'const role = opt("--role");',
  'const clone = opt("--clone");',
  'const dump = opt("--dump-argv");',
  'if (dump) writeFileSync(dump, JSON.stringify(argv), "utf8");',
  'const g = (...a) => {',
  '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
  '  return r.stdout ?? "";',
  '};',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'let after;',
  'if (role === "developer") {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 测试待审（整合方） |"), "utf8");',
  '  after = "测试待审（整合方）";',
  '} else {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 测试待审（整合方） |", "| 已完成（2026-10-23） |"), "utf8");',
  '  after = "已完成（2026-10-23）";',
  '}',
  'g("add", "-A");',
  'g("commit", "-q", "-m", "合成：替身改状态");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE 70 " + after);',
  '',
].join('\n');

const queueOf = (status: string) =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    `| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | ${status} |`,
    '',
  ].join('\n');

export interface World {
  root: string;
  origin: string;
  integ: string;
  dev: string;
  dataDir: string;
  git(cwd: string, args: string[]): { code: number; out: string };
  ledger(): Array<Record<string, unknown>>;
  state(): Record<string, unknown>;
  run(
    args: string[],
    env?: Record<string, string | undefined>,
  ): Promise<{ status: number | null; stdout: string; stderr: string }>;
}

export function makeWorld(
  opts: {
    status?: string;
    idleSeconds?: number;
    /** 开发角色的 argv（带 `{prompt_file}`）；不给就用替身。 */
    devArgv?: string[];
    /** 整合方角色的 argv；不给就用替身。 */
    integArgv?: string[];
    /** 追加在替身参数后面的（替身会忽略不认识的，`--dump-argv` 例外）。 */
    devExtraArgs?: string[];
    integExtraArgs?: string[];
    feishu?: { url: string };
  } = {},
): World {
  const root = mkdtempSync(join(tmpdir(), 'ixa-l10-'));
  const origin = join(root, 'origin.git');
  const integ = join(root, 'integ');
  const dev = join(root, 'dev');
  const dataDir = join(root, 'relay');
  mkdirSync(dataDir, { recursive: true });

  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };
  const must = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  };

  must(root, ['init', '--bare', '-b', 'main', origin]);
  must(root, ['clone', origin, integ]);
  must(integ, ['config', 'user.email', 'relay@example.invalid']);
  must(integ, ['config', 'user.name', 'relay']);
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(join(integ, 'docs', '委派', '队列.md'), queueOf(opts.status ?? '待领'), 'utf8');
  writeFileSync(join(integ, 'docs', '委派', '锁定验收.json'), '{"tasks":[]}\n', 'utf8');
  must(integ, ['add', '-A']);
  must(integ, ['commit', '-q', '-m', '初始合成仓库']);
  must(integ, ['push', '-q', 'origin', 'HEAD:main']);
  must(root, ['clone', origin, dev]);
  must(dev, ['config', 'user.email', 'relay@example.invalid']);
  must(dev, ['config', 'user.name', 'relay']);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string, name: 'developer' | 'integrator', extra: string[] = []) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--role', name, '--clone', cwd, ...extra],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 120,
  });
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          integrator: opts.integArgv
            ? { ...role(integ, 'integrator'), argv: opts.integArgv }
            : role(integ, 'integrator', opts.integExtraArgs),
          developer: opts.devArgv
            ? { ...role(dev, 'developer'), argv: opts.devArgv }
            : role(dev, 'developer', opts.devExtraArgs),
        },
        idleSeconds: opts.idleSeconds ?? 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
    'utf8',
  );
  if (opts.feishu) {
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: opts.feishu.url, secret: 'synthetic-secret-not-real' })}\n`,
      'utf8',
    );
  }

  return {
    root,
    origin,
    integ,
    dev,
    dataDir,
    git,
    ledger: () => {
      const p = join(dataDir, 'ledger.jsonl');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    state: () =>
      JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>,
    run: (args, env = {}) =>
      new Promise((done) => {
        const merged: Record<string, string | undefined> = { ...process.env };
        delete merged.IXAEON_RELAY_DIR;
        delete merged.IXAEON_RELAY_CODE;
        delete merged.IXAEON_RELAY_INSTALL;
        Object.assign(merged, { IXAEON_RELAY_DIR: dataDir, IXAEON_RELAY_NOW: MORNING }, env);
        const p = spawn(process.execPath, [CLI, ...args], {
          cwd: REPO,
          env: merged as NodeJS.ProcessEnv,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        const timer = setTimeout(() => p.kill(), 110_000);
        p.on('close', (status) => {
          clearTimeout(timer);
          done({ status, stdout, stderr });
        });
      }),
  };
}
