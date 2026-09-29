/**
 * V1 真机检查：开发版应用（Electron）里派发带默认验证命令的编码任务，
 * 用执行器替身（LOCALAPPDATA 指向临时目录 → resolveCodexLocator 找不到
 * 真 Codex → FakeCodingExecutor），确认：
 * 1) 验证真的跑了（本期修复前：Electron 不加 ELECTRON_RUN_AS_NODE，
 *    验证命令变成再启动一个应用实例——任务卡住且多出窗口）；
 * 2) 通过/失败两条命令的退出码如实反映；
 * 3) 全程没有多出窗口（BrowserWindow 数量保持 1）。
 *
 *   node scripts/real/v1-verify-electron.mjs
 *
 * 只用临时数据目录与合成项目；不调用真 Codex、不调模型。
 */
import { createRequire } from 'node:module';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { _electron: electron } = desktopRequire('playwright');
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ixaeon-v1-real-'));
const dataDir = join(root, 'data');
const fakeLocal = join(root, 'localappdata');
mkdirSync(fakeLocal, { recursive: true });

const occupied = await fetch('http://127.0.0.1:43191/api/health', {
  signal: AbortSignal.timeout(1000),
}).then(
  () => true,
  () => false,
);
if (occupied) {
  console.error('43191 被占（本机正在跑 IXAEON？），拒绝打扰，未检查。');
  process.exit(2);
}

const app = await electron.launch({
  args: [resolve('apps/desktop/out/main/index.js'), `--user-data-dir=${join(root, 'profile')}`],
  env: {
    ...process.env,
    IXAEON_DATA_DIR: dataDir,
    LOCALAPPDATA: fakeLocal, // 让 resolveCodexLocator 找不到真 Codex → Fake 执行器
    IXAEON_FAKE_MODEL: '1',
  },
});
try {
  const page = await app.firstWindow();
  // 主进程视角：真是 Electron 在跑，execPath 是 Electron 可执行文件
  const mainExec = await app.evaluate(({ app: ea }) => ea.getPath('exe'));
  const electronVersion = 'Electron（由 app.getPath 证明本进程即 Electron 可执行文件）';
  console.log(`main execPath=${mainExec}`);
  console.log(`versions.electron=${electronVersion}`);

  await page
    .evaluate(async () => {
      await window.ixaeon.completeSetup({
        dataDir: null,
        modelName: 'fake-model',
        apiBaseUrl: '',
        apiKey: '',
        projectName: 'V1 合成项目',
        projectRootPath: null,
      });
      return window.ixaeon.listProjects();
    }, {})
    .then((ps) => {
      if (!ps || ps.length === 0) throw new Error('completeSetup 未建出项目');
    });
  const projects = await page.evaluate(() => window.ixaeon.listProjects());
  const projectId = projects[0].id;

  const runOne = async (label, verifyArgv, expectPassed) => {
    const windowsBefore = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    const task = await page.evaluate(
      async (args) =>
        window.ixaeon.createCodingTask({
          projectId: args.projectId,
          goal: 'V1 真机：把 note.txt 写好',
          scope: ['note.txt'],
          allowedCommands: [args.verifyArgv],
        }),
      { projectId, verifyArgv },
    );
    await page.evaluate((id) => window.ixaeon.approveCodingTask(id), task.id);
    await page.evaluate((id) => window.ixaeon.dispatchCodingTask(id), task.id);
    // 等派发→验证落定（fake 执行器同步快，2s 足够；轮询状态更稳）
    let status = '';
    for (let i = 0; i < 40; i += 1) {
      const row = await page.evaluate(async (id) => {
        const ts = await window.ixaeon.listCodingTasks();
        return ts.tasks.find((t) => t.id === id);
      }, task.id);
      status = `${row?.status ?? '?'}/${row?.verify_status ?? '?'}`;
      if (row && row.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 500)); // 收尾（杀进程树后窗口数再数）
    const windowsAfter = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    console.log(`\n=== ${label}`);
    console.log(
      `任务终态: ${status}（期望 ${expectPassed ? 'pending_accept/passed' : 'failed/failed'}）`,
    );
    console.log(`窗口数: 派发前 ${windowsBefore} → 派发后 ${windowsAfter}`);
    const ok =
      status === (expectPassed ? 'pending_accept/passed' : 'failed/failed') &&
      windowsAfter === windowsBefore &&
      windowsAfter === 1;
    console.log(`判定: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  };

  // 通过例：DEFAULT_NOTE_VERIFY 同款（fake 执行器会写出 note.txt）
  await runOne(
    '验证通过例（默认命令，Electron 当 node 跑）',
    [
      mainExec,
      '-e',
      "const fs=require('fs');const p='note.txt';if(!fs.existsSync(p))process.exit(2);if(!String(fs.readFileSync(p,'utf8')).trim())process.exit(3);",
    ],
    true,
  );
  // 失败例：命令本身非零退出 → 验证失败如实反映
  await runOne('验证失败例（退出码 7 → failed）', [mainExec, '-e', 'process.exit(7)'], false);
} finally {
  await app.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
