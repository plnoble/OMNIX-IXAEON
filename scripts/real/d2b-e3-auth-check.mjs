#!/usr/bin/env node
/**
 * D2b 实验 3：授权状态免弹窗检查（回答「怎么在首启/运行前知道沙箱授权是否到位」）。
 *
 * 检查项（全部是被动读取，不触发 UAC、不提权、不调模型、不跑 codex exec）：
 *   N1 <CODEX_HOME>/cap_sid 存在且是 JSON，键含 workspace / readonly /
 *      workspace_by_cwd 三类 SID（只输出键与条目数，不输出 SID 内容）；
 *   N2 <CODEX_HOME>/.sandbox-bin/codex-command-runner-<当前版本>.exe 存在；
 *   N3 <CODEX_HOME>/.sandbox/setup_marker.json 存在；
 *   N4 Windows 服务 CodexSandboxService.OpenAI.Codex 处于 RUNNING。
 *
 * 全部满足 → 退出 0（无人值守 elevated 可用，最后一次真机为连续 10/10）；
 * 任一不满足 → 退出 1，并指出缺哪项（首次授权引导据此提示用户点一次 UAC）。
 * codex.exe 缺失 → 退出 2（环境问题，与授权无关）。
 *
 * 用法：node scripts/real/d2b-e3-auth-check.mjs [CODEX_HOME]
 *       默认取环境变量 CODEX_HOME，其次按本实验默认 <tmp>/ixaeon-d2b-home。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CODEX = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const HOME = process.argv[2] || process.env.CODEX_HOME || join(tmpdir(), 'ixaeon-d2b-home');
const out = [];
const log = (l) => {
  out.push(l);
  console.log(l);
};

const reads = { pass: 0, items: [] };
function check(name, ok, detail = '') {
  reads.items.push({ name, ok, detail });
  if (ok) reads.pass += 1;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`);
}

log(`检查目标：CODEX_HOME=${HOME}`);
log(`[cap_sid] 存在：${existsSync(join(HOME, 'cap_sid'))}`);

if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  log('');
  log('说明：只做被动检查，不弹 UAC。见文件头注释。');
  process.exit(0);
}

if (!existsSync(CODEX)) {
  log(`FAIL  codex.exe 不存在：${CODEX}`);
  process.exit(2);
}

// N1 cap_sid 结构与内容（只统计，不打印 SID）
{
  const capPath = join(HOME, 'cap_sid');
  if (!existsSync(capPath)) {
    check('N1 cap_sid 存在', false);
  } else {
    try {
      const cap = JSON.parse(readFileSync(capPath, 'utf8'));
      const keys = Object.keys(cap);
      const byCwd =
        typeof cap.workspace_by_cwd === 'object' && cap.workspace_by_cwd
          ? Object.keys(cap.workspace_by_cwd).length
          : 0;
      const ok = keys.includes('workspace') && keys.includes('readonly') && byCwd > 0;
      check('N1 cap_sid 有效', ok, `键=${keys.length}，workspace_by_cwd 目录=${byCwd}`);
    } catch (e) {
      check('N1 cap_sid 有效', false, `解析失败 ${e.message}`);
    }
  }
}

// N2 helper 与当前 codex 版本配对
{
  const verOut = spawnSync(CODEX, ['--version'], {
    encoding: 'utf8',
    timeout: 20_000,
  }).stdout.trim();
  const m = /(\d+\.\d+\.\d+[^ ]*)/.exec(verOut);
  const version = m ? m[1] : 'unknown';
  const helper = join(HOME, '.sandbox-bin', `codex-command-runner-${version}.exe`);
  check('N2 版本配对 helper 存在', existsSync(helper), `版本=${version}`);
}

// N3 setup 标记
check('N3 setup_marker.json 存在', existsSync(join(HOME, '.sandbox', 'setup_marker.json')));

// N4 沙箱服务在跑
{
  const r = spawnSync('sc', ['query', 'CodexSandboxService.OpenAI.Codex'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  check('N4 沙箱服务 RUNNING', r.status === 0 && /RUNNING/.test(r.stdout ?? ''));
}

const result = reads.pass === reads.items.length;
log('');
log(
  `结论：${result ? '授权到位（无人值守 elevated 可用）' : `缺 ${reads.items.filter((i) => !i.ok).length} 项，需首次授权（UAC 一次）`}`,
);
process.exit(result ? 0 : 1);
