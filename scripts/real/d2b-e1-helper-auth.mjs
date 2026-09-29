#!/usr/bin/env node
/**
 * D2b 实验 1：专用 CODEX_HOME + 复制 helper 是否免 UAC、连续 10 次无人值守。
 *
 * 发现（写入报告）：elevated 沙箱依赖 per-CODEX_HOME 的 helper
 *（<CODEX_HOME>/.sandbox-bin/codex-command-runner-<版本>.exe，与当前
 * codex 版本配对）；系统服务 CodexSandboxService.OpenAI.Codex 常驻运行但
 * 不等于 helper 就绪。用户真实 HOME 已装当前版本 helper（历史 UAC 已在）。
 *
 * 本实验：专用临时 CODEX_HOME（模拟产品数据目录）——
 * A) 不带 helper 直接 elevated → 预期 1223（授权缺失标志）；
 * B) 把用户 HOME 里同版本 helper 复制到专用 HOME 的 .sandbox-bin/ →
 *    elevated 是否免 UAC 直接可用；可用则连续 10 次无人值守全部成功。
 * C) 顺带验证：授权是否跟 HOME 走——换第二个新 HOME（不带 helper）再次 1223。
 *
 * 不跑 codex exec、不调模型；只用合成仓库与 echo/node 探针。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CODEX = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const USER_CODEX_HOME = join(process.env.USERPROFILE ?? '', '.codex');
const root = mkdtempSync(join(tmpdir(), 'ixaeon-d2b-e1-'));
const log = (...a) => console.log(...a);

const exeVersion = spawnSync(CODEX, ['--version'], {
  encoding: 'utf8',
  timeout: 20_000,
}).stdout.trim();
log(`codex 版本：${exeVersion}`);
const m = /(\d+\.\d+\.\d+[^ ]*)/.exec(exeVersion);
const version = m ? m[1] : 'unknown';
log(`解析版本：${version}`);

const sourceHelper = join(USER_CODEX_HOME, '.sandbox-bin', `codex-command-runner-${version}.exe`);
log(`用户 HOME 同版本 helper 存在：${existsSync(sourceHelper)}（${sourceHelper}）`);
if (!existsSync(sourceHelper)) {
  log('本机没有与当前 codex 版本配对的 helper，如实停下。');
  process.exit(2);
}

function runIteration(home, profile, iter, tag) {
  const cfg = join(home, 'config.toml');
  mkdirSync(home, { recursive: true });
  // 权限范围只圈本次实验自己的临时目录（上一次是用户 Temp/** 全写，过宽且含本机路径）
  const rootFs = root.replaceAll('\\', '/');
  const tmpFs = tmpdir().replaceAll('\\', '/');
  const toml = [
    '[permissions.d2b]',
    '[permissions.d2b.filesystem]',
    `"${rootFs}/**" = "write"`,
    `"${tmpFs}/**" = "read"`,
    '[permissions.d2b.network]',
    'enabled = false',
    '',
    '[permissions.default_permissions]',
    'extends = "d2b"',
    '',
  ].join('\n');
  spawnSync(
    'node',
    ['-e', `require('fs').writeFileSync(process.argv[1], process.argv[2])`, cfg, toml],
    {
      encoding: 'utf8',
    },
  );
  const r = spawnSync(
    CODEX,
    [
      'sandbox',
      'windows',
      '--permissions-profile',
      profile,
      '-c',
      'windows.sandbox="elevated"',
      '-C',
      tmpdir(),
      '--',
      'cmd',
      '/c',
      `echo D2B_${tag}_${iter}_OK`,
    ],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CODEX_HOME: home } },
  );
  const ok = r.status === 0 && r.stdout.includes('D2B');
  return {
    ok,
    status: r.status,
    tail: (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | '),
  };
}

// A) 空 HOME（无 helper）
const homeA = join(root, 'home-a');
log('\n— A) 专用 HOME 无 helper，elevated 一次 —');
{
  const r = runIteration(homeA, 'd2b', 1, 'A');
  log(`A: ok=${r.ok} status=${r.status} 尾部=${r.tail}`);
}

// B) 复制 helper 到专用 HOME → 连续 10 次
const homeB = join(root, 'home-b');
mkdirSync(join(homeB, '.sandbox-bin'), { recursive: true });
cpSync(sourceHelper, join(homeB, '.sandbox-bin', `codex-command-runner-${version}.exe`));
log('\n— B) 专用 HOME 复制 helper 后，连续 10 次 —');
{
  const results = [];
  for (let i = 1; i <= 10; i += 1) {
    const r = runIteration(homeB, 'd2b', i, 'B');
    results.push(r.ok);
    log(`B-${i}: ok=${r.ok} status=${r.status}${r.ok ? '' : ' 尾部=' + r.tail}`);
  }
  log(`B 汇总：${results.filter(Boolean).length}/10 成功`);
}

// C) 换新 HOME 不带 helper → 再验授权跟 HOME
const homeC = join(root, 'home-c');
log('\n— C) 新 HOME 无 helper（对照授权跟着 HOME 走）—');
{
  const r = runIteration(homeC, 'd2b', 1, 'C');
  log(`C: ok=${r.ok} status=${r.status} 尾部=${r.tail}`);
}

try {
  rmSync(root, { recursive: true, force: true });
  log('\n[cleanup] 已删除 ' + root);
} catch (e) {
  log('[cleanup] 失败：' + e.message);
}
