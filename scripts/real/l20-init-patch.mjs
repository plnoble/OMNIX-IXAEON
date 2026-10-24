/**
 * L20 真机检查：`relay init` 生成的开发命令带上 DSH 补丁（委派单「真机检查」）。
 *
 * 全在临时目录里跑：临时数据目录、临时工作目录根、临时 APPDATA、临时家目录（`USERPROFILE` / `HOME` 指过去）。
 * 先不放补丁文件跑一次 `relay init`；删掉配置、放上 `~/.dsh/ixaeon-relay.patch.yml`，再跑一次。
 * 两次各打出开发 `argv` 里有没有 `--patch`、紧跟的是不是那个路径（遮掉临时目录）、输出里那一行原样。
 * 任何一步不符打「结论：不通过」退 1；脚本自己出错退出码也非零。跑完删临时目录。
 *
 * **不许对用户真的数据目录 `~/.ixaeon/relay` 跑 `relay init`。**
 *   node scripts/real/l20-init-patch.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repo, 'packages', 'relay', 'bin', 'relay.mjs');

const work = mkdtempSync(join(tmpdir(), 'ixa-l20-init-patch-'));
const treeRoot = join(work, 'trees');
const relayDir = join(work, 'relay');
const appdata = join(work, 'appdata');
const home = join(work, 'home');
for (const d of [treeRoot, relayDir, appdata, home]) mkdirSync(d, { recursive: true });
const patchFile = join(home, '.dsh', 'ixaeon-relay.patch.yml');
const configFile = join(relayDir, 'config.json');

const mask = (s) => {
  let text = String(s);
  for (const p of [
    work,
    home,
    treeRoot,
    relayDir,
    appdata,
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
    tmpdir(),
  ].filter((x) => x && x.trim())) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

let bad = 0;
const check = (ok, what, extra = '') => {
  if (!ok) bad++;
  log(`  ${ok ? '✓' : '✗'} ${what}${extra ? `：${mask(extra)}` : ''}`);
};

const env = () => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_CONFIG_')) delete e[k];
  e.IXAEON_RELAY_DIR = relayDir;
  e.IXAEON_WORKTREES = treeRoot;
  e.APPDATA = appdata;
  // 契约第 1 条的位置由 os.homedir() 决定（Windows 读 USERPROFILE）：指到临时家目录，不读用户真的 ~/.dsh。
  e.USERPROFILE = home;
  e.HOME = home;
  return e;
};

const runInit = () =>
  spawnSync(process.execPath, [CLI, 'init'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    env: env(),
  });

const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));

/** 输出里那一行：带上了 / 没带上。 */
const patchLine = (out) =>
  (out ?? '')
    .split(/\r?\n/)
    .find(
      (l) =>
        l.includes('开发的命令带上了 DSH 补丁') ||
        l.includes('没找到 ~/.dsh/ixaeon-relay.patch.yml'),
    ) ?? '';

const EXPECTED_HEAD = ['node', '{relay_root}/packages/relay/bin/dsh.mjs', '--profile', 'headless'];
const EXPECTED_TAIL = ['--json', '读 {prompt_file}，照里面做。'];
const YES_LINE = '开发的命令带上了 DSH 补丁：~/.dsh/ixaeon-relay.patch.yml';
const NO_LINE =
  '没找到 ~/.dsh/ixaeon-relay.patch.yml，开发的命令没带 --patch（DSH 会用 headless 默认的设置：DeepSeek 官方 API、关在沙箱里）';

const reportArgv = (argv) => {
  const i = argv.indexOf('--patch');
  log(`   开发 argv（遮掉临时目录）：${JSON.stringify(argv.map((a) => mask(a)))}`);
  check(i > -1, '开发 argv 里有 --patch');
  if (i > -1)
    check(argv[i + 1] === patchFile, '紧跟的是补丁文件的绝对路径', argv[i + 1] ?? '（没有）');
};

try {
  log('== 一、没有补丁文件：跑一次 relay init');
  // 先确认现场：不许落到用户真的数据目录。
  check(relayDir.startsWith(work), '数据目录在临时目录下', relayDir);
  let r = runInit();
  log(`   relay init 退出码 ${r.status}`);
  check(r.status === 0, '退出码 0', String(r.status));
  check(existsSync(configFile), '写出了 config.json');
  let argv = readConfig().roles.developer.argv;
  check(
    argv.slice(0, EXPECTED_HEAD.length).join('\u0000') === EXPECTED_HEAD.join('\u0000'),
    '前四项是 node/启动器/--profile/headless',
  );
  check(argv.length === 6, 'argv 一共 6 项（没有 --patch）', String(argv.length));
  check(argv.slice(4).join('\u0000') === EXPECTED_TAIL.join('\u0000'), '后两项是 --json / 提示词');
  check(!argv.includes('--patch'), '开发 argv 里没有 --patch');
  log(`   输出那一行（原样）：${patchLine(r.stdout)}`);
  check(patchLine(r.stdout) === NO_LINE, '输出是「没带上」那句');
  if ((r.stderr ?? '').trim()) log(`   stderr：${(r.stderr ?? '').trim().slice(0, 400)}`);

  log('== 二、放上补丁文件、删掉配置：再跑一次 relay init');
  rmSync(configFile, { force: true });
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, 'profile: synthetic\n', 'utf8');
  r = runInit();
  log(`   relay init 退出码 ${r.status}`);
  check(r.status === 0, '退出码 0', String(r.status));
  check(existsSync(configFile), '写出了 config.json');
  argv = readConfig().roles.developer.argv;
  reportArgv(argv);
  check(argv.length === 8, 'argv 一共 8 项（多出 --patch 和路径）', String(argv.length));
  check(
    argv.slice(0, EXPECTED_HEAD.length).join('\u0000') === EXPECTED_HEAD.join('\u0000'),
    '前四项是 node/启动器/--profile/headless',
  );
  check(
    argv.slice(6).join('\u0000') === EXPECTED_TAIL.join('\u0000'),
    '最后两项还是 --json / 提示词',
  );
  log(`   输出那一行（原样）：${patchLine(r.stdout)}`);
  check(patchLine(r.stdout) === YES_LINE, '输出是「带上了」那句');
  check(
    !patchLine(r.stdout).includes(home) && !patchLine(r.stdout).includes(work),
    '那一行里没有临时家目录的绝对路径',
  );
  if ((r.stderr ?? '').trim()) log(`   stderr：${(r.stderr ?? '').trim().slice(0, 400)}`);
} catch (err) {
  bad++;
  log(`  ✗ 出错：${mask(err instanceof Error ? err.message : String(err))}`);
} finally {
  // relay init 建了 <工作目录根>/relay-int（git worktree）：先从真仓库摘掉，再删临时目录。
  spawnSync('git', ['worktree', 'remove', '--force', join(treeRoot, 'relay-int')], {
    cwd: repo,
    windowsHide: true,
  });
  spawnSync('git', ['worktree', 'prune'], { cwd: repo, windowsHide: true });
  rmSync(work, { recursive: true, force: true });
}

log(bad === 0 ? '结论：通过' : `结论：不通过（${bad} 条不符）`);
log(bad === 0 ? 'RESULT 通过' : 'RESULT 没通过');
process.exit(bad === 0 ? 0 : 1);
