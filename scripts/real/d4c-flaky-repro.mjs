/**
 * D4c 本机复现脚本：单跑 30 遍 + 烤机 12 遍（限时 2 分钟）。
 * 照 AGENTS.md 存入 scripts/real/ 便于复现。
 *
 *   node scripts/real/d4c-flaky-repro.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';

process.env.GIT_CONFIG_GLOBAL = 'nul';

console.log('== 阶段 1：单独连跑 30 遍 ==');
let pass1 = 0;
let fail1 = 0;
for (let i = 1; i <= 30; i++) {
  const r = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      'acceptance',
      'apps/desktop/test/acceptance/d4-landing-report.test.ts',
      '-t',
      '真实 IPC 入口',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status === 0) pass1++;
  else {
    fail1++;
    console.log(`  第 ${i} 遍红：${(r.stdout || r.stderr).slice(0, 300)}`);
  }
}
console.log(`阶段 1 结果：pass=${pass1} fail=${fail1}`);

console.log('== 阶段 2：机器忙时跑 12 遍（起 CPU 烤机进程，限时 2 分钟） ==');
const burnCount = Math.max(2, cpus().length);
const burners = [];
for (let i = 0; i < burnCount; i++) {
  burners.push(
    spawnSync(
      'start',
      [
        '/B',
        'node',
        '-e',
        'const t=Date.now();while(Date.now()-t<120000){Math.sqrt(Math.random())}',
      ],
      {
        shell: true,
        windowsHide: true,
      },
    ),
  );
}
console.log(`已起 ${burnCount} 个占 CPU 的进程`);

let pass2 = 0;
let fail2 = 0;
for (let i = 1; i <= 12; i++) {
  const r = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      'acceptance',
      'apps/desktop/test/acceptance/d4-landing-report.test.ts',
      '-t',
      '真实 IPC 入口',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status === 0) pass2++;
  else {
    fail2++;
    console.log(`  忙时第 ${i} 遍红：${(r.stdout || r.stderr).slice(0, 300)}`);
  }
}
console.log(`阶段 2 结果：pass=${pass2} fail=${fail2}`);
console.log(`总计：pass=${pass1 + pass2} fail=${fail1 + fail2}`);
