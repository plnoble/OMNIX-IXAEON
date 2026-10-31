/**
 * L16 真机检查甲：真连飞书长连接，验「连上了、打出 收听中 / 绑好了 / 收到」。
 *
 * 用法（开发手动跑，用户配合在群里 @ 机器人说话）：
 *   node scripts/real/l16-feishu-listen.mjs --bind            # 第一次：建临时数据目录（复制凭据副本）并绑定
 *   node scripts/real/l16-feishu-listen.mjs --data <上一次打印的目录>   # 绑好后：正常收听
 *   node scripts/real/l16-feishu-listen.mjs --cleanup <目录>   # 收尾：删临时目录
 *
 * 隐私（这一单特别要紧）：
 * - 凭据文件只 **复制**（~/.ixaeon/relay/feishu-app.json、feishu.json → 临时目录），从不读内容、不打印；
 * - 所有输出先遮：用户目录（C:\Users\<账户名> → ~）、看起来像密钥的长 token → <已隐藏>；
 * - 交付说明里只贴：状态行（收听中 / 绑好了 / 没理：…）、inbox.jsonl 的行数、用户说看到了什么。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const argv = process.argv.slice(2);

const mask = (text) => {
  let out = String(text);
  const home = homedir();
  if (home) {
    for (const form of [home, home.replaceAll('\\', '/')]) out = out.split(form).join('~');
    const name = home.split(/[\\/]/).pop();
    if (name) out = out.split(name).join('~');
  }
  // 像 appSecret / token 的长串（字母数字 20 位以上）一律遮掉，宁可错杀
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, '<已隐藏>');
  return out;
};
const log = (s) => console.log(mask(s));

const cleanupAt = (() => {
  const i = argv.indexOf('--cleanup');
  return i >= 0 ? argv[i + 1] : null;
})();
if (cleanupAt) {
  rmSync(cleanupAt, { recursive: true, force: true });
  log(`已删临时目录（${existsSync(cleanupAt) ? '没删掉' : '删掉了'}）`);
  process.exitCode = 0;
} else {
  const dataDir = (() => {
    const i = argv.indexOf('--data');
    if (i >= 0) return argv[i + 1];
    const dir = mkdtempSync(join(tmpdir(), 'ixa-l16-real-'));
    const home = homedir();
    const appSrc = join(home, '.ixaeon', 'relay', 'feishu-app.json');
    const botSrc = join(home, '.ixaeon', 'relay', 'feishu.json');
    for (const [src, name] of [
      [appSrc, 'feishu-app.json'],
      [botSrc, 'feishu.json'],
    ]) {
      if (!existsSync(src)) {
        log(`没跑：${home}\\.ixaeon\\relay\\${name} 不存在（这一步要用户的应用先建好）`);
        process.exit(1);
      }
      copyFileSync(src, join(dir, name)); // 只复制，不读内容
    }
    log(`临时数据目录（凭据已复制为副本，内容没看过）：${dir}`);
    return dir;
  })();

  const bind = argv.includes('--bind');
  log(`== 甲：relay listen${bind ? ' --bind' : ''}（真飞书长连接，用户在群里 @ 机器人）`);

  const pnpm = join(REPO, 'node_modules', '.pnpm');
  const jitiDir = readdirSync(pnpm).find((d) => d.startsWith('jiti@'));
  if (!jitiDir) {
    log('没跑：没找到 jiti 的 CLI');
    process.exit(1);
  }
  const cli = join(pnpm, jitiDir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs');
  const r = spawnSync(
    process.execPath,
    [
      cli,
      join(REPO, 'packages', 'relay', 'bin', 'relay-main.ts'),
      'listen',
      ...(bind ? ['--bind'] : []),
    ],
    {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      timeout: bind ? 300_000 : 600_000,
      env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
    },
  );
  log('== 输出（遮过） ==');
  for (const line of `${r.stdout ?? ''}`.trim().split('\n').filter(Boolean)) log(`   ${line}`);
  if ((r.stderr ?? '').trim()) {
    log('== 错误输出（遮过） ==');
    for (const line of r.stderr.trim().split('\n').slice(0, 20)) log(`   ${line}`);
  }
  log(`== 退出码 ${r.status ?? '?'}`);
  const inbox = join(dataDir, 'inbox.jsonl');
  if (existsSync(inbox)) {
    const lines = readFileSync(inbox, 'utf8').split('\n').filter(Boolean);
    log(`== inbox.jsonl 行数：${lines.length}（内容不贴）`);
  }
  process.exitCode = r.status ?? 1;
}
