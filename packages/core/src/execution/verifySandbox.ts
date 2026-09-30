/**
 * D2 依赖档沙箱的核心层（规格 D2「改正与补充」第 4 条）：
 * - checkSandboxAuth：被动授权检查——只读文件与服务状态，不写数据目录、不弹窗；
 *   env 只给测试替换平台与 Codex 路径。
 * - requestSandboxAuth：发起授权——会弹一次 UAC（无人值守路径绝不调用，测试不调用）。
 * - ensureSandboxProfileConfig：写 <数据目录>/codex-sandbox-home/config.toml（校验时
 *   也只被派生路径在跑之前调用；checkSandboxAuth 不写）。
 *
 * 检查口径照 scripts/real/d2b-e3-auth-check.mjs 真机验证的结论：
 * cap_sid（workspace/readonly/workspace_by_cwd 三类 SID）+ 版本配对的
 * command-runner helper + setup 标记 + 常驻服务 RUNNING，缺一即 unauthorized。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SandboxAuthError = 'unsupported_platform' | 'codex_missing' | 'unauthorized';
export type SandboxAuthResult = { ok: true } | { ok: false; reason: SandboxAuthError };

/** 检查环境替身（测试用）：platform 替换运行时平台；codexExe 替换 Codex 路径（null = 没有）。 */
export interface SandboxAuthEnv {
  platform?: NodeJS.Platform;
  codexExe?: string | null;
}

export const SANDBOX_PROFILE = 'ixaeon';
export const SANDBOX_HOME_SUBDIR = 'codex-sandbox-home';

export function sandboxHomeDir(dataDir: string): string {
  return join(dataDir, SANDBOX_HOME_SUBDIR);
}

/** 找机器上装了没的 Codex CLI（与 executor.resolveCodexLocator 同一套位置）。 */
export function locateCodexExecutable(): string | null {
  const base = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(base, 'codex.exe'));
    try {
      for (const d of readdirSync(base)) {
        if (d === 'codex.exe') continue;
        candidates.push(join(base, d, 'codex.exe'));
      }
    } catch {
      // 没有安装目录就只查根
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

function codexVersion(codexExe: string): string | null {
  try {
    const r = spawnSync(codexExe, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    const m = /(\d+\.\d+\.\d+[^ ]*)/.exec(String(r.stdout ?? ''));
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

export async function checkSandboxAuth(
  dataDir: string,
  env?: SandboxAuthEnv,
): Promise<SandboxAuthResult> {
  const platform = env?.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, reason: 'unsupported_platform' };
  let codexExe: string | null;
  if (env?.codexExe === undefined) codexExe = locateCodexExecutable();
  else codexExe = env.codexExe;
  if (!codexExe || !existsSync(codexExe)) return { ok: false, reason: 'codex_missing' };

  // 授权状态：全被动读取，绝不写数据目录、绝不提权（无人值守约束）。
  const home = sandboxHomeDir(dataDir);
  try {
    const capPath = join(home, 'cap_sid');
    if (!existsSync(capPath)) return { ok: false, reason: 'unauthorized' };
    const cap = JSON.parse(readFileSync(capPath, 'utf8')) as unknown;
    const keys = Object.keys(cap as object);
    const byCwd = (cap as { workspace_by_cwd?: unknown }).workspace_by_cwd;
    if (
      !keys.includes('workspace') ||
      !keys.includes('readonly') ||
      typeof byCwd !== 'object' ||
      byCwd === null ||
      Object.keys(byCwd as object).length === 0
    ) {
      return { ok: false, reason: 'unauthorized' };
    }
    const version = codexVersion(codexExe);
    const helper = join(home, '.sandbox-bin', `codex-command-runner-${version ?? 'unknown'}.exe`);
    if (!version || !existsSync(helper)) return { ok: false, reason: 'unauthorized' };
    if (!existsSync(join(home, '.sandbox', 'setup_marker.json'))) {
      return { ok: false, reason: 'unauthorized' };
    }
    const svc = spawnSync('sc', ['query', 'CodexSandboxService.OpenAI.Codex'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (svc.status !== 0 || !/RUNNING/.test(svc.stdout ?? '')) {
      return { ok: false, reason: 'unauthorized' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unauthorized' };
  }
}

/**
 * 发起授权：跑一次提权沙箱的空命令，让 Windows 弹一次 UAC，成功后
 * <HOME>/cap_sid 与 helper 才落位。只该由用户主动点击的入口调用。
 */
export async function requestSandboxAuth(dataDir: string): Promise<SandboxAuthResult> {
  const codexExe = locateCodexExecutable();
  if (!codexExe) return { ok: false, reason: 'codex_missing' };
  const home = sandboxHomeDir(dataDir);
  // 复审整改 2：-C 与 write 条目绝不用系统临时目录——提权 setup 会给写入根
  // 加访问权限并永久保留；用数据目录里专用的空目录。
  const probeDir = join(home, 'auth-probe');
  mkdirSync(probeDir, { recursive: true });
  ensureSandboxProfileConfig(home, probeDir, []);
  const r = spawnSync(
    codexExe,
    [
      'sandbox',
      'windows',
      '--permissions-profile',
      SANDBOX_PROFILE,
      '-c',
      'windows.sandbox="elevated"',
      '-C',
      probeDir,
      '--',
      'cmd',
      '/c',
      'echo ixaeon-sandbox-auth-ok',
    ],
    {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      // 复审整改 2：派生环境走白名单，不传整份 process.env
      env: { ...whitelistedEnv(), CODEX_HOME: home },
    },
  );
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0 || !out.includes('ixaeon-sandbox-auth-ok')) {
    return { ok: false, reason: 'unauthorized' };
  }
  return { ok: true };
}

/** 派生环境白名单（与 executor.minimalChildEnv 同一张清单，本模块不能反向依赖 executor）。 */
function whitelistedEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'ComSpec',
    'COMSPEC',
    'ProgramFiles',
    'ProgramW6432',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env;
}

const slash = (p: string) => p.replaceAll('\\', '/').replace(/\/$/, '');
const tomlQuote = (p: string) => `"${slash(p)}/**"`;

/**
 * 生成/覆盖专用 CODEX_HOME 的 config.toml：网络关闭、副本子树可写、
 * 真实依赖目录只读、inherit=all。每次派生前重写——write 条目只含当前副本
 * （换副本自然跟着换）。
 */
export function ensureSandboxProfileConfig(
  home: string,
  copyDir: string,
  readonlyDirs: string[],
): void {
  mkdirSync(home, { recursive: true });
  const lines = [
    `[permissions.${SANDBOX_PROFILE}]`,
    `[permissions.${SANDBOX_PROFILE}.workspace_roots]`,
    `${tomlQuote(copyDir).replace('/**', '')} = true`,
    `[permissions.${SANDBOX_PROFILE}.filesystem]`,
    `${tomlQuote(copyDir)} = "write"`,
    ...readonlyDirs.map((d) => `${tomlQuote(d)} = "read"`),
    `[permissions.${SANDBOX_PROFILE}.network]`,
    'enabled = false',
    '[shell_environment_policy]',
    'inherit = "all"',
    '',
    '[permissions.default_permissions]',
    `extends = "${SANDBOX_PROFILE}"`,
    '',
  ];
  writeFileSync(join(home, 'config.toml'), lines.join('\n'), 'utf8');
}
