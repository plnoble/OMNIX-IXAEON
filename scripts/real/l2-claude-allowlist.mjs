/**
 * L2 真机检查「甲」：--restricted 之下 --allowedTools 的前缀怎么写才放行。
 *
 * 整合方那一棒要跑 git、node scripts/…、corepack pnpm、gh run。L0b 只验过整条命令
 * （PowerShell(node --version)）。这里每种前缀写法一次真调用，看 permission_denials，
 * 并看没放行的 Remove-Item 会不会被拒。
 *
 * 一律带 --restricted、--permission-prompts none。不用任何「跳过所有权限」的开关。
 * 全在临时 git 仓库里跑。输出遮掉临时目录和账户名。真调用由 --probe 一次一条。
 *
 *   node scripts/real/l2-claude-allowlist.mjs --probe colon-all
 *   node scripts/real/l2-claude-allowlist.mjs --probe space-all
 *   node scripts/real/l2-claude-allowlist.mjs --probe colon-chain
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const probe = (() => {
  const i = argv.indexOf('--probe');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
})();

const PROBES = {
  'colon-all': {
    note: '冒号前缀：PowerShell(git:*) (node:*) (corepack:*) (gh:*)',
    allow: 'PowerShell(git:*) PowerShell(node:*) PowerShell(corepack:*) PowerShell(gh:*)',
    prompt: [
      '只用 PowerShell 工具，按顺序把下面每一条原样各跑一次。',
      '不要合并，不要改写，不要加别的参数，不要用分号把几条连成一条。',
      '1. git status --short',
      '2. git log -1 --oneline',
      '3. node scripts/hello.mjs',
      '4. corepack pnpm --version',
      '5. gh run list --limit 1',
      '6. Remove-Item -LiteralPath note.txt',
      '每条用一句话说成了还是被拒绝。最后一行只写：RELAY-DONE 1 完成',
    ].join('\n'),
  },
  'space-all': {
    note: '空格前缀：PowerShell(git *) (node *) (corepack *) (gh *)',
    allow: 'PowerShell(git *) PowerShell(node *) PowerShell(corepack *) PowerShell(gh *)',
    prompt: [
      '只用 PowerShell 工具，按顺序把下面每一条原样各跑一次。',
      '不要合并，不要改写，不要加别的参数，不要用分号把几条连成一条。',
      '1. git status --short',
      '2. git log -1 --oneline',
      '3. node scripts/hello.mjs',
      '4. corepack pnpm --version',
      '5. gh run list --limit 1',
      '6. Remove-Item -LiteralPath note.txt',
      '每条用一句话说成了还是被拒绝。最后一行只写：RELAY-DONE 1 完成',
    ].join('\n'),
  },
  'pnpm-direct': {
    note: '只放行 PowerShell(corepack:*)，看直接跑 pnpm 会不会被放行',
    allow: 'PowerShell(corepack:*)',
    prompt: [
      '只用 PowerShell 工具，原样跑这一条命令，不要改写成 corepack pnpm：',
      'pnpm --version',
      '说成了还是被拒绝。最后一行只写：RELAY-DONE 1 完成',
    ].join('\n'),
  },
  'via-cmd': {
    note: '只放行 PowerShell(git:*)，看 cmd /c git 这种绕过开头的写法会不会被放行',
    allow: 'PowerShell(git:*)',
    prompt: [
      '只用 PowerShell 工具，原样跑这一条命令，不要改写成直接的 git：',
      'cmd /c git status --short',
      '说成了还是被拒绝。最后一行只写：RELAY-DONE 1 完成',
    ].join('\n'),
  },
  'colon-chain': {
    note: '只放行 PowerShell(git:*)，看一条命令里用分号再接 Remove-Item 会不会被放行',
    allow: 'PowerShell(git:*)',
    prompt: [
      '只用 PowerShell 工具，原样跑这一条命令，不要拆开、不要改写：',
      'git status --short; Remove-Item -LiteralPath note.txt',
      '跑完说 note.txt 还在不在。最后一行只写：RELAY-DONE 1 完成',
    ].join('\n'),
  },
};

const base = mkdtempSync(join(tmpdir(), 'ixa-l2-allow-'));
const mask = (s) => {
  let text = String(s);
  const paths = [
    base,
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
    tmpdir(),
  ].filter((x) => x && x.trim());
  for (const p of paths) {
    for (const variant of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      if (variant) text = text.split(variant).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};

if (!PROBES[probe]) {
  console.log(`用法：--probe ${Object.keys(PROBES).join(' | ')}`);
  rmSync(base, { recursive: true, force: true });
  process.exit(probe ? 1 : 0);
}

function claudeExe() {
  const p = join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  if (!existsSync(p)) throw new Error('没找到 claude.exe');
  return p;
}

const spec = PROBES[probe];
mkdirSync(join(base, 'scripts'), { recursive: true });
writeFileSync(join(base, 'scripts', 'hello.mjs'), 'console.log("hello-from-script")\n', 'utf8');
writeFileSync(join(base, 'note.txt'), '合成的一行\n', 'utf8');
const git = (args) => {
  const r = spawnSync('git', args, { cwd: base, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
};
git(['init', '-b', 'main']);
git(['config', 'user.email', 'relay@example.invalid']);
git(['config', 'user.name', 'relay']);
git(['add', '-A']);
git(['commit', '-m', '合成初始提交']);

const args = [
  '--restricted',
  '--tools',
  'PowerShell',
  '--allowedTools',
  spec.allow,
  '--permission-prompts',
  'none',
  '--output-format',
  'json',
  '-p',
  spec.prompt,
];
console.log(`== probe=${probe}｜${spec.note}`);
console.log('   白名单：' + spec.allow);

const t0 = Date.now();
const r = spawnSync(claudeExe(), args, {
  cwd: base,
  encoding: 'utf8',
  timeout: 300_000,
  windowsHide: true,
});
const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
console.log(`   exit=${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`);

let parsed = null;
try {
  parsed = JSON.parse((r.stdout ?? '').trim());
} catch {
  parsed = null;
}
const quota = /usage_limit_reached|session limit|\b429\b/i.test(
  `${r.stdout ?? ''}${r.stderr ?? ''}`,
);
if (parsed) {
  const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [];
  const brief = denials.map((d) => {
    const name = d.tool_name ?? d.tool ?? '(没名字)';
    const input = d.tool_input ?? d.input ?? {};
    const cmd = typeof input === 'string' ? input : (input.command ?? JSON.stringify(input));
    return `${name}:${mask(String(cmd)).slice(0, 160)}`;
  });
  console.log(
    `   is_error=${parsed.is_error}｜api_error_status=${parsed.api_error_status ?? '(无)'}` +
      `｜total_cost_usd=${parsed.total_cost_usd ?? '(无)'}`,
  );
  console.log(`   被拒 ${denials.length} 条：${brief.length ? brief.join(' || ') : '(没有)'}`);
  console.log(`   模型说的话：${mask(String(parsed.result ?? '')).slice(0, 900)}`);
} else {
  const err = mask((r.stderr ?? '').trim()).slice(0, 300);
  if (err) console.log(`   stderr：${err}`);
  console.log(`   原始输出：${mask((r.stdout ?? '').trim()).slice(0, 500)}`);
}

const noteLeft = existsSync(join(base, 'note.txt'));
let hello = '(脚本没留下标记)';
try {
  hello = readFileSync(join(base, 'scripts', 'hello.mjs'), 'utf8').includes('hello-from-script')
    ? 'hello.mjs 还在'
    : 'hello.mjs 被改了';
} catch {
  hello = 'hello.mjs 不见了';
}
console.log(`   事后：note.txt ${noteLeft ? '还在' : '被删了'}｜${hello}`);
console.log(quota ? 'RESULT 撞上额度，停' : 'RESULT 这一次跑完');
rmSync(base, { recursive: true, force: true });
process.exit(quota ? 2 : r.status === 0 || r.status === null ? 0 : (r.status ?? 1));
