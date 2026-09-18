#!/usr/bin/env node
/**
 * 委派流水线：锁定的验收测试（见 AGENTS.md「委派流水线」）。
 *
 * 验收测试由整合方先写进 test/acceptance/（开始时不过），执行方只负责让它通过、不许改。
 * 指纹记在 docs/委派/锁定验收.json；本脚本核对指纹，改了就不通过——
 * 把「不许自己写验收标准」从口头规矩变成机器检查。
 *
 *   node scripts/acceptance.mjs check            核对全部锁定测试的指纹（门禁、CI）
 *   node scripts/acceptance.mjs run <任务>        跑某个任务的验收测试（执行方）
 *   node scripts/acceptance.mjs run-done         跑所有已完成任务的验收测试（门禁、CI）
 *   node scripts/acceptance.mjs lock <任务> <标题> <文件…>   整合方：登记指纹（状态 queued）
 *   node scripts/acceptance.mjs done <任务>       整合方：并入后标为已完成（从此进门禁）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'docs', '委派', '锁定验收.json');

function load() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function save(manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** 换行统一成 LF 再算：Windows 检出时 git 可能把 LF 换成 CRLF，不能因此判成「改过」。 */
function fingerprint(path) {
  const text = readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function task(manifest, id) {
  const found = manifest.tasks.find((t) => t.id === id);
  if (!found) fail(`没有登记的任务：${id}（见 docs/委派/锁定验收.json）`);
  return found;
}

function fail(message) {
  console.error(`\u001b[31m✗ ${message}\u001b[0m`);
  process.exit(1);
}

function vitest(files) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--project',
      'acceptance',
      ...files,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

const [command, ...args] = process.argv.slice(2);
const manifest = load();

if (command === 'check') {
  const problems = [];
  for (const t of manifest.tasks) {
    for (const [path, expected] of Object.entries(t.files)) {
      if (!existsSync(resolve(root, path))) problems.push(`${t.id}：${path} 不见了`);
      else if (fingerprint(path) !== expected) problems.push(`${t.id}：${path} 被改过`);
    }
  }
  if (problems.length > 0) {
    fail(
      `锁定的验收测试不许改（由整合方写死，执行方只负责让它通过）：\n  ${problems.join('\n  ')}\n` +
        '  觉得验收测试本身有错：在交付说明里写出来，由整合方改。',
    );
  }
  const count = manifest.tasks.reduce((n, t) => n + Object.keys(t.files).length, 0);
  console.log(`✓ ${manifest.tasks.length} 个任务的 ${count} 个锁定验收测试都没被改`);
} else if (command === 'run') {
  const t = task(manifest, args[0]);
  vitest(Object.keys(t.files));
} else if (command === 'run-done') {
  const files = manifest.tasks
    .filter((t) => t.status === 'done')
    .flatMap((t) => Object.keys(t.files));
  if (files.length === 0) {
    console.log('还没有已完成任务的验收测试');
    process.exit(0);
  }
  vitest(files);
} else if (command === 'lock') {
  const [id, title, ...files] = args;
  if (!id || !title || files.length === 0) fail('用法：lock <任务> <标题> <文件…>');
  const entry = manifest.tasks.find((t) => t.id === id) ?? {
    id,
    title,
    status: 'queued',
    files: {},
  };
  entry.title = title;
  entry.status = 'queued';
  entry.files = Object.fromEntries(files.map((f) => [f.replace(/\\/g, '/'), fingerprint(f)]));
  if (!manifest.tasks.includes(entry)) manifest.tasks.push(entry);
  save(manifest);
  console.log(`✓ 已锁定 ${id}：${files.length} 个验收测试`);
} else if (command === 'done') {
  const t = task(manifest, args[0]);
  t.status = 'done';
  save(manifest);
  console.log(`✓ ${t.id} 标为已完成，验收测试从此进门禁`);
} else {
  fail('用法：check | run <任务> | run-done | lock <任务> <标题> <文件…> | done <任务>');
}
