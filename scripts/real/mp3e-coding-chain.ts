/**
 * MP3e 真机检查：「Codex → DSH」一串（假程序 csc 现编 .exe，不跑真的 Codex / DSH）。
 *   node scripts/real/run-batch.mjs scripts/real/mp3e-coding-chain.ts
 * 输出谁做的、换了几次、那一句提示；临时目录遮掉。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexCliExecutor,
  DshExecutor,
  CodingChainExecutor,
  type CodingCandidate,
} from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3e-real-'));
const workspace = join(dir, 'ws');
const tools = join(dir, 'tools');
const install = join(dir, 'dsh-install');
mkdirSync(workspace, { recursive: true });
mkdirSync(tools, { recursive: true });
mkdirSync(
  join(
    install,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
  ),
  { recursive: true },
);
const mask = (s: string): string => s.replaceAll(dir, '<临时目录>');

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const SRC = `using System;using System.IO;class F{static int Main(string[] a){string exe=System.Reflection.Assembly.GetExecutingAssembly().Location;string d=Path.GetDirectoryName(exe);string n=Path.GetFileNameWithoutExtension(exe);string s=Path.Combine(d,n+\".fake.txt\");if(!File.Exists(s))return 3;string[] l=File.ReadAllLines(s);int c=0;int i=0;if(l.Length>0){int.TryParse(l[0],out c);i=1;}if(i<l.Length&&l[i].StartsWith(\"write:\")){string r=l[i].Substring(6);int b=r.IndexOf(\"|\");File.WriteAllText(Path.Combine(Environment.CurrentDirectory,b>=0?r.Substring(0,b):r),b>=0?r.Substring(b+1):\"\");i++;}for(;i<l.Length;i++)Console.WriteLine(l[i]);return c;}}`;
function build(exeName: string, lines: string[]): string {
  const cs = join(tools, 'launcher.cs');
  const exe = exeName.includes('\\') ? exeName : join(tools, exeName);
  writeFileSync(cs, SRC, 'utf8');
  execFileSync(CSC, ['/nologo', `/out:${exe}`, cs], { cwd: tools });
  writeFileSync(join(exe.replace(/\.exe$/i, '') + '.fake.txt'), lines.join('\n'), 'utf8');
  return exe;
}

const codexExe = build('codex.exe', ['1', 'usage_limit_reached']);
const dshExe = build(join(install, 'DeepSeek Harness.exe'), [
  '0',
  'write:note.txt|done',
  '{"type":"final","text":"DSH 做完了"}',
]);

const skip = new Map<string, number>();
const candidates = (): CodingCandidate[] => [
  {
    key: 'tool:codex',
    label: 'Codex',
    executor: new CodexCliExecutor({ exe: codexExe, sandbox: 'workspace-write' }),
  },
  { key: 'tool:dsh', label: 'DSH', executor: new DshExecutor({ install }) },
];
const chain = new CodingChainExecutor(candidates, { skip });
const report = await chain.run(
  { id: 't', goal: '写一条 note.txt', scope: ['note.txt'], timeout_ms: 30000 } as never,
  workspace,
  new AbortController().signal,
);
console.log('谁做的：', chain.name);
console.log('换了几次：', skip.size);
console.log('那一句提示：', mask(String(report.summary)));
if (existsSync(dshExe)) console.log('假 DSH 存在：', '是');
rmSync(dir, { recursive: true, force: true });
