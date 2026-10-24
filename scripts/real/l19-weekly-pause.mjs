/**
 * L19 真机检查：撞上周额度 → 歇到下一个北京时间周四 04:00（委派单「真机检查」）。
 *
 * 在**临时目录**里建一个合成的 git 仓库（bare origin + 整合方/开发各一个克隆），队列里放一行
 * 「待复审（整合方）」，让下一次 `relay once` 派给整合方。整合方是**替身**：打一行带周额度字样的
 * 输出就退，不改仓库、不调模型。
 *
 * 跑完读 `<数据目录>/state.json`，把 `pausedUntil.integrator` 换成北京时间打出来，核对它是不是
 * 某个周四 04:00:00.000、晚于现在、不超过 7 天；不是就「结论：不通过」退 1。
 *
 * 不真撞额度（不许故意耗尽）、不碰用户的数据目录。打印的路径与本机账户名都遮掉。
 *   node scripts/real/l19-weekly-pause.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repo, 'packages', 'relay', 'bin', 'relay.mjs');
const DAY = 86_400_000;

const work = mkdtempSync(join(tmpdir(), 'ixa-l19-weekly-'));
const mask = (s) => {
  let text = String(s);
  for (const p of [
    work,
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

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
  return (r.stdout ?? '').trim();
};

let bad = 0;
const check = (ok, what, extra = '') => {
  if (!ok) bad++;
  log(`  ${ok ? '✓' : '✗'} ${what}${extra ? `：${mask(extra)}` : ''}`);
};

const QUEUE = [
  '# 委派队列（合成的）',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 90 | L90 合成：一行等整合方复审的活 | [L90](L90.md) | A | 无 | 待复审（整合方） |',
  '',
].join('\n');

/** 替身整合方：打一行合成的周额度字样就退，不动仓库。 */
const INTEG_STUB = [
  'console.log("error: WEEKLY QUOTA EXCEEDED · resets next Thursday 04:00 (Asia/Shanghai)");',
  'console.log("RELAY-DONE 90 待复审（整合方）");',
  '',
].join('\n');
/** 替身开发：这一单里轮不到它。 */
const DEV_STUB = 'console.log("RELAY-DONE 90 不关我的事");\n';

try {
  log('== 一、合成仓库 + 一行「待复审（整合方）」+ 替身整合方');
  const origin = join(work, 'origin.git');
  const seed = join(work, 'seed');
  const integ = join(work, 'integ');
  const dev = join(work, 'dev');
  const dataDir = join(work, 'relay');
  mkdirSync(dataDir, { recursive: true });
  git(work, ['init', '--bare', '-b', 'main', origin]);
  git(work, ['clone', '-q', origin, seed]);
  git(seed, ['config', 'user.email', 'relay@example.invalid']);
  git(seed, ['config', 'user.name', 'relay']);
  mkdirSync(join(seed, 'docs', '委派'), { recursive: true });
  writeFileSync(join(seed, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', '初始合成仓库']);
  git(seed, ['push', '-q', 'origin', 'HEAD:main']);
  for (const d of [integ, dev]) {
    git(work, ['clone', '-q', origin, d]);
    git(d, ['config', 'user.email', 'relay@example.invalid']);
    git(d, ['config', 'user.name', 'relay']);
  }

  const integStub = join(work, 'stub-integ.mjs');
  const devStub = join(work, 'stub-dev.mjs');
  writeFileSync(integStub, INTEG_STUB, 'utf8');
  writeFileSync(devStub, DEV_STUB, 'utf8');

  const config = {
    roles: {
      integrator: {
        argv: [process.execPath, integStub, '{prompt_file}'],
        cwd: integ,
        timeoutMinutes: 2,
        quotaPatterns: ['usage_limit_reached', 'session limit'],
        quotaPauseMinutes: 120,
        // 合成的周额度字样（真 Claude 的周额度报错还没见过，见交付说明）。
        weeklyQuotaPatterns: ['weekly quota exceeded'],
      },
      developer: {
        argv: [process.execPath, devStub, '{prompt_file}'],
        cwd: dev,
        timeoutMinutes: 2,
        quotaPatterns: [],
        quotaPauseMinutes: 60,
      },
    },
    idleSeconds: 1,
    localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
  };
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
    'utf8',
  );

  log('== 二、跑一次 relay once（替身整合方打周额度字样）');
  const before = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'once'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
    windowsHide: true,
    timeout: 120_000,
  });
  const after = Date.now();
  log(`   relay once 退出码 ${r.status}｜${(r.stdout ?? '').trim()}`);
  if ((r.stderr ?? '').trim()) log(`   stderr：${mask((r.stderr ?? '').trim()).slice(0, 400)}`);
  check(r.status === 0, 'relay once 退出码 0', String(r.status));

  const ledgerPath = join(dataDir, 'ledger.jsonl');
  const rows = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  log(
    `   记账：${JSON.stringify(rows.map((x) => ({ turn: x.turn, role: x.role, quotaHit: x.quotaHit })))}`,
  );
  check(rows.length === 1 && rows[0].role === 'integrator', '只跑了一棒，派给整合方');
  check(rows[0]?.quotaHit === true, '这一棒记成撞了额度（quotaHit=true）');

  log('== 三、state.json 里的 pausedUntil');
  const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  const raw = state.pausedUntil?.integrator;
  log(`   pausedUntil（UTC）=${raw ?? '（没有）'}`);
  let bj = null;
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) {
    const d = new Date(Date.parse(raw) + 8 * 3_600_000);
    bj = d;
    const pad = (n) => String(n).padStart(2, '0');
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
    log(
      `   北京时间 = ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
        `${String(d.getUTCMilliseconds()).padStart(3, '0')}（${week}）`,
    );
  }
  check(!!bj, 'state.json 里有 integrator 的 pausedUntil');
  if (bj) {
    check(bj.getUTCDay() === 4, '那是个周四', String(bj.getUTCDay()));
    check(
      bj.getUTCHours() === 4 &&
        bj.getUTCMinutes() === 0 &&
        bj.getUTCSeconds() === 0 &&
        bj.getUTCMilliseconds() === 0,
      '时间是 04:00:00.000',
      `${bj.getUTCHours()}:${bj.getUTCMinutes()}:${bj.getUTCSeconds()}.${bj.getUTCMilliseconds()}`,
    );
    const diff = bj.getTime() - 8 * 3_600_000 - before;
    check(diff > 0, '晚于现在', `${diff}ms`);
    check(diff <= 7 * DAY + (after - before), '不超过 7 天', `${diff}ms`);
  }
} catch (err) {
  bad++;
  log(`  ✗ 出错：${mask(err instanceof Error ? err.message : String(err))}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

log(bad === 0 ? '结论：通过' : `结论：不通过（${bad} 条不符）`);
log(bad === 0 ? 'RESULT 通过' : 'RESULT 没通过');
process.exit(bad === 0 ? 0 : 1);
