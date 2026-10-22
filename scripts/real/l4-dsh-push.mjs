/**
 * L4 真机检查「乙」：DSH 的沙箱里推 GitHub（真调用 ≤ 2 次）。
 *
 * 临时目录里 `git clone --depth 1` 真仓库，让 DSH 建分支 `relay-probe/<时间戳>`、
 * 提交一个空提交（消息照规格），推到 GitHub。脚本最后**一定删掉这个远端分支**
 * （`git push origin --delete`，失败重试），并打印删没删成。
 *
 * 不改 DSH 的权限设置、不改 git 的凭据设置；不打印凭据；输出遮掉临时目录和账户名。
 * 推不上去就如实记下报错（遮掉用户目录）。
 *   node scripts/real/l4-dsh-push.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/plnoble/OMNIX-IXAEON.git';
const COMMIT_MSG = '接力探测：DSH 沙箱里推送（会马上删掉）';
const work = mkdtempSync(join(tmpdir(), 'ixa-l4-push-'));
const clone = join(work, 'repo');
const branch = `relay-probe/${Math.floor(Date.now() / 1000)}`;

const mask = (s) => {
  let text = String(s);
  for (const p of [work, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  // 兜底：URL 里的凭据片段（user:token@）一律遮掉
  text = text.replace(/\/\/[^/\s@]+@/g, '//***@');
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args, allowFail = false) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
  }
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/** dsh 的真入口：`DeepSeek Harness.exe --expose-internals <app.asar 里的 cli.js>`（照 L0b）。 */
function dshBin() {
  const installs = [
    process.env.IXAEON_DSH_INSTALL?.trim(),
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ].filter((x) => x && x.trim());
  for (const install of installs) {
    const exe = join(install, 'DeepSeek Harness.exe');
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
    if (existsSync(exe) && existsSync(join(install, 'resources', 'app.asar'))) {
      return { exe, cli };
    }
  }
  return null;
}

const dsh = dshBin();
if (!dsh) {
  log('没跑：没找到 DeepSeek Harness 的安装目录');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

let passed = true;
const check = (ok, what) => {
  log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) passed = false;
};

/** 远端分支还在不在（`ls-remote`）。 */
const remoteHasBranch = () =>
  git(clone, ['ls-remote', '--heads', 'origin', branch], true).out.includes(branch);

/** 删远端分支：失败重试（3 次，隔 2 秒）。 */
const deleteBranch = () => {
  for (let i = 0; i < 3; i++) {
    const r = git(clone, ['push', 'origin', '--delete', branch], true);
    if (r.code === 0) return { ok: true, out: r.out };
    if (i < 2) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']);
  }
  return { ok: false, out: git(clone, ['push', 'origin', '--delete', branch], true).out };
};

try {
  log(`== 乙：DSH 的沙箱里推 GitHub｜分支 ${branch}`);
  const cloned = git(work, ['clone', '--depth', '1', REPO_URL, clone], true);
  if (cloned.code !== 0) {
    log(`   克隆失败：${mask(cloned.out).slice(0, 400)}`);
    passed = false;
  } else {
    runTurn();
  }
} finally {
  // 不管成没成，都删远端分支
  const had = remoteHasBranch();
  if (had) {
    const del = deleteBranch();
    const gone = !remoteHasBranch();
    log(`   删远端分支：${del.ok && gone ? '删掉了' : '没删成'}`);
    if (!del.ok) log(`   删除报错（截 300 字）：${mask(del.out).slice(0, 300)}`);
    check(gone, '探测分支已经删掉');
  } else {
    log('   删远端分支：远端本来就没有这个分支（不用删）');
  }
  rmSync(work, { recursive: true, force: true });
  log(passed ? 'RESULT 通过' : 'RESULT 没通过');
  process.exit(passed ? 0 : 1);
}

/** 克隆好了之后：写交代、起 DSH、看远端。 */
function runTurn() {
  log(`   克隆好了：${mask(clone)}`);

  const promptPath = join(work, 'prompt.md');
  writeFileSync(
    promptPath,
    [
      '你是开发 agent（名字 dev）。当前目录是一个克隆，origin 指向 GitHub 上的公开仓库。',
      '这一棒只做三件事，做完就停：',
      `1. 建一个分支：git switch -c ${branch}`,
      `2. 提交一个空提交：git commit --allow-empty -m "${COMMIT_MSG}"`,
      '3. 推上去：git push -u origin ' + branch,
      '推不上去就如实记下报错（不要改任何凭据设置、不要换协议、不要用别的办法绕过）。',
      '最后一行输出：RELAY-DONE 1 <推成了还是没推成>',
      '',
    ].join('\n'),
    'utf8',
  );

  /** 启动器：Node 直接起 DeepSeek Harness.exe，带 ELECTRON_RUN_AS_NODE=1（dsh.cmd 的原文做法）。 */
  const launcher = join(work, 'dsh-launcher.mjs');
  writeFileSync(
    launcher,
    [
      "import { spawn } from 'node:child_process';",
      'const [exe, cli, ...rest] = process.argv.slice(2);',
      "const child = spawn(exe, ['--expose-internals', cli, ...rest], {",
      '  stdio: "inherit",',
      '  windowsHide: true,',
      '  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },',
      '});',
      'child.on("error", (e) => { console.error(String(e)); process.exit(1); });',
      'child.on("close", (c) => process.exit(c ?? 1));',
      '',
    ].join('\n'),
    'utf8',
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [launcher, dsh.exe, dsh.cli, '--profile', 'headless', '--json', `读 ${promptPath}，照里面做。`],
    { cwd: clone, encoding: 'utf8', env, windowsHide: true, timeout: 900_000 },
  );
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  log(`   DSH 退出码 ${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`);

  const raw = `${r.stdout ?? ''}`;
  const parsed = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  const calls = parsed.filter((j) => j && j.type === 'tool_call');
  const finals = parsed.filter((j) => j && j.type === 'final');
  log(
    `   JSONL 行 ${raw.split('\n').filter(Boolean).length}｜tool_call ${calls.length} 条｜最终回答 ${finals.length} 条`,
  );
  for (const c of calls) {
    const detail = c.input?.command ?? c.input?.file_path ?? JSON.stringify(c.input ?? {});
    log(`     tool=${c.tool}｜${mask(String(detail)).slice(0, 220)}`);
  }
  log(`   它最后说的（截 900 字）：${mask(String(finals.at(-1)?.text ?? '')).slice(0, 900)}`);
  if ((r.stderr ?? '').trim())
    log(`   stderr（截 500 字）：${mask((r.stderr ?? '').trim()).slice(0, 500)}`);
  log(
    `   额度字样：${/usage_limit_reached|session limit|\b429\b/i.test(raw) ? '出现了' : '没出现'}`,
  );

  // 远端真的有没有这个分支（脚本自己查，不听模型自述）
  const pushed = remoteHasBranch();
  log(`   Git 的远端分支存在吗：${pushed}`);
  if (!pushed) {
    const pushLine = calls.find((c) => String(c.input?.command ?? '').includes('push'));
    if (pushLine) log(`   它推的那条命令：${mask(String(pushLine.input.command)).slice(0, 400)}`);
  }
  check(pushed, 'DSH 在沙箱里把探测分支推上了 GitHub');
}
