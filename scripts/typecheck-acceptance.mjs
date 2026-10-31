#!/usr/bin/env node
/**
 * Q3（2026-10-29）：验收测试也要过类型检查。
 *
 * tsconfig.json 把 `packages/*\/test/acceptance/**`、`apps/*\/test/acceptance/**` 整个排除了，
 * vitest 又只转写、不查类型，于是门禁里的 `typecheck` 从来不碰验收测试——2026-10-27 查出 main 上 49 条类型错误，
 * 其中有「实参个数不符」这类会让断言白写的。
 *
 * 查哪些：git 跟踪着的验收测试文件，**除了**锁定清单里还在排队（status 不是 done）的任务的文件——
 * 排队的任务实现还没并入，它的测试引用的新模块还不存在，必然报错；`acceptance.mjs done` 之后自动纳入。
 * 没登记进锁定清单的验收文件（辅助文件、分支上新写的测试）照样要过。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'docs', '委派', '锁定验收.json'), 'utf8'));
const queued = new Set(
  (lock.tasks ?? []).filter((t) => t.status !== 'done').flatMap((t) => Object.keys(t.files ?? {})),
);

const tracked = execFileSync(
  'git',
  [
    '-c',
    'core.quotepath=false',
    'ls-files',
    '-z',
    'packages/*/test/acceptance/*',
    'apps/*/test/acceptance/*',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter((f) => /\.(ts|tsx)$/.test(f));

const files = tracked.filter((f) => !queued.has(f));
const skipped = tracked.length - files.length;
if (files.length === 0) {
  console.log('✓ 没有要查的验收测试文件');
  process.exit(0);
}

const outDir = join(root, '.logs');
mkdirSync(outDir, { recursive: true });
const config = join(outDir, 'tsconfig.acceptance.generated.json');
writeFileSync(
  config,
  `${JSON.stringify(
    {
      extends: join(root, 'tsconfig.json').replace(/\\/g, '/'),
      include: [],
      files: files.map((f) => join(root, f).replace(/\\/g, '/')),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`查 ${files.length} 个验收测试文件（排队中任务的 ${skipped} 个不查，done 之后纳入）`);
const r = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', config],
  { cwd: root, stdio: 'inherit' },
);
process.exit(r.status ?? 1);
