/**
 * MP3db 真机检查：假程序（csc 现编 .exe）跑「Codex → Claude Code」一串。
 *   node scripts/real/run-batch.mjs scripts/real/mp3d-coding-chain.ts
 * 输出谁做的、换了几次、那一句提示；临时目录遮掉；不跑真的三个开发工具。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingChainExecutor, type CodingCandidate } from '../../packages/core/src/index.js';
import type { CodingExecutor, ExecutorReport } from '../../packages/core/src/execution/executor.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3d-real-'));
const workspace = join(dir, 'ws');
mkdirSync(workspace, { recursive: true });
const tools = join(dir, 'tools');
mkdirSync(tools, { recursive: true });
const mask = (s: string): string => s.replaceAll(dir, '<临时目录>');

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const SOURCE = `
using System;using System.IO;
class F{static int Main(string[] a){
string exe=System.Reflection.Assembly.GetExecutingAssembly().Location;string d=Path.GetDirectoryName(exe);
string n=Path.GetFileNameWithoutExtension(exe);string s=Path.Combine(d,n+".fake.txt");
if(!File.Exists(s))return 3;
string[] lines=File.ReadAllLines(s);
int code=0;int i=0;
if(lines.Length>0){int.TryParse(lines[0],out code);i=1;}
if(i<lines.Length&&lines[i].StartsWith("write:")){string rest=lines[i].Substring(6);int bar=rest.IndexOf("|");string path=bar>=0?rest.Substring(0,bar):rest;string content=bar>=0?rest.Substring(bar+1):"";File.WriteAllText(Path.Combine(Environment.CurrentDirectory,path),content);i++;}
for(;i<lines.Length;i++)Console.WriteLine(lines[i]);
return code;}}`;
function build(name: string, behavior: unknown): string {
  if (!existsSync(CSC)) throw new Error('找不到 csc.exe');
  const cs = join(tools, name + '.cs');
  const exe = join(tools, name + '.exe');
  writeFileSync(cs, SOURCE, 'utf8');
  execFileSync(CSC, ['/nologo', `/out:${exe}`, cs], { cwd: tools });
  writeFileSync(join(tools, name + '.fake.txt'), (behavior as string[]).join('\n'), 'utf8');
  return exe;
}
const codexExe = build('codex', ['1', 'usage_limit_reached']);
const claudeExe = build('claude', [
  '0',
  'write:note.txt|done',
  '{"result":"写好了 note.txt","is_error":false}',
]);

/** 只把假 exe 跑起来、把标准输出/退出码变成成功后回报或失败异常（不是真的 Codex 协议）。 */
function fakeToolExecutor(name: string, exe: string, kind: 'claude' | 'raw'): CodingExecutor {
  return {
    name,
    async run(): Promise<ExecutorReport> {
      let out = '';
      let code = 0;
      try {
        out = execFileSync(exe, [], { cwd: workspace, encoding: 'utf8' });
      } catch (err) {
        const e = err as { stdout?: string; status?: number };
        out = String(e.stdout ?? '');
        code = e.status ?? 1;
      }
      if (kind === 'raw') throw new Error(out.trim());
      const parsed = JSON.parse(out) as { result: string; is_error: boolean };
      if (code !== 0 || parsed.is_error) throw new Error('Claude Code 失败');
      return {
        summary: parsed.result,
        claimedSuccess: true,
        changes: [],
      } as unknown as ExecutorReport;
    },
  };
}

const skip = new Map<string, number>();
const candidates = (): CodingCandidate[] => [
  { key: 'tool:codex', label: 'Codex', executor: fakeToolExecutor('codex-cli', codexExe, 'raw') },
  {
    key: 'tool:claude:sonnet',
    label: 'Claude Code · sonnet',
    executor: fakeToolExecutor('claude-code', claudeExe, 'claude'),
  },
];
const chain = new CodingChainExecutor(candidates, { skip });
const report = await chain.run(
  { id: 't', goal: '写一条 note.txt', scope: ['note.txt'] } as never,
  workspace,
  new AbortController().signal,
);
console.log('谁做的：', chain.name);
console.log('换了几次：', skip.size);
console.log('那一句提示：', mask(String(report.summary)));
rmSync(dir, { recursive: true, force: true });
