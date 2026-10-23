/**
 * D4c 验收测试：建分支失败时，回报里带上 git 自己说的那句话。
 *
 * 逐条对应委派单与 Codex 审查意见：
 * 1. 错误输出有前导空行、首尾空白、多行内容：
 *    - 取第一条非空行，去掉首尾空白，完整追加在 `why` 后面（格式 `建分支失败：${why}：${firstNonEmpty}`）；
 *    - 后面跟的行不被接上（证明不是取最后一行）；
 * 2. 超长截断：第一条非空行超过 200 字时正好截断到 200 字；
 * 3. 没有错误输出：完整结果保持原样（`建分支失败：${why}`，不追加冒号）；
 * 4. 失败改走改动包、无残留临时工作树与分支（D4 条件 8 收尾）。
 *
 * 不改 D4 的锁定测试（`packages/core/test/acceptance/d4-apply-branch.test.ts`）；自建最小 harness。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const dirs: string[] = [];
let db: CoreDatabase | null = null;
const savedGit: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedGit[key] = process.env[key];
    const empty = join(mkdtempSync(join(tmpdir(), 'ixa-d4c-gitcfg-')), 'empty');
    writeFileSync(empty, '');
    dirs.push(join(empty, '..'));
    process.env[key] = empty;
  }
});

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const key of Object.keys(savedGit)) {
    if (savedGit[key] === undefined) delete process.env[key];
    else process.env[key] = savedGit[key];
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录留给系统清 */
    }
  }
});

const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commitAll = (repo: string, message: string): void => {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', message]);
};
const worktreeCount = (root: string): number =>
  git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

interface World {
  dataDir: string;
  root: string;
  runWithHook(
    hookContent: string,
    hookName?: 'post-checkout' | 'pre-commit',
  ): Promise<{ taskId: string; error: string; rawWhy: string }>;
}

function makeWorld(): World {
  const dataDir = tempDir('ixa-d4c-data-');
  const root = tempDir('ixa-d4c-root-');
  git(root, ['init', '-b', 'main']);
  writeFileSync(join(root, 'note.txt'), '第一版');
  commitAll(root, '初始');

  db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const project = new ProjectService(db).create({
    name: '合成项目',
    rootPath: root,
    description: null,
  });
  new PermissionService(db).grantFolder(root);
  const files: Record<string, string> = {};
  const coding = new CodingOrchestrator(
    db,
    new FakeCodingExecutor({ claimedSuccess: true, files }),
    dataDir,
  );

  return {
    dataDir,
    root,
    async runWithHook(hookContent, hookName = 'pre-commit') {
      const hooks = join(root, 'hooks');
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, hookName);
      writeFileSync(hook, hookContent);
      chmodSync(hook, 0o755);
      git(root, ['config', 'core.hooksPath', hooks]);

      const task = coding.create({
        projectId: project.id,
        goal: '把说明写清楚',
        scope: ['note.txt'],
        allowedCommands: [],
      });
      files['note.txt'] = '提交被拒';
      await coding.approveAndQueue(task.id);
      await coding.dispatch(task.id);
      await coding.accept(task.id);

      const row = db!
        .prepare('SELECT applied_ref, apply_error FROM coding_tasks WHERE id = ?')
        .get(task.id) as { applied_ref: string | null; apply_error: string | null };
      expect(row.applied_ref).not.toBeNull();
      expect(resolve(row.applied_ref!)).toBe(resolve(join(dataDir, 'patches', task.id)));
      // 从错误中剥出 why（冒号前一段）以供对照
      const raw = row.apply_error ?? '';
      return { taskId: task.id, error: raw };
    },
  };
}

describe('D4c 验收条件：建分支失败带上 git 的原话', () => {
  it('前导空行、首尾空白、多行内容：取第一条非空行（去首尾空白），完整接在 why 后面，后面各行不接', async () => {
    const w = makeWorld();
    // 钩子依次打：前导空行、首尾带空格的第一条非空行、第二条非空行、结尾空行
    const hook = [
      '#!/bin/sh',
      'echo "" >&2',
      'echo "   " >&2',
      'echo "   D4C_FIRST_NON_EMPTY_LINE   " >&2',
      'echo "D4C_SECOND_LINE_SHOULD_BE_IGNORED" >&2',
      'echo "" >&2',
      'exit 1',
      '',
    ].join('\n');
    const { taskId, error } = await w.runWithHook(hook);

    // 格式断言：开头是「建分支失败：」，包含 node 的 Command failed，末尾正好接上 `：D4C_FIRST_NON_EMPTY_LINE`
    expect(error.startsWith('建分支失败：Command failed: git ')).toBe(true);
    expect(error.endsWith('：D4C_FIRST_NON_EMPTY_LINE')).toBe(true);

    // 验证：去掉了首尾空白
    expect(error).not.toContain('   D4C_FIRST_NON_EMPTY_LINE');
    // 验证：后面多行的内容没有被接上（证明取的确实是第一条、不是最后一条）
    expect(error).not.toContain('D4C_SECOND_LINE_SHOULD_BE_IGNORED');

    // D4 条件 8 的收尾照旧
    expect(worktreeCount(w.root)).toBe(1);
    expect(git(w.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
    expect(readFileSync(join(w.dataDir, 'patches', taskId, 'note.txt'), 'utf8')).toBe('提交被拒');
  });

  it('超长原话：正好截断到 200 字，完整接在 why 后面', async () => {
    const w = makeWorld();
    const longText = 'ABCDEFGHIJ'.repeat(25); // 250 字
    const hook = `#!/bin/sh\necho "${longText}" >&2\nexit 1\n`;
    const { error } = await w.runWithHook(hook);

    const first200 = longText.slice(0, 200);
    expect(error.startsWith('建分支失败：Command failed: git ')).toBe(true);
    expect(error.endsWith(`：${first200}`)).toBe(true);
    // 验证没有带出第 201 个字起的内容
    expect(error).not.toContain(longText.slice(0, 201));
  });

  it('没有错误输出：完整结果保持原样（建分支失败：${why}，不追加冒号）', async () => {
    const w = makeWorld();
    // 钩子完全不打 stderr，静默退出 1
    const hook = '#!/bin/sh\nexit 1\n';
    const { error } = await w.runWithHook(hook);

    expect(error.startsWith('建分支失败：Command failed: git ')).toBe(true);
    // 格式必须完全是 `建分支失败：Command failed: git …`，末尾不能带冒号
    expect(error.endsWith('：')).toBe(false);
    // 整句在 `建分支失败：` 之后只包含 Command failed 这一段，没有中文冒号「：」追加在最后
    const afterPrefix = error.replace(/^建分支失败：/, '');
    expect(afterPrefix.split('；且')[0]!.endsWith('：')).toBe(false);
  });
});
