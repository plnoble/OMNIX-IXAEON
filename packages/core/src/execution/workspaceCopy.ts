import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { spawnSync } from 'node:child_process';

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
]);

const FORBIDDEN_NAME =
  /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*\.cookie)$/i;

export interface WorkspaceSnapshot {
  snapshotRef: string;
  fileCount: number;
  skipped: string[];
  contentHash: string;
  gitHead: string | null;
}

/**
 * 把现有项目复制到隔离工作区：跳过依赖目录和密钥文件，记录内容哈希。
 * 不 stash / reset；未提交改动原样复制。空目录不能冒充快照。
 */
export function copyProjectWorkspace(root: string, dest: string): WorkspaceSnapshot {
  if (!existsSync(root)) {
    throw new IxaError(ErrorCodes.NOT_FOUND, `项目目录不存在，不能冒充快照：${root}`);
  }
  mkdirSync(dest, { recursive: true });
  const skipped: string[] = [];
  const hashes: string[] = [];
  let fileCount = 0;

  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push(relative(root, dir).replaceAll('\\', '/') || '.');
      return;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).replaceAll('\\', '/');
      if (ent.isDirectory()) {
        if (FORBIDDEN_DIRS.has(ent.name)) {
          skipped.push(rel);
          continue;
        }
        walk(abs);
        continue;
      }
      if (FORBIDDEN_NAME.test(ent.name)) {
        skipped.push(rel);
        continue;
      }
      try {
        const st = statSync(abs);
        if (!st.isFile()) {
          skipped.push(rel);
          continue;
        }
        const buf = readFileSync(abs);
        const h = createHash('sha256').update(buf).digest('hex');
        hashes.push(`${rel}:${h}:${st.size}`);
        const target = join(dest, rel);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(abs, target);
        fileCount += 1;
      } catch {
        skipped.push(rel);
      }
    }
  };
  walk(root);
  hashes.sort();
  const contentHash = createHash('sha256').update(hashes.join('\n')).digest('hex');
  const gitHead = readGitHead(root);
  if (fileCount === 0 && skipped.length === 0) {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, `项目目录为空，不能冒充快照：${root}`);
  }
  const snapshotRef = [
    'copy',
    root,
    `sha256:${contentHash}`,
    `files:${fileCount}`,
    gitHead ? `git:${gitHead}` : 'git:none',
  ].join('|');
  return { snapshotRef, fileCount, skipped, contentHash, gitHead };
}

function readGitHead(root: string): string | null {
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    const head = (r.stdout ?? '').trim();
    return /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}
