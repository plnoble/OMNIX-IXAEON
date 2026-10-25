/**
 * D2/V4 依赖档沙箱的核心层（规格 V4「新版沙箱」，契约 3）：
 * - checkSandboxAuth：被动授权检查——只读授权记录与 setup 标记、问一次 `codex --version`，
 *   不写数据目录、不弹窗、不跑 `codex sandbox`（没装过时它会自己拉起提权安装）；env 只给测试替换平台与 Codex 路径。
 * - requestSandboxAuth：发起授权——`sandbox setup --elevated` 装一次，再在 auth-probe 里试跑；
 *   会弹一次 UAC（无人值守路径绝不调用，测试不调用）。成了写授权记录。
 * - ensureSandboxProfileConfig：写专用 CODEX_HOME 的 config.toml（新版 0.163 的配方，
 *   `":root" = "read"` + `[windows] sandbox = "elevated"`；每次派生前重写）。
 * - findLatestCodex / findLatestCodexSync：找 Codex 只有一套办法，取本机最新版（契约 3.1）。
 *
 * 检查口径（V4 换掉旧的四样）：授权记录在、里面的版本和现在找到的 Codex 完全一样、
 * `.sandbox/setup_marker.json` 在 → ok；Codex 升级之后新版认不认原来那次安装没验过，
 * 宁可让用户再点一次，也不能在无人值守派生时弹窗。
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type SandboxAuthError = 'unsupported_platform' | 'codex_missing' | 'unauthorized';
export type SandboxAuthResult = { ok: true } | { ok: false; reason: SandboxAuthError };

/** 检查环境替身（测试用）：platform 替换运行时平台；codexExe 替换 Codex 路径（null = 没有）。 */
export interface SandboxAuthEnv {
  platform?: NodeJS.Platform;
  codexExe?: string | null;
}

/** V4：找到的 Codex 命令行。`version` 只有在「用 IXAEON_CODEX_EXE 指定了、又问不出版本号」时是 null。 */
export interface CodexFound {
  exe: string;
  version: string | null;
}

export const SANDBOX_PROFILE = 'ixaeon';
export const SANDBOX_HOME_SUBDIR = 'codex-sandbox-home';
/** 授权记录：requestSandboxAuth 成功后写，checkSandboxAuth 读。 */
export const SANDBOX_AUTH_RECORD = 'ixaeon-sandbox-auth.json';

export function sandboxHomeDir(dataDir: string): string {
  return join(dataDir, SANDBOX_HOME_SUBDIR);
}

/**
 * V4 契约 3.1：找 Codex 只有一套办法，取最新版。
 * - `IXAEON_CODEX_EXE` 设了：就用它，别的候选一个都不问；设成 `none`：没有 Codex。
 * - 没设：`<LOCALAPPDATA>\OpenAI\Codex\bin\codex.exe` 和 `bin` 下每个子目录里的
 *   `codex.exe` 都是候选；每个问一遍 `--version`，取版本号最大的，问不出来的不算。
 */
function codexCandidates(): { candidates: string[]; pinned: boolean } {
  const override = process.env.IXAEON_CODEX_EXE?.trim();
  if (override === 'none') return { candidates: [], pinned: false };
  if (override) return { candidates: [override], pinned: true };
  const local = process.env.LOCALAPPDATA;
  if (!local) return { candidates: [], pinned: false };
  const base = join(local, 'OpenAI', 'Codex', 'bin');
  const candidates: string[] = [];
  const top = join(base, 'codex.exe');
  if (existsSync(top)) candidates.push(top);
  try {
    for (const d of readdirSync(base)) {
      if (d === 'codex.exe') continue;
      const p = join(base, d, 'codex.exe');
      if (existsSync(p)) candidates.push(p);
    }
  } catch {
    // 没有安装目录就只查根
  }
  return { candidates, pinned: false };
}

/** 版本号按「主.次.补」逐段比数字（`0.11` 比 `0.9` 大，不按字符串比）。 */
function versionRank(version: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]!), Number(m[2]!), Number(m[3]!)] : [-1, -1, -1];
}

