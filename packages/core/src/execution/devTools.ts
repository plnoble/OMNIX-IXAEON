/**
 * MP3c 规格第 1 条：找三个开发工具装在哪（只看文件在不在，不运行它们）。
 * 顺序固定 codex、claude、dsh；手填优先。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type DevTool = 'codex' | 'claude' | 'dsh';

export interface DevToolRow {
  tool: DevTool;
  found: boolean;
  path: string | null;
  source: 'manual' | 'auto' | null;
  note: string | null;
}

export interface DetectDevToolsInput {
  manual: { codex?: string; claude?: string; dsh?: string };
  env: NodeJS.ProcessEnv;
  /** 只探文件在不在；测试传假的存在函数。 */
  exists?: (p: string) => boolean;
}

const NOT_FOUND = '没找到，可以手填位置';

function codexCandidates(env: NodeJS.ProcessEnv): { path: string; note?: string }[] {
  const out: { path: string; note?: string }[] = [];
  const fromEnv = env['IXAEON_CODEX_EXE']?.trim();
  if (fromEnv === 'none') return [{ path: '', note: '已设成不用 Codex' }];
  if (fromEnv) out.push({ path: fromEnv });
  const local = env['LOCALAPPDATA'];
  if (local) out.push({ path: join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe') });
  return out;
}

function claudeCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const fromEnv = env['IXAEON_CLAUDE_EXE']?.trim();
  if (fromEnv) out.push(fromEnv);
  const home = env['USERPROFILE'];
  if (home) out.push(join(home, '.local', 'bin', 'claude.exe'));
  const appData = env['APPDATA'];
  if (appData)
    out.push(
      join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    );
  return out;
}

function dshCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const fromEnv = env['IXAEON_DSH_INSTALL']?.trim();
  if (fromEnv) out.push(fromEnv);
  out.push(join('D:', 'Agent', 'DeepSeek Harness', 'Install'));
  const local = env['LOCALAPPDATA'];
  if (local) out.push(join(local, 'Programs', 'DeepSeek Harness'));
  return out;
}

/** 只探文件在不在；不运行。 */
export function detectDevTools(input: DetectDevToolsInput): DevToolRow[] {
  const exists = input.exists ?? existsSync;
  const norm = (p: string): string => p.replaceAll('\\', '/');

  const manualRow = (tool: DevTool, manualPath: string | undefined): DevToolRow | null => {
    if (!manualPath) return null;
    if (exists(manualPath))
      return { tool, found: true, path: manualPath, source: 'manual', note: null };
    return {
      tool,
      found: false,
      path: null,
      source: null,
      note: '手填的位置没有这个程序',
    };
  };

  const codexManual = manualRow('codex', input.manual.codex);
  let codex: DevToolRow;
  if (codexManual) codex = codexManual;
  else {
    const cands = codexCandidates(input.env);
    const noneNote = cands.find((c) => c.note)?.note;
    const hit = cands.find((c) => c.path && exists(c.path));
    codex = hit?.path
      ? { tool: 'codex', found: true, path: hit.path, source: 'auto', note: null }
      : { tool: 'codex', found: false, path: null, source: null, note: noneNote ?? NOT_FOUND };
  }

  const claudeManual = manualRow('claude', input.manual.claude);
  let claude: DevToolRow;
  if (claudeManual) claude = claudeManual;
  else {
    const hit = claudeCandidates(input.env).find((p) => exists(p));
    claude = hit
      ? { tool: 'claude', found: true, path: hit, source: 'auto', note: null }
      : { tool: 'claude', found: false, path: null, source: null, note: NOT_FOUND };
  }

  const dshManual = manualRow('dsh', input.manual.dsh);
  let dsh: DevToolRow;
  if (dshManual) dsh = dshManual;
  else {
    const install = dshCandidates(input.env).find(
      (dir) =>
        exists(join(dir, 'DeepSeek Harness.exe')) && exists(join(dir, 'resources', 'app.asar')),
    );
    dsh = install
      ? { tool: 'dsh', found: true, path: install, source: 'auto', note: null }
      : { tool: 'dsh', found: false, path: null, source: null, note: NOT_FOUND };
  }

  // norm 只用于保证路径比较一致（\ 与 / 不分）；这里不改变返回值
  void norm;
  return [codex, claude, dsh];
}
