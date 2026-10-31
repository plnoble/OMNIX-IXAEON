/**
 * DG1：接力的 DSH 网关跟桌面版走。
 *
 * 每一棒起 DSH 之前，从桌面版的补丁（`~/.dsh/profiles/desktop/cordis.patch.yml`，
 * `DSH_HOME` 有值时用 `<DSH_HOME>/profiles/desktop/cordis.patch.yml`）里**只取顶层
 * `- id: llm-pi-ai` 那一项**（到下一个顶层 `- id:` 之前），原样写进一个一次性临时补丁；
 * 参数里它排在接力自己的补丁前面（网关在前、权限与默认模型在后）。
 *
 * 不整份叠桌面版：10-31 实测，整份叠会把桌面版的 MCP 服务（比如 chrome-devtools）带进每一棒。
 * 临时文件放系统临时目录、文件名随机；内容里有网关地址和 `apiKeyEnv`，所以不打印、不记录，
 * 用完由调用方 `removeGatewayPatch` 删掉（棒结束，含崩溃、超时）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 桌面版补丁在 DSH 家目录里的位置（`DSH_HOME` 是那个家目录）。 */
const DESKTOP_PROFILE = ['profiles', 'desktop', 'cordis.patch.yml'] as const;

/** 桌面版配置不存在、或者里面没有网关段时打的那一行（规格条件 3）。 */
export const GATEWAY_NOT_FOUND_LINE = '没找到 DSH 桌面版的网关配置，接力用自己补丁里的';

/** 桌面版补丁的路径：`DSH_HOME` 有值用它，否则用本机用户目录下的 `~/.dsh`。 */
export function desktopGatewayConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dshHome = env.DSH_HOME?.trim();
  return dshHome ? join(dshHome, ...DESKTOP_PROFILE) : join(home, '.dsh', ...DESKTOP_PROFILE);
}

/**
 * 取出顶层 `- id: llm-pi-ai` 那一项，逐字（含它后面到下一个顶层 `- id:` 之前的换行）。
 * 没有这一项就回 `null`。
 */
export function extractDesktopGateway(text: string): string | null {
  // 有些 Windows 编辑器会留 BOM；它不属于这一项的内容。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const start = /^- id:[ \t]*['"]?llm-pi-ai['"]?[ \t]*\r?$/m.exec(body);
  if (!start) return null;
  const from = start.index;
  const rest = body.slice(from + start[0].length);
  // 只认顶层的 `- id:`：缩进的（比如模型列表里的）不算下一项。
  const next = /^- id:/m.exec(rest);
  return body.slice(from, next ? from + start[0].length + next.index : body.length);
}

/** 一条准备好的临时网关补丁：文件路径，以及插好 `--patch <它>` 的参数。 */
export interface GatewayPatch {
  file: string;
  argv: string[];
}

/** 这一棒起的是不是接力里的 DSH 启动器（`packages/relay/bin/dsh.mjs`）。 */
export function isDshLauncher(argv: readonly string[]): boolean {
  return argv.slice(0, 3).some((a) => /(^|[\\/])dsh\.mjs$/i.test(a));
}

/**
 * 有网关段就写成临时补丁，并把它插到参数里：紧跟在 `headless` 后面、接力补丁前面
 * （原本有 `--patch` 就插在第一个 `--patch` 之前；没有就插在 `--profile headless` 后面）。
 * 桌面版配置不存在、没有网关段、或者参数里找不到该插的位置 → 回 `null`。
 */
export function prepareGatewayPatch(
  argv: string[],
  configPath: string = desktopGatewayConfigPath(),
): GatewayPatch | null {
  if (!existsSync(configPath)) return null;
  let item: string | null = null;
  try {
    item = extractDesktopGateway(readFileSync(configPath, 'utf8'));
  } catch {
    item = null;
  }
  if (!item) return null;
  const firstPatch = argv.indexOf('--patch');
  const headless = argv.findIndex((a, i) => a === 'headless' && argv[i - 1] === '--profile');
  const insertAt = firstPatch >= 0 ? firstPatch : headless >= 0 ? headless + 1 : -1;
  if (insertAt < 0) return null;
  const file = join(tmpdir(), `ixa-dg1-${randomBytes(8).toString('hex')}.yml`);
  try {
    writeFileSync(file, item, 'utf8');
  } catch {
    return null;
  }
  return {
    file,
    argv: [...argv.slice(0, insertAt), '--patch', file, ...argv.slice(insertAt)],
  };
}

/** 删掉临时网关补丁；删不掉也不让这一棒失败（文件在系统临时目录，下次开机也会被清）。 */
export function removeGatewayPatch(file: string): void {
  try {
    rmSync(file, { force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 临时文件删不掉不算这一棒失败 */
  }
}