function isNewer(a: string, b: string): boolean {
  const left = versionRank(a);
  const right = versionRank(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return false;
}

function newestOf(found: CodexFound[]): CodexFound | null {
  let best: CodexFound | null = null;
  for (const c of found) {
    if (c.version !== null && (best === null || isNewer(c.version, best.version!))) best = c;
  }
  return best;
}

/**
 * `codex --version` 的输出 → 版本号：「codex-cli 0.130.0-alpha.5\n」→「0.130.0-alpha.5」。
 * 版本号到第一个空白为止——末尾的换行不能算进去。
 */
export function parseCodexVersion(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+\S*)/.exec(stdout);
  return m ? (m[1] ?? null) : null;
}

/** 同步问版本：只给「应用启动时找一次」的执行器路径用（不许出现在检查与授权里）。 */
function codexVersionSync(codexExe: string): string | null {
  try {
    const r = spawnSync(codexExe, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    return parseCodexVersion(String(r.stdout ?? ''));
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

/** 异步问版本：检查和授权里只许用这个（V4 契约 3.2，不能用同步子进程卡住窗口）。 */
async function codexVersionAsync(codexExe: string): Promise<string | null> {
  try {
    const r = await execFileAsync(codexExe, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    return parseCodexVersion(String(r.stdout ?? ''));
  } catch (err) {
    // 退出码非 0 时 stdout 里也可能有版本号（照真的 Node 的错误对象形状取）
    const out = (err as { stdout?: unknown }).stdout;
    return out ? parseCodexVersion(String(out)) : null;
  }
}

/**
 * 同步版找 Codex（`resolveCodexLocator` 用）：执行器在应用启动时找一次，之后记着结果。
 * 用户 2026-10-19 定：和沙箱那边一样，取本机最新版。
 */
export function findLatestCodexSync(): CodexFound | null {
  const { candidates, pinned } = codexCandidates();
  if (pinned) {
    const exe = candidates[0];
    if (!exe || !existsSync(exe)) return null;
    return { exe, version: codexVersionSync(exe) };
  }
  const found: CodexFound[] = [];
  for (const exe of candidates) {
    const version = codexVersionSync(exe);
    if (version !== null) found.push({ exe, version });
  }
  return newestOf(found);
}

/**
 * 异步版找 Codex（V4 契约 3.1）：沙箱这边每次查授权之前重新找，Codex 升级了要看得出来；
 * 问版本用异步子进程。
 */
export async function findLatestCodex(): Promise<CodexFound | null> {
  const { candidates, pinned } = codexCandidates();
  if (pinned) {
    const exe = candidates[0];
    if (!exe || !existsSync(exe)) return null;
    return { exe, version: await codexVersionAsync(exe) };
  }
  const found: CodexFound[] = [];
  for (const exe of candidates) {
    const version = await codexVersionAsync(exe);
    if (version !== null) found.push({ exe, version });
  }
  return newestOf(found);
}

/** 检查用的 Codex 与版本：接缝给了就用接缝的，没给走统一找法。 */
async function codexForCheck(
  env?: SandboxAuthEnv,
): Promise<{ exe: string; version: string | null } | { reason: SandboxAuthError }> {
  if (env?.codexExe !== undefined) {
    if (!env.codexExe || !existsSync(env.codexExe)) return { reason: 'codex_missing' };
    return { exe: env.codexExe, version: await codexVersionAsync(env.codexExe) };
  }
  const found = await findLatestCodex();
  if (!found) return { reason: 'codex_missing' };
  return found;
}

export async function checkSandboxAuth(
  dataDir: string,
  env?: SandboxAuthEnv,
): Promise<SandboxAuthResult> {
  const platform = env?.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, reason: 'unsupported_platform' };
  const found = await codexForCheck(env);
  if ('reason' in found) return { ok: false, reason: found.reason };
  if (found.version === null) return { ok: false, reason: 'unauthorized' };

  // 授权状态：全被动读取，绝不写数据目录、绝不提权（无人值守约束）。
  const home = sandboxHomeDir(dataDir);
  try {
    const recordPath = join(home, SANDBOX_AUTH_RECORD);
    if (!existsSync(recordPath)) return { ok: false, reason: 'unauthorized' };
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { codexVersion?: unknown };
    if (
      typeof record.codexVersion !== 'string' ||
      record.codexVersion !== found.version
    ) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!existsSync(join(home, '.sandbox', 'setup_marker.json'))) {
      return { ok: false, reason: 'unauthorized' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unauthorized' };
  }
}

/**
 * 发起授权（V4 契约 3.5，只该由设置页的按钮调）：
 * 1. 找 Codex——没有 / 不是 Windows / 问不出版本号：直接回，一个装的子进程都不起；
 * 2. 建 `<专用 HOME>/auth-probe`（不用系统临时目录），按新版配方写 config.toml；
 * 3. `sandbox setup --elevated --current-user --codex-home <专用 HOME>`（Windows 弹一次管理员确认）；
 * 4. 在 auth-probe 里试跑一条 echo，输出要有标记；
 * 5. 两步都成 → 写授权记录 `{"codexVersion":"<版本>"}`，返回 `{ ok: true }`。
 * 全程异步（要等用户点完确认框，不能卡住窗口）。
 */
export async function requestSandboxAuth(
  dataDir: string,
  env?: SandboxAuthEnv,
): Promise<SandboxAuthResult> {
  const platform = env?.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, reason: 'unsupported_platform' };
  const found = await codexForCheck(env);
  if ('reason' in found) return { ok: false, reason: found.reason };
  if (found.version === null) return { ok: false, reason: 'unauthorized' };
  const codexExe = found.exe;
  const home = sandboxHomeDir(dataDir);
  // -C 与 write 条目绝不用系统临时目录——提权 setup 会给写入根加访问权限并永久保留；
  // 用数据目录里专用的空目录（D2 复审定的）。
  const probeDir = join(home, 'auth-probe');
  mkdirSync(probeDir, { recursive: true });
  ensureSandboxProfileConfig(home, probeDir, []);
  const sandboxEnv = { ...whitelistedEnv(), CODEX_HOME: home };
  try {
    await execFileAsync(
      codexExe,
      ['sandbox', 'setup', '--elevated', '--current-user', '--codex-home', home],
      { encoding: 'utf8', timeout: 120_000, windowsHide: true, env: sandboxEnv },
    );
  } catch {
    // 退出码非 0、超时、确认被取消：到此为止，不写记录
    return { ok: false, reason: 'unauthorized' };
  }
  try {
    const r = await execFileAsync(
      codexExe,
      [
        '-c',
        'windows.sandbox="elevated"',
        'sandbox',
        '--permission-profile',
        SANDBOX_PROFILE,
        '-C',
        probeDir,
        '--',
        'cmd',
        '/c',
        'echo ixaeon-sandbox-auth-ok',
      ],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: sandboxEnv },
    );
    const out = `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`;
    if (!out.includes('ixaeon-sandbox-auth-ok')) return { ok: false, reason: 'unauthorized' };
  } catch {
    return { ok: false, reason: 'unauthorized' };
  }
  writeFileSync(
    join(home, SANDBOX_AUTH_RECORD),
    `${JSON.stringify({ codexVersion: found.version })}\n`,
    'utf8',
  );
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
 * 生成/覆盖专用 CODEX_HOME 的 config.toml（V4 契约 3.3，新版 0.163 的配方）：
 * `":root" = "read"`（提权沙箱要求能读整个盘）、副本子树可写、真实依赖目录只读、
 * 网络关闭、inherit=all、`[windows] sandbox = "elevated"`；不再写 default_permissions
 * （调用时 `--permission-profile` 已经点名）。每次派生前重写——write 条目只含当前副本。
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
    '":root" = "read"',
    `${tomlQuote(copyDir)} = "write"`,
    ...readonlyDirs.map((d) => `${tomlQuote(d)} = "read"`),
    `[permissions.${SANDBOX_PROFILE}.network]`,
    'enabled = false',
    '[shell_environment_policy]',
    'inherit = "all"',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ];
  writeFileSync(join(home, 'config.toml'), lines.join('\n'), 'utf8');
}