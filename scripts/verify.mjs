#!/usr/bin/env node
/**
 * IXAEON 一键验证：lint → format:check → typecheck → test:unit → test:integration → build。
 * 直接调用各工具 CLI（不经嵌套 pnpm，避免外层 pnpm shim 干扰）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const node = process.execPath;

function run(label, args, env = {}) {
  const started = Date.now();
  process.stdout.write(`\n\u001b[36m▶ ${label}\u001b[0m\n`);
  const result = spawnSync(node, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stdout.write(`\u001b[31m✗ ${label} 失败（${seconds}s）\u001b[0m\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`\u001b[32m✓ ${label} 通过（${seconds}s）\u001b[0m\n`);
  return { label, seconds };
}

const results = [];

results.push(
  run('lint（ESLint）', [resolve(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), '.']),
);

results.push(
  run('format:check（Prettier）', [
    resolve(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
    '--check',
    'apps/*/src/**/*.{ts,tsx,css,html}',
    'packages/*/src/**/*.{ts,tsx}',
    'scripts/**/*.mjs',
    'apps/*/scripts/**/*.mjs',
    '*.{ts,mjs,json}',
  ]),
);

results.push(
  run('typecheck（tsc --noEmit）', [
    resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
    '-p',
    'tsconfig.json',
  ]),
);

results.push(
  run('unit（Vitest 单元测试）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--project',
    'unit',
  ]),
);

results.push(
  run('integration（Vitest 集成测试）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--project',
    'integration',
  ]),
);

results.push(run('build（desktop / mcp / extension）', [resolve(root, 'scripts', 'build.mjs')]));

results.push(
  run('review（二次验收独立业务测试 11 项，修复 R1-R9 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.config.ts',
  ]),
);

results.push(
  run('review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.round3.config.ts',
  ]),
);

results.push(
  run('review-round4（四次验收连续性 7 项，修复 F1-F4 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.round4.config.ts',
  ]),
);

results.push(
  run('review-v02（v0.2 验收 15 项，修复 G1-G8 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.v02-review.config.ts',
  ]),
);

results.push(
  run('review-project-audit（全项目审核 15 项，修复 C01-C13 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.project-audit.config.ts',
  ]),
);

results.push(
  run('review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.recheck-20260907.config.ts',
  ]),
);

results.push(
  run('review-recheck-round2（二次复审 10 项，修复 F01-F03 回归）', [
    resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'apps/desktop/test/review/vitest.recheck-round2-20260907.config.ts',
  ]),
);

// RF09：UI01 / BUI01 / BUI02 真实 Electron 界面检查纳入默认验证入口。
// 依赖 build 产物 out/main/index.js（上面 build 步骤已生成）。
results.push(
  run('review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron）', [
    resolve(root, 'apps', 'desktop', 'node_modules', 'playwright', 'cli.js'),
    'test',
    '-c',
    'apps/desktop/test/review/playwright.recheck-20260907.config.ts',
  ]),
);

process.stdout.write(`\n\u001b[32m全部通过（IXAEON v0.2 验证完成）\u001b[0m\n`);
for (const r of results) {
  process.stdout.write(`  ✓ ${r.label} — ${r.seconds}s\n`);
}
