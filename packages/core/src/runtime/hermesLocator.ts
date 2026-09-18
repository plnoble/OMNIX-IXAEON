import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HERMES_BRIDGE_TOKEN_ENV } from '@ixaeon/contracts';

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

/**
 * IXAEON 会话里 Hermes 能用的工具集（用户 2026-09-17 决定：记忆 + 联网搜索）。
 *
 * 必须在启动时钉：TUI gateway 协议没有 tool.respond，Hermes 自己执行自己的
 * 工具；Core 的 allowedTools 只决定 Core 是否代为执行，拦不住 Hermes 原生工具。
 * 不钉时 tui 会话用 hermes-cli 全套（19 个工具集，含 terminal / file /
 * code_execution / computer_use）。2026-09-17 真机记录里，模型因此执行了
 * search_files、列出 Hermes 目录下 51 个文件，而账本记的是「已拦截」。
 *
 * 取 web,ixaeon 的理由（均以 Hermes v2026.9.11 的 _load_enabled_toolsets 实测）：
 * - web（web_search / web_extract）是内置工具集，永远有效，充当锚；
 * - ixaeon 是 mcp_servers 里的记忆桥，未配置或 enabled:false 时被忽略；
 * - 只钉 ixaeon 不行：桥关闭时条目全部无效，Hermes 会退回全套 19 个工具集。
 * 刻意不含 memory：那是 Hermes 自己的记忆库，写进去就绕开了 IXAEON Core。
 */
export const HERMES_TUI_TOOLSETS = 'web,ixaeon';

/**
 * 网关子进程环境：HERMES_HOME + PYTHONPATH（仓库根）+ 不缓冲输出 + 工具集钉定
 * + 聊天模型。
 *
 * chatModel 经 HERMES_MODEL / HERMES_INFERENCE_MODEL 传入：Hermes 的
 * _env_model_seed() 优先于 config.yaml 的 model:，且这个启动种子按其设计不会被
 * 同步回配置文件（server.py 注释写明「避免被当成 /model 切换而全局持久化」）。
 * 所以 IXAEON 决定聊天用哪个模型，不改用户的 Hermes 配置。空值 = 不干预。
 */
export function hermesSpawnEnv(
  locator: HermesLocator,
  opts: { chatModel?: string | null; bridgeToken?: string | null } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  if (locator.home) env.HERMES_HOME = locator.home;
  if (locator.cwd) {
    env.PYTHONPATH =
      locator.cwd + (process.env.PYTHONPATH ? pathDelimiter() + process.env.PYTHONPATH : '');
  }
  env.PYTHONUNBUFFERED = '1';
  // 放在返回值里而不是依赖外部环境：spawn 时本值覆盖继承来的同名变量。
  env.HERMES_TUI_TOOLSETS = HERMES_TUI_TOOLSETS;
  const chatModel = opts.chatModel?.trim();
  if (chatModel) {
    env.HERMES_MODEL = chatModel;
    env.HERMES_INFERENCE_MODEL = chatModel;
  }
  // 记忆桥（F1）：只在开着时传。Hermes 配置里的 ${IXAEON_HERMES_BRIDGE_TOKEN} 由它展开，
  // 关着时占位符原样保留，MCP 服务拿着一串占位符去连桌面端，必然被拒。
  const bridgeToken = opts.bridgeToken?.trim();
  if (bridgeToken) env[HERMES_BRIDGE_TOKEN_ENV] = bridgeToken;
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
