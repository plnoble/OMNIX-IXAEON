/**
 * 端到端用的假开发工具：用 Windows 自带的 csc.exe 现编一个真 .exe 启动器。
 *
 * 启动器读同目录 `<名字>.fake.json`（行为：往标准输出打的几行、往工作区写的文件、退出码），
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
using System.Text.Json;

class FakeTool {
  static int Main(string[] args) {
    string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string dir = Path.GetDirectoryName(exe);
    string name = Path.GetFileNameWithoutExtension(exe);
    string specPath = Path.Combine(dir, name + ".fake.json");
    string log = "cwd=" + Environment.CurrentDirectory + "\\nargs=" + string.Join("|", args) + "\\n";
    File.WriteAllText(Path.Combine(dir, name + ".args.txt"), log, new UTF8Encoding(false));
    if (!File.Exists(specPath)) return 3;
    using var doc = JsonDocument.Parse(File.ReadAllText(specPath));
    var root = doc.RootElement;
    if (root.TryGetProperty("writeFiles", out var files)) {
      foreach (var f in files.EnumerateArray()) {
        string rel = f.GetProperty("path").GetString();
        string content = f.GetProperty("content").GetString();
        string full = Path.Combine(Environment.CurrentDirectory, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(full));
        File.WriteAllText(full, content, new UTF8Encoding(false));
      }
    }
    if (root.TryGetProperty("stdout", out var lines)) {
      foreach (var line in lines.EnumerateArray()) Console.WriteLine(line.GetString());
    }
    return root.TryGetProperty("exitCode", out var code) ? code.GetInt32() : 0;
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
  writeFileSync(join(dir, `${name}.fake.json`), JSON.stringify(behavior), 'utf8');
  return exe;
}
