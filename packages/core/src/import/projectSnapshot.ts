import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ParsedSource, ParsedSegment } from './parsers.js';
import { sha256 } from '../vault.js';

/** 项目目录读取的单文件大小上限（超过则跳过，除非用户单独确认）。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ROOT_DOC_RE = /^(README[^/\\]*|AGENTS\.md|CLAUDE\.md)$/i;
const ROOT_MD_TXT_RE = /^[^/\\]+\.(md|txt)$/i;
const MANIFEST_FILES = new Set([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'requirements.txt',
  'setup.py',
  'composer.json',
  'Gemfile',
  'gradle.properties',
  'settings.gradle',
  'CMakeLists.txt',
  'Makefile',
]);

/** 永不读取的文件名模式（密钥、Cookie、令牌等）。 */
const FORBIDDEN_NAME_RE =
  /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*\.cookie|.*cookie.*\.json|.*token.*|.*secret.*|.*credential.*)$/i;

/** 永不遍历的目录名。 */
const FORBIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.idea',
  '.vs',
  'bin',
  'obj',
]);

export interface SnapshotResult {
  source: ParsedSource;
  skipped: Array<{ path: string; reason: string }>;
}

function listDocsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      if (FORBIDDEN_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'docs') walk(full, depth + 1);
      } else if (ROOT_MD_TXT_RE.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(join(root, 'docs'), 0);
  return out;
}

function listRootFiles(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(
      (name) => ROOT_DOC_RE.test(name) || MANIFEST_FILES.has(name) || ROOT_MD_TXT_RE.test(name),
    );
}

function gitSummary(root: string): { branch: string | null; log: string | null } {
  const branchResult = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const logResult = spawnSync(
    'git',
    ['-C', root, 'log', '-n', '200', '--pretty=format:%h|%ad|%s', '--date=short'],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  const log = logResult.status === 0 ? logResult.stdout.trim() : null;
  return { branch, log };
}

/**
 * 项目目录登记读取（第一版只读说明与配置类文件，不扫描全部源码）：
 * - 根目录 README、AGENTS.md、其余 .md / .txt；
 * - docs 目录下所有 .md；
 * - 项目清单（package.json 等）；
 * - 若存在 Git，读取最近 200 条提交摘要与当前分支名。
 * 所有内容汇总为一个 project_snapshot 来源，每个文件一个 document 片段。
 */
export function readProjectSnapshot(rootPath: string): SnapshotResult {
  const root = rootPath;
  const skipped: Array<{ path: string; reason: string }> = [];
  const files: string[] = [];

  for (const name of listRootFiles(root)) {
    files.push(join(root, name));
  }
  files.push(...listDocsFiles(root));

  const accepted: string[] = [];
  for (const f of files) {
    if (FORBIDDEN_NAME_RE.test(f.split(/[\\/]/).pop() ?? '')) {
      skipped.push({ path: f, reason: '敏感文件名（密钥/Cookie/令牌类）' });
      continue;
    }
    try {
      const st = statSync(f);
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ path: f, reason: `超过 10MB（${st.size} 字节）` });
        continue;
      }
      accepted.push(f);
    } catch {
      skipped.push({ path: f, reason: '无法读取' });
    }
  }

  const segments: ParsedSegment[] = [];
  const fileHashes: string[] = [];
  let seq = 0;
  for (const f of accepted.sort()) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim();
    } catch {
      skipped.push({ path: f, reason: '读取失败' });
      continue;
    }
    if (text.length === 0) continue;
    fileHashes.push(sha256(text));
    segments.push({
      sequence: seq++,
      role: 'document',
      externalNodeId: null,
      externalParentId: null,
      isActiveBranch: true,
      occurredAt: null,
      text,
      metadata: { file: relative(root, f), chars: text.length },
    });
  }

  const { branch, log } = gitSummary(root);
  const meta: Record<string, unknown> = {
    root,
    fileCount: accepted.length,
    branch,
  };
  if (log && log.length > 0) {
    meta.gitLogChars = log.length;
    segments.push({
      sequence: seq++,
      role: 'document',
      externalNodeId: null,
      externalParentId: null,
      isActiveBranch: true,
      occurredAt: null,
      text: `# Git 提交历史（最近 200 条，分支 ${branch ?? '未知'}）\n${log}`,
      metadata: { file: '<git-log>', branch, count: 200 },
    });
    fileHashes.push(sha256(log));
  }

  if (segments.length === 0) {
    skipped.push({ path: root, reason: '没有可读取的说明或配置文件' });
  }

  return {
    source: {
      kind: 'project_snapshot',
      provider: 'project',
      externalId: root,
      title: `项目快照：${root.split(/[\\/]/).pop() ?? root}`,
      contentHash: sha256(fileHashes.join('\n') || 'empty'),
      capturedAt: new Date().toISOString(),
      segments,
      metadata: meta,
    },
    skipped,
  };
}
