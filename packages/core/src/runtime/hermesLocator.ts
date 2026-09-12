import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface HermesLocator {
  found: boolean;
  exe: string | null;
  /** 仓库根（tui_gateway 所在），stdio 网关的 cwd 与 PYTHONPATH */
  cwd: string | null;
  /** 专属 HERMES_HOME；仅当显式配置时非空 */
  home: string | null;
  reason: string;
}

/**
 * 本机 Hermes 探测。不安装、不拉 latest、不扫描用户个人 ~/.hermes。
 * 只认 IXAEON 专属路径：IXAEON_HERMES_EXE（venv python）或 IXAEON_HERMES_HOME（专属目录）。
 * 兼容候选：官方安装器写入用户级 HERMES_HOME（同样必须指向专属目录布局，
 * 且不等于用户个人 ~/.hermes 默认位置，才认）。
 *
 * 已对照锁定安装（官方安装器 -Tag v2026.9.11 -HermesHome <专属目录>）核实布局：
 *   代码 <home>\hermes-agent（git 检出到标签），网关入口 = <repo>\venv\Scripts\python.exe
 *   （posix 为 venv/bin/python），stdio 启动 `python -u -m tui_gateway.entry`。
 * bin\hermes.exe 是 CLI 垫片，不能当 stdio 网关用。
 */
export function locateHermes(): HermesLocator {
  const fromEnv = process.env.IXAEON_HERMES_EXE?.trim();
  // 候选优先级：IXAEON_HERMES_HOME（IXAEON 显式）> HERMES_HOME（安装器用户级，
  // 需确属专属安装布局且非个人默认目录）。
  const installerHome = process.env.HERMES_HOME?.trim() || null;
  const personalDefault = join(process.env.USERPROFILE ?? '', '.hermes');
  const installerHomeValid =
    installerHome &&
    !equalsPath(installerHome, personalDefault) &&
    existsSync(join(installerHome, 'hermes-agent'))
      ? installerHome
      : null;
  const home = process.env.IXAEON_HERMES_HOME?.trim() || installerHomeValid || null;
  const homeReason = process.env.IXAEON_HERMES_HOME?.trim()
    ? 'IXAEON_HERMES_HOME（venv python + tui_gateway.entry）'
    : 'HERMES_HOME（官方安装器用户级变量，专属目录布局）';
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      return {
        found: false,
        exe: fromEnv,
        cwd: null,
        home,
        reason: `IXAEON_HERMES_EXE 指向的文件不存在：${fromEnv}`,
      };
    }
    const homeRepo = home ? join(home, 'hermes-agent') : null;
    const cwd = homeRepo && existsSync(homeRepo) ? homeRepo : repoRootFromVenvPython(fromEnv);
    return { found: true, exe: fromEnv, cwd, home, reason: 'IXAEON_HERMES_EXE' };
  }
  if (home) {
    const repo = join(home, 'hermes-agent');
    const candidates = [
      join(repo, 'venv', 'Scripts', 'python.exe'),
      join(repo, 'venv', 'bin', 'python'),
    ];
    for (const exe of candidates) {
      if (existsSync(exe)) {
        return {
          found: true,
          exe,
          cwd: existsSync(repo) ? repo : null,
          home,
          reason: homeReason,
        };
      }
    }
    return {
      found: false,
      exe: null,
      cwd: null,
      home,
      reason: `HERMES_HOME 下未找到网关 venv python（${repo}\\venv\\...）：${home}`,
    };
  }
  return {
    found: false,
    exe: null,
    cwd: null,
    home: null,
    reason:
      '未配置 IXAEON_HERMES_EXE / IXAEON_HERMES_HOME / HERMES_HOME。不扫描用户个人 ~/.hermes；安装需用户批准官方安装器并装入专属目录。',
  };
}

/** 大小写不敏感的路径比较（Windows）。 */
function equalsPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 网关子进程环境：HERMES_HOME + PYTHONPATH（仓库根）+ 不缓冲输出。 */
export function hermesSpawnEnv(locator: HermesLocator): Record<string, string> {
  const env: Record<string, string> = {};
  if (locator.home) env.HERMES_HOME = locator.home;
  if (locator.cwd) {
    env.PYTHONPATH =
      locator.cwd + (process.env.PYTHONPATH ? pathDelimiter() + process.env.PYTHONPATH : '');
  }
  env.PYTHONUNBUFFERED = '1';
  return env;
}

function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

/** <repo>\venv\Scripts\python.exe → <repo>；<repo>/venv/bin/python → <repo>。 */
function repoRootFromVenvPython(exe: string): string | null {
  const normalized = exe.replaceAll('/', '\\');
  if (/[\\/]venv[\\/]Scripts[\\/]python(\.exe)?$/i.test(normalized)) {
    return dirname(dirname(dirname(exe)));
  }
  if (/[\\/]venv[\\/]bin[\\/]python3?$/.test(normalized)) {
    return dirname(dirname(dirname(exe)));
  }
  return null;
}
