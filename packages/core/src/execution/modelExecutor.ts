import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCodes, IxaError, type CodingTask } from '@ixaeon/contracts';
import type { ModelProvider } from '../extraction/model/provider.js';
import type { CodingExecutor, ExecutorReport } from './executor.js';

/** 单文件发给模型的内容上限（字符）。 */
const MAX_FILE_CHARS = 64 * 1024;
/** 发给模型的文件内容总量上限（字符）。 */
const MAX_TOTAL_CHARS = 120_000;
/** 文件清单最多多少条。 */
const MAX_LIST_ITEMS = 400;
/** 模型单次返回最多接受的改动处数。 */
const MAX_CHANGES = 20;
/** 单处改动的内容上限（字符）。 */
const MAX_CHANGE_CHARS = 200_000;
/** raw（原始返回）截短上限。 */
const MAX_RAW_CHARS = 8000;

/** 密钥类文件名（与 copyProjectWorkspace 的 FORBIDDEN_NAME 同一套），万一出现在副本里不发给模型。 */
const SECRET_NAME = /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*\.cookie)$/i;

const changeSchema = z.object({
  path: z.string(),
  action: z.enum(['write', 'delete']),
  content: z.string().nullable().optional(),
});

const answerSchema = z.object({
  changes: z.array(changeSchema),
  summary: z.string(),
  claimedSuccess: z.boolean(),
});

const SYSTEM_PROMPT = [
  '你是编码执行器。只能按下面的格式返回 JSON：',
  '{"changes":[{"path":"相对路径","action":"write","content":"整份新内容"}],"summary":"一句话说明","claimedSuccess":true}',
  '删除用 "action":"delete"（不需要 content）。',
  '只能改动批准范围里的文件。只整份改写「已经发给你完整内容」的文件，或者新建文件；内容没发全的文件不要动。',
  '不要编造没给过的文件内容。做不到就把 claimedSuccess 设为 false 并在 summary 里说明原因。',
].join('\n');

interface PlannedChange {
  path: string;
  action: 'write' | 'delete';
  content: string | null;
}

interface WorkspaceFile {
  rel: string;
  abs: string;
  size: number;
  text: string | null; // 文本内容（二进制/密钥不发内容为 null）
  fullySent: boolean;
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/');
}

/** 任务批准范围（同 taskStore.assertChangedPathsInScope 的规范化）。 */
function scopeEntries(task: CodingTask): string[] {
  const norm = (p: string): string => {
    let n = p.replaceAll('\\', '/');
    while (n.startsWith('./')) n = n.slice(2);
    while (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
    const segs = n
      .split('/')
      .filter((s) => s.length > 0 && s !== '.')
      .join('/');
    if (segs === '' || segs === '.') return '.';
    return n === '/.' ? '.' : segs;
  };
  return (JSON.parse(task.scope_json) as string[]).map(norm);
}

function inScope(rel: string, scope: string[]): boolean {
  const n = normalizePath(rel);
  return scope.some((s) => s === '.' || n === s || n.startsWith(`${s}/`));
}

const isBinary = (buf: Buffer): boolean => buf.includes(0);

/** 副本里收集文本候选（不进链接）。 */
function collectFiles(workspace: string): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue; // 链接不进清单、不发内容
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = normalizePath(relative(workspace, abs));
      if (SECRET_NAME.test(name)) continue; // 密钥类文件连清单都不进
      let text: string | null = null;
      let size = 0;
      try {
        const buf = readFileSync(abs);
        size = buf.length;
        if (!isBinary(buf)) text = buf.toString('utf8');
      } catch {
        text = null;
      }
      out.push({ rel, abs, size, text, fullySent: text !== null && text.length <= MAX_FILE_CHARS });
    }
  };
  walk(workspace);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 发内容的顺序：批准范围内的文件 → README → 目标里点了相对路径的文件。 */
