#!/usr/bin/env node
/**
 * 仓库是公开的：提交进来的文件里不能带着本机的账户名——通常是贴真机输出时带进来的
 * `C:\Users\<账户名>\…` 这种路径。
 *
 * 查的是「跑这个脚本的这台机器」的账户名：贴输出的人就在这台机器上跑门禁。
 * CI 上不查：那里的账户名是公用的（runneradmin），不是谁的个人信息，文档里讲 CI 的路径时
 * 本来就会写到它（第一版没跳过，CI 上把 D4 交付说明里的一处 CI 路径当成了泄露）。
 * 只查 git 跟踪的文本文件；只认「Users + 分隔符 + 账户名」这种路径写法。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true') {
  console.log('✓ CI 上不查（查的是开发机的账户名；这里的账户名是公用的）');
  process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = [...new Set([userInfo().username, basename(homedir())])].filter((n) => n.length >= 2);
if (names.length === 0) {
  console.log('✓ 没有可查的账户名（太短），跳过');
  process.exit(0);
}
// Users 后面的分隔符在文档里可能是 \、\\、\\\\ 或 /；账户名后面不能紧跟着别的字（不然是另一个名字）
const pattern = new RegExp(`Users[\\\\/]+(?:${names.map(escape).join('|')})(?![\\w.-])`, 'i');

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const hits = [];
for (const file of files) {
  const abs = resolve(root, file);
  let buf;
  try {
    if (statSync(abs).size > 4 * 1024 * 1024) continue;
    buf = readFileSync(abs);
  } catch {
    continue; // 跟踪着但工作区里没有（删了还没提交）
  }
  if (buf.subarray(0, 8000).includes(0)) continue; // 二进制
  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) hits.push(`${file}:${i + 1}`);
  }
}

if (hits.length > 0) {
  console.log(
    '✗ 这些地方带着本机的账户名（仓库是公开的），把路径里的账户名换成 <用户>，或者把临时目录整个遮掉：',
  );
  for (const hit of hits) console.log(`  ${hit}`);
  process.exit(1);
}
console.log(`✓ ${files.length} 个跟踪的文件里没有本机的账户名`);
