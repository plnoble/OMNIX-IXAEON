/**
 * L0b「乙」：Claude 用「只放行必要操作」的白名单写文件。
 *
 * L0 证明了 `claude -p` 不给权限就写不了（Write 被拒）。这里试**只放行必要操作**的办法：
 * 命令行上的白名单（`--allowedTools`、`--permission-mode`、`--permission-prompts none`）
 * 或项目目录里的设置文件（`--settings <file>` 或 `<工作目录>/.claude/settings.json`）。
 *
 * 不许用：`--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions`、
 * `--permission-mode bypassPermissions`（这几个都是「跳过所有权限」）。
 * 不看、不打印任何凭据文件；全在一次性临时目录里跑合成任务；输出遮掉临时目录与账户名。
 *
 *   node scripts/real/l0b-claude-allowlist.mjs --probe help
 *   node scripts/real/l0b-claude-allowlist.mjs --probe tiny
 *   node scripts/real/l0b-claude-allowlist.mjs --probe inside
 *   node scripts/real/l0b-claude-allowlist.mjs --probe outside
 *   node scripts/real/l0b-claude-allowlist.mjs --probe cmd-allowed
 *   node scripts/real/l0b-claude-allowlist.mjs --probe cmd-denied
 *   node scripts/real/l0b-claude-allowlist.mjs --probe settings-inside
 *   node scripts/real/l0b-claude-allowlist.mjs --probe prompts-none
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mask = (s) => {
  let text = String(s);
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
  ].filter((x) => x && x.trim())) {
    for (const variant of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(variant).join('<本机>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const probe = (() => {
  const i = argv.indexOf('--probe');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'help';
})();

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

if (probe === 'help') {
  const r = spawnSync(claudeExe(), ['--help'], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const lines = text.split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (
      /allowedTools|disallowedTools|permission-mode|permission-prompts|--tools |--settings/.test(
        lines[i],
      )
    ) {
      keep.push(lines[i], lines[i + 1] ?? '', lines[i + 2] ?? '');
    }
  }
  console.log('=== claude 的权限相关开关（原样，遮罩后） ===');
  console.log(mask(keep.filter((l) => l !== undefined).join('\n')));
  process.exit(0);
}

const base = mkdtempSync(join(tmpdir(), 'ixa-l0b-claude-'));
const work = join(base, 'work');
const outside = join(base, 'outside');
for (const d of [work, outside]) mkdirSync(d, { recursive: true });
writeFileSync(join(work, 'note.txt'), '合成项目里的一个文件\n', 'utf8');
const settingsFile = join(work, 'settings.json');
writeFileSync(
  settingsFile,
  `${JSON.stringify({ permissions: { allow: ['Write'], deny: [] } }, null, 2)}\n`,
  'utf8',
);
const projectSettings = join(work, '.claude', 'settings.json');
mkdirSync(join(work, '.claude'), { recursive: true });
writeFileSync(
  projectSettings,
  `${JSON.stringify({ permissions: { allow: ['Write'] } }, null, 2)}\n`,
  'utf8',
);

/** 每个 probe 的 argv（都不含任何「跳过所有权限」的开关）。 */
function buildArgs() {
  const json = ['--output-format', 'json'];
  switch (probe) {
    case 'tiny':
      return { args: ['-p', '只回三个字母：OK', ...json], note: '不带任何白名单（对照）' };
    case 'inside':
      return {
        args: ['-p', '在当前目录建 inside.txt，里面只写 OK', '--allowedTools', 'Write', ...json],
        note: '--allowedTools Write（命令行白名单）',
      };
    case 'outside':
      return {
        args: [
          '-p',
          `把 OK 写到 ${join(outside, 'outside.txt')} 这个文件里`,
          '--allowedTools',
          'Write',
          '--permission-prompts',
          'none',
          ...json,
        ],
        note: '--allowedTools Write 但目标是目录外；同时 --permission-prompts none（没人回答弹窗，要弹的一律自动拒）',
      };
    case 'cmd-allowed':
      return {
        args: [
          '-p',
          '跑这条命令并把输出原样告诉我：node --version',
          '--allowedTools',
          'Bash(node --version)',
          ...json,
        ],
        note: '--allowedTools "Bash(node --version)"，让它跑这条（应当成）',
      };
    case 'cmd-denied':
      return {
        args: [
          '-p',
          '跑这条命令并把输出原样告诉我：node -e "console.log(2)"',
          '--allowedTools',
          'Bash(node --version)',
          ...json,
        ],
        note: '白名单里只有 Bash(node --version)，让它跑另一条（应当被拒）',
      };
    case 'settings-inside':
      return {
        args: [
          '-p',
          '在当前目录建 settings-inside.txt，里面只写 OK',
          '--settings',
          settingsFile,
          ...json,
        ],
        note: `--settings <临时文件>（命令行给设置文件；文件里 permissions.allow=["Write"]）`,
      };
    case 'project-settings-inside':
      return {
        args: ['-p', '在当前目录建 project-settings.txt，里面只写 OK', ...json],
        note: `<工作目录>/.claude/settings.json 里 permissions.allow=["Write"]（不给命令行开关）`,
      };
    case 'cmd-both':
      return {
        args: [
          '-p',
          '按顺序跑这两条命令，把每一条的输出原样告诉我：先 `node --version`，再 `node -e "console.log(2)"`',
          '--allowedTools',
          'Bash(node --version)',
          ...json,
        ],
        note: '白名单里只有 Bash(node --version)：第一条应当跑成，第二条应当被拒（一次调用把两边都看了）',
      };
    case 'restricted-outside':
      return {
        args: [
          '--restricted',
          '-p',
          `把 OK 写到 ${join(outside, 'restricted.txt')} 这个文件里；写不成也告诉我为什么`,
          '--allowedTools',
          'Write',
          ...json,
        ],
        note: '--restricted（把文件工具关在工作目录里、拒 bypassPermissions）+ --allowedTools Write，目标仍是目录外',
      };
    case 'restricted-inside':
      return {
        args: [
          '--restricted',
          '-p',
          '在当前目录建 restricted-inside.txt，里面只写 OK',
          '--allowedTools',
          'Write',
          ...json,
        ],
        note: '--restricted 之下，目录里建文件（应当仍然成）',
      };
    case 'restricted-full':
      return {
        args: [
          '--restricted',
          '--tools',
          'PowerShell',
          '-p',
          [
            '做三件事，每件事都告诉我成没成：',
            '1) 在当前目录建 restricted2.txt，里面只写 OK；',
            '2) 跑 `node --version`，把版本号原样告诉我；',
            `3) 把 OK 写到 ${join(outside, 'restricted2.txt')} 这个文件里。`,
          ].join(' '),
          '--allowedTools',
          'Write Edit PowerShell(node --version)',
          ...json,
        ],
        note: '--restricted + --tools PowerShell + 白名单（Write Edit PowerShell(node --version)）：一次看三件事——目录里写、放行的那条命令、目录外写',
      };
    case 'prompts-none':
      return {
        args: [
          '-p',
          `把 OK 写到 ${join(outside, 'prompts-none.txt')} 这个文件里`,
          '--allowedTools',
          'Write',
          '--permission-prompts',
          'none',
          ...json,
        ],
        note: '--permission-prompts none（没人回答弹窗，要弹的一律自动拒）',
      };
    default:
      throw new Error(`不认识的 probe：${probe}`);
  }
}

