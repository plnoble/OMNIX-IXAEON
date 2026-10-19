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
 *
 * V4（2026-10-19）：找 Codex 并成一套，取本机最新版（契约 3.1）；检查和授权里的子进程
 * 全改异步（契约 3.2，跑在 Electron 主进程里，不能卡住窗口）。
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
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
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
 * 版本号到第一个空白为止——末尾的换行不能算进去（原来的 `[^ ]*` 会把它吃进去，
 * 拼出的 helper 文件名永远不存在）。
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

export async function checkSandboxAuth(
  dataDir: string,
  env?: SandboxAuthEnv,
): Promise<SandboxAuthResult> {
  const platform = env?.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, reason: 'unsupported_platform' };
  // 找 Codex：测试接缝（env.codexExe）传了就用它；没传就用 V4 的统一找法。
  let codexExe: string;
  let version: string | null;
  if (env?.codexExe !== undefined) {
    if (!env.codexExe || !existsSync(env.codexExe)) return { ok: false, reason: 'codex_missing' };
    codexExe = env.codexExe;
    version = await codexVersionAsync(codexExe);
  } else {
    const found = await findLatestCodex();
    if (!found) return { ok: false, reason: 'codex_missing' };
    codexExe = found.exe;
    version = found.version;
  }

  // 授权状态：全被动读取，绝不写数据目录、绝不提权（无人值守约束）。
  const home = sandboxHomeDir(dataDir);
  try {
    const capPath = join(home, 'cap_sid');
    if (!existsSync(capPath)) {
      return { ok: false, reason: 'unauthorized' };
    }
    const cap = JSON.parse(readFileSync(capPath, 'utf8')) as unknown;
    const keys = Object.keys(cap as object);
    const byCwd = (cap as { workspace_by_cwd?: unknown }).workspace_by_cwd;
    if (
      !keys.includes('workspace') ||
      !keys.includes('readonly') ||
      typeof byCwd !== 'object' ||
      byCwd === null
    ) {
      return { ok: false, reason: 'unauthorized' };
    }
    // 版本配对的 helper 是授权时由提权 setup 生成的（D2b）。Codex 升级之后新版本的
    // helper 还不在：不能确定派生时会不会再要提权，照实判没授权——宁可让用户再点一次
    // 授权，也不能在无人值守时弹窗（整合方 2026-10-01 复审时改回严格配对）。
    // V4：问不出版本号 = 它在，只是配不上授权（指定了的那个）；没指定时这种候选
    // 压根不会被 findLatestCodex 选中（见上面）。
    if (!version) return { ok: false, reason: 'unauthorized' };
    const helper = join(home, '.sandbox-bin', `codex-command-runner-${version}.exe`);
    if (!existsSync(helper)) return { ok: false, reason: 'unauthorized' };
    if (!existsSync(join(home, '.sandbox', 'setup_marker.json'))) {
      return { ok: false, reason: 'unauthorized' };
    }
    let running = false;
    try {
      const svc = await execFileAsync('sc', ['query', 'CodexSandboxService.OpenAI.Codex'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      running = /RUNNING/.test(String(svc.stdout ?? ''));
    } catch {
      running = false;
    }
    if (!running) return { ok: false, reason: 'unauthorized' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unauthorized' };
  }
}

/**
 * 发起授权：跑一次提权沙箱的空命令，让 Windows 弹一次 UAC，成功后
 * <HOME>/cap_sid 与 helper 才落位。只该由用户主动点击的入口调用。
 * V4（契约 3.2）：要等用户点完确认框（最长 120 秒），用异步子进程，不能卡住窗口。
 */
export async function requestSandboxAuth(dataDir: string): Promise<SandboxAuthResult> {
  const found = await findLatestCodex();
  if (!found) return { ok: false, reason: 'codex_missing' };
  const codexExe = found.exe;
  const home = sandboxHomeDir(dataDir);
  // 复审整改 2：-C 与 write 条目绝不用系统临时目录——提权 setup 会给写入根
  // 加访问权限并永久保留；用数据目录里专用的空目录。
  const probeDir = join(home, 'auth-probe');
  mkdirSync(probeDir, { recursive: true });
  ensureSandboxProfileConfig(home, probeDir, []);
  try {
    const r = await execFileAsync(
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
    if (!out.includes('ixaeon-sandbox-auth-ok')) return { ok: false, reason: 'unauthorized' };
    return { ok: true };
  } catch {
    // 退出码非 0、超时、取消确认：都算没授权成
    return { ok: false, reason: 'unauthorized' };
  }
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
