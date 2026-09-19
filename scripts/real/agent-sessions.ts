/**
 * 真机检查：用当前的解析器在内存里试解析本机的 Claude Code / Codex 会话。
 * 不入库、不发给模型、**不输出任何内容**——只输出数量和「用户」段的开头类别，
 * 用来发现解析规则漏掉的注入内容（2026-09-19 S1/S2 就是这样查出来的）。
 *
 *   node_modules/.bin/jiti scripts/real/agent-sessions.ts            两种都查
 *   node_modules/.bin/jiti scripts/real/agent-sessions.ts claude     只查 Claude Code
 *   node_modules/.bin/jiti scripts/real/agent-sessions.ts codex      只查 Codex
 *
 * 执行方注意：不许改成输出正文，也不许用别的办法打开这些会话文件（见 AGENTS.md「用户的原则」）。
 * 看结果：「用户」段应该几乎都是「普通」；出现一批以 < 或 # 开头的，多半是漏掉的注入内容。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  detectAgentSession,
  isCodexSubagentSession,
  parseClaudeCodeSession,
  parseCodexSession,
} from '../../packages/core/src/import/agentSessions.js';
import { iterateJsonlLines } from '../../packages/core/src/import/importService.js';

function jsonlFiles(dir: string, depth: number): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory() && depth > 0) out.push(...jsonlFiles(p, depth - 1));
    else if (st.isFile() && name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** 只看开头的「形状」：标签名、第一个符号，不带正文。 */
function startClass(text: string): string {
  const t = text.trimStart();
  const tag = /^<\/?([A-Za-z][\w -]{0,40}?)[\s>]/.exec(t);
  if (tag) return `以 <${tag[1]}> 开头`;
  if (t.startsWith('#')) return '以 # 开头';
  if (t.startsWith('[')) return '以 [ 开头';
  return '普通';
}

function check(tool: 'claude_code' | 'codex', files: string[]): void {
  const tally: Record<string, number> = {};
  const n = {
    文件: files.length,
    认不出: 0,
    子代理跳过: 0,
    没有对话: 0,
    会话: 0,
    段: 0,
    用户段: 0,
    用户字数: 0,
    回答字数: 0,
  };
  let slowest = { 秒: 0, MB: 0 };
  for (const file of files) {
    const preview: string[] = [];
    for (const line of iterateJsonlLines(file)) {
      if (!line.trim()) continue;
      preview.push(line);
      if (preview.length >= 20) break;
    }
    if (detectAgentSession(preview) !== tool) {
      n.认不出++;
      continue;
    }
    if (tool === 'codex' && isCodexSubagentSession(preview)) {
      n.子代理跳过++;
      continue;
    }
    const t0 = performance.now();
    const parsed =
      tool === 'codex'
        ? parseCodexSession(iterateJsonlLines(file))
        : parseClaudeCodeSession(iterateJsonlLines(file));
    const sec = (performance.now() - t0) / 1000;
    if (sec > slowest.秒) {
      slowest = { 秒: Number(sec.toFixed(1)), MB: Math.round(statSync(file).size / 1024 / 1024) };
    }
    if (!parsed) {
      n.没有对话++;
      continue;
    }
    n.会话++;
    for (const s of parsed.segments) {
      n.段++;
      if (s.role === 'assistant') {
        n.回答字数 += s.text.length;
        continue;
      }
      n.用户段++;
      n.用户字数 += s.text.length;
      const k = startClass(s.text);
      tally[k] = (tally[k] ?? 0) + 1;
    }
  }
  console.log(`\n== ${tool === 'codex' ? 'Codex' : 'Claude Code'} ==`);
  console.log(JSON.stringify({ ...n, 最慢: slowest }, null, 2));
  console.log('「用户」段的开头类别：');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(v).padStart(7)}  ${k}`);
  }
}

const only = process.argv[2];
const home = homedir();
if (only !== 'codex') check('claude_code', jsonlFiles(join(home, '.claude', 'projects'), 1));
if (only !== 'claude') check('codex', jsonlFiles(join(home, '.codex', 'sessions'), 4));
