/**
 * 端到端用的假开发工具：用 Windows 自带的 csc.exe 现编一个真 .exe 启动器。
 *
 * 启动器读同目录 `<名字>.fake.txt`（每行「种类\t内容」，csc 只认 C# 5，不用 JSON）（行为：往标准输出打的几行、往工作区写的文件、退出码），
 * 把收到的参数和 cwd 记到 `<名字>.args.txt`，然后退出。
 * 执行器不经 shell 起进程，`.cmd` 起不来，所以这里必须是真的 .exe。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

const SOURCE = `
using System;
using System.IO;
using System.Text;
class FakeTool {
  static int Main(string[] args) {
    string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string dir = Path.GetDirectoryName(exe);
    string name = Path.GetFileNameWithoutExtension(exe);
    string spec = Path.Combine(dir, name + ".fake.txt");
    string log = "cwd=" + Environment.CurrentDirectory + "\\nargs=" + string.Join("|", args) + "\\n";
    File.WriteAllText(Path.Combine(dir, name + ".args.txt"), log, new UTF8Encoding(false));
    if (!File.Exists(spec)) return 3;
    int code = 0;
    foreach (string line in File.ReadAllLines(spec, Encoding.UTF8)) {
      string[] parts = line.Split('\\t');
      if (parts[0] == "out" && parts.Length >= 2) {
        Console.Out.Write(parts[1] + "\\n");
      } else if (parts[0] == "write" && parts.Length >= 3) {
        string full = Path.Combine(Environment.CurrentDirectory, parts[1]);
        Directory.CreateDirectory(Path.GetDirectoryName(full));
        File.WriteAllText(full, parts[2], new UTF8Encoding(false));
      } else if (parts[0] == "exit" && parts.Length >= 2) {
        code = int.Parse(parts[1]);
      }
    }
    Console.Out.Flush();
    return code;
  }
}
`;

export interface FakeBehavior {
  stdout?: string[];
  writeFiles?: Array<{ path: string; content: string }>;
  exitCode?: number;
}

/** 在 dir 下编译一个假工具，返回 .exe 的绝对路径（同一次测试只编一次）。 */
export function buildFakeTool(dir: string, name: string, behavior: FakeBehavior): string {
  if (!existsSync(CSC)) throw new Error(`找不到 csc.exe：${CSC}；端到端需要它现编假工具`);
  const cs = join(dir, `${name}.cs`);
  const exe = join(dir, `${name}.exe`);
  writeFileSync(cs, SOURCE, 'utf8');
  execFileSync(CSC, ['/nologo', `/out:${exe}`, cs], { cwd: dir });
  const lines = [
    ...(behavior.writeFiles ?? []).map((w) => `write\t${w.path}\t${w.content}`),
    ...(behavior.stdout ?? []).map((o) => `out\t${o}`),
    `exit\t${behavior.exitCode ?? 0}`,
  ];
  writeFileSync(join(dir, `${name}.fake.txt`), lines.join('\n'), 'utf8');
  return exe;
}