function sendableOrder(files: WorkspaceFile[], task: CodingTask): WorkspaceFile[] {
  const scope = scopeEntries(task);
  const mentioned = new Set(task.goal.match(/[a-zA-Z0-9_\-./]+/g)?.map(normalizePath) ?? []);
  const rank = (f: WorkspaceFile): number => {
    if (inScope(f.rel, scope)) return 0;
    if (f.rel === 'README.md' || f.rel.toUpperCase() === 'README.MD') return 1;
    if (mentioned.has(f.rel) || mentioned.has(f.rel.replace(/^\.\//, ''))) return 2;
    return 3;
  };
  return files
    .filter((f) => f.text !== null && rank(f) <= 2)
    .sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
}

function buildPrompt(workspace: string, task: CodingTask): string {
  const files = collectFiles(workspace);
  const scopeText = (JSON.parse(task.scope_json) as string[]).join(', ');
  const ordered = sendableOrder(files, task);
  const sent = new Set<string>();
  let used = 0;
  const blocks: string[] = [];
  for (const f of ordered) {
    if (sent.has(f.rel)) continue;
    if (used + f.text!.length > MAX_TOTAL_CHARS) continue;
    const body = f.text!.slice(0, MAX_FILE_CHARS);
    used += body.length;
    sent.add(f.rel);
    blocks.push(`--- ${f.rel} ---\n${body}`);
  }
  const listing = files
    .slice(0, MAX_LIST_ITEMS)
    .map((f) => `${f.rel}（${f.size} 字节${f.text === null ? '，内容不发' : ''}）`)
    .join('\n');
  return [
    `任务目标：\n${task.goal}`,
    `可修改范围：${scopeText}`,
    `文件清单（最多 ${MAX_LIST_ITEMS} 条）：\n${listing}`,
    ...(blocks.length > 0
      ? [`已发给你的文件内容（${sent.size} 个文件，共 ${used} 字符）：\n${blocks.join('\n\n')}`]
      : ['（没有文件内容发给模型）']),
  ].join('\n\n');
}

/** 路径上任何一段（含最后一段）是链接 → false。 */
function linkFreePath(workspace: string, rel: string): boolean {
  const segs = normalizePath(rel)
    .split('/')
    .filter((s) => s.length > 0);
  let cur = resolve(workspace);
  for (const seg of segs) {
    const next = join(cur, seg);
    if (existsSync(next) && lstatSync(next).isSymbolicLink()) return false;
    cur = next;
  }
  return true;
}

/**
 * D7：用「我的模型」当编码执行器。只对隔离副本读写，不起子进程、不自己联网；
 * 除了一次模型请求，所有校验在本地，一处不合格整批不写。
 */
export class ModelCodingExecutor implements CodingExecutor {
  readonly name: string;

  constructor(
    private readonly provider: ModelProvider,
    modelName: string,
  ) {
    this.name = `model:${modelName}`;
  }

  async run(task: CodingTask, workspace: string, signal: AbortSignal): Promise<ExecutorReport> {
    if (signal.aborted) {
      return {
        claimedSuccess: false,
        summary: '开工前已取消，没有把文件发给模型',
        changedPaths: [],
        testsModified: false,
        raw: '',
      };
    }
    let answer: z.infer<typeof answerSchema>;
    try {
      if (task.timeout_ms <= 0) {
        throw new IxaError(ErrorCodes.JOB_CANCELLED, `模型请求超时（${task.timeout_ms} ms）`);
      }
      answer = await Promise.race([
        this.provider.chatStructured({
          system: SYSTEM_PROMPT,
          user: buildPrompt(workspace, task),
          schema: answerSchema,
        }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => {
            reject(new IxaError(ErrorCodes.JOB_CANCELLED, `模型请求超时（${task.timeout_ms} ms）`));
          }, task.timeout_ms);
          t.unref?.();
        }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/超时/.test(msg)) throw new IxaError(ErrorCodes.JOB_CANCELLED, msg);
      if (/未通过 schema|safeParse|invalid_type|format/i.test(msg)) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, `模型没按格式返回：${msg}`);
      }
      throw new IxaError(ErrorCodes.MODEL_CALL_FAILED, `模型请求失败：${msg}`);
    }

    if (signal.aborted) {
      return {
        claimedSuccess: false,
        summary: '等模型回答时已取消，模型给的改动没有写',
        changedPaths: [],
        testsModified: false,
        raw: '',
      };
    }

    // 格式核验在前（chatStructured 已按 schema 校验；这里兜底防御）
    if (!Array.isArray(answer.changes)) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '模型没按格式返回：changes 不是数组');
    }
    if (answer.changes.length > MAX_CHANGES) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `模型一次给了 ${answer.changes.length} 处改动（最多 ${MAX_CHANGES} 处）`,
      );
    }

    const files = collectFiles(workspace);
    const planned: PlannedChange[] = [];
    const plan = (raw: z.infer<typeof changeSchema>): void => {
      const rel = normalizePath(raw.path);
      if (rel.length === 0) throw new IxaError(ErrorCodes.PATH_ESCAPE, '改动路径为空');
      if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/'))
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `改动路径不合法（绝对路径）：${raw.path}`);
      if (rel.split('/').some((s) => s === '..'))
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `改动路径不合法（含 ..）：${raw.path}`);
      if (!linkFreePath(workspace, rel))
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `改动路径上有链接：${rel}`);
      const scope = scopeEntries(task);
      if (!inScope(rel, scope))
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `改动超出批准范围：${rel}`);
      const abs = join(workspace, rel);
      const existing = files.find((f) => f.rel === rel);
      if (raw.action === 'delete') {
        if (!existing) throw new IxaError(ErrorCodes.PATH_ESCAPE, `要删除的文件不存在：${rel}`);
        planned.push({ path: rel, action: 'delete', content: null });
        return;
      }
      const content = raw.content;
      if (content === undefined || content === null)
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, `改动没带内容：${rel}`);
      if (content.length > MAX_CHANGE_CHARS)
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, `单处改动超过内容上限：${rel}`);
      if (existsSync(abs) && !lstatSync(abs).isFile())
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `写到目录上：${rel}`);
      if (existing) {
        if (!existing.fullySent)
          throw new IxaError(
            ErrorCodes.PATH_ESCAPE,
            `要覆盖的内容没完整发给模型（不许盲改）：${rel}`,
          );
      }
      planned.push({ path: rel, action: 'write', content });
    };
    for (const raw of answer.changes) plan(raw);

    if (!answer.claimedSuccess) {
      return {
        claimedSuccess: false,
        summary: answer.summary,
        changedPaths: [],
        testsModified: false,
        raw: JSON.stringify(answer).slice(0, MAX_RAW_CHARS),
      };
    }

    for (const c of planned) {
      const abs = join(workspace, c.path);
      if (c.action === 'delete') {
        if (existsSync(abs) && !lstatSync(abs).isDirectory()) rmSync(abs);
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.content ?? '', 'utf8');
    }

    const changedPaths = planned.map((c) => c.path);
    return {
      claimedSuccess: true,
      summary: answer.summary,
      changedPaths,
      testsModified: changedPaths.some((p) => /test/i.test(p)),
      raw: JSON.stringify(answer).slice(0, MAX_RAW_CHARS),
    };
  }
}