const { args, note } = buildArgs();
const settingsBefore = existsSync(projectSettings)
  ? `${Math.round(statSync(projectSettings).mtimeMs)}/${statSync(projectSettings).size}`
  : '(没有)';
console.log(`== probe=${probe}｜${note}`);
console.log(`   工作目录：${work}｜目录外：${outside}`);

const t0 = Date.now();
const r = spawnSync(claudeExe(), args, {
  cwd: work,
  encoding: 'utf8',
  timeout: 300_000,
  windowsHide: true,
});
const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
const stdoutText = (r.stdout ?? '').trim();
const stderrText = (r.stderr ?? '').trim();
console.log(`   exit=${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`);
if (stderrText) console.log(`   stderr（截 200 字）：${mask(stderrText).slice(0, 200)}`);

let parsed = null;
try {
  parsed = JSON.parse(stdoutText);
} catch {
  /* 不是纯 JSON 就原样打 */
}
if (parsed) {
  const denials = (parsed.permission_denials ?? []).map((d) => d.tool_name ?? '(没名字)');
  console.log(
    `   is_error=${parsed.is_error}｜terminal_reason=${parsed.terminal_reason ?? '(无)'}` +
      `｜api_error_status=${parsed.api_error_status ?? '(无)'}` +
      `｜total_cost_usd=${parsed.total_cost_usd}`,
  );
  console.log(`   被拒的工具：${denials.length ? denials.join('、') : '(没有被拒的)'}`);
  console.log(
    `   模型说的话（截 300 字）：${JSON.stringify(String(parsed.result ?? '').slice(0, 300))}`,
  );
} else {
  console.log(`   原始输出（截 400 字）：${mask(text).slice(0, 400)}`);
}

const listTree = (dir) => {
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      if (name === '.claude') continue;
      const p = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      out.push(isDir ? `${rel}/` : `${rel} (${statSync(p).size} bytes)`);
      if (isDir) walk(p, rel);
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* 空目录 */
  }
  return out;
};
console.log(`   工作目录里：${listTree(work).join('、') || '(空)'}`);
console.log(`   目录外：${listTree(outside).join('、') || '(空)'}`);
const settingsAfter = existsSync(projectSettings)
  ? `${Math.round(statSync(projectSettings).mtimeMs)}/${statSync(projectSettings).size}`
  : '(没有)';
console.log(
  `   <工作目录>/.claude/settings.json：${settingsBefore} → ${settingsAfter}${
    settingsBefore === settingsAfter ? '（它自己没改）' : '（**被它改了**）'
  }`,
);
console.log(`   （这个脚本自己：${resolve(here)}）`);
