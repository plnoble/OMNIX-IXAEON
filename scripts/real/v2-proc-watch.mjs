/**
 * V2 排查监视器 2（本机临时，不入库）：每 600ms 采样 electron.exe 进程
 * （PID/父PID/起始时间/命令行，经 ConvertTo-Csv 安全解析），回答
 * 「第二个应用实例是谁拉起的」。用法：与 smoke e2e 并行，跑 180s。
 */
import { spawnSync } from 'node:child_process';

const cmd =
  'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Csv -NoTypeInformation';

function sample() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const rows = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (!line || line.startsWith('"ProcessId"')) continue;
    const m = line.match(/^"(\d+)","(\d+)","([^"]+)","(.*)"$/);
    if (!m) continue;
    rows.push({
      pid: m[1],
      ppid: m[2],
      time: m[3],
      cmd: (m[4] || '').replace(/\s+/g, ' ').slice(0, 200),
    });
  }
  return rows;
}

const seen = new Map();
const end = Date.now() + 180_000;
while (Date.now() < end) {
  const now = new Set();
  for (const row of sample()) {
    now.add(row.pid);
    if (!seen.has(row.pid)) {
      console.log(`BORN pid=${row.pid} ppid=${row.ppid} at=${row.time} cmd=${row.cmd}`);
    }
    seen.set(row.pid, row);
  }
  for (const [pid, info] of [...seen]) {
    if (!now.has(pid)) {
      console.log(`DIED pid=${pid} ppid=${info.ppid} born=${info.time}`);
      seen.delete(pid);
    }
  }
  await new Promise((res) => setTimeout(res, 600));
}
console.log('[proc-watch] done');
