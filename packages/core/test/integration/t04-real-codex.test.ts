import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openDatabase,
  migrate,
  ProjectService,
  CodingOrchestrator,
  CodexCliExecutor,
  resolveCodexLocator,
} from '../../src/index.js';

/** Windows 上被终止的进程树可能仍短暂持有句柄：重试删除，清理失败不判测试失败。 */
async function bestEffortRm(dir: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.warn(`T04 探针临时目录未能删除（句柄占用，系统稍后回收）：${dir}`);
}

/**
 * T04 真机探针：真 Codex CLI（消耗少量额度）、隔离临时工作区、独立验证命令。
 * 默认跳过；IXAEON_REAL_CODEX=1 且本机可定位 codex.exe 才跑。
 * 历史教训：Fake 执行器曾把「completed/verify-passed」写进记录而磁盘上没有文件；
 * 本探针的通过标准是任务记录与磁盘文件双重复核，失败原样暴露，不改期望。
 */
const run = process.env.IXAEON_REAL_CODEX === '1';
const locator = run ? resolveCodexLocator() : null;

describe.skipIf(!run || !locator)('T04 真机 Codex 隔离文件探针', () => {
  it(
    '派发→真 codex 写 note.txt→独立验证→磁盘复核',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ixaeon-t04-'));
      const projectRoot = join(dir, 'project');
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, 'README.md'), '# T04 探针项目\n');
      const db = openDatabase(join(dir, 'ixaeon.db'));
      try {
        migrate(db);
        const projects = new ProjectService(db);
        const project = projects.create({
          name: 'T04 探针',
          rootPath: projectRoot,
          description: null,
        });
        const orchestrator = new CodingOrchestrator(db, new CodexCliExecutor(locator!), dir);
        const token = `IXAEON_REAL_PROBE_${randomUUID().slice(0, 8)}`;
        const check = `const fs=require('fs');const t=fs.readFileSync('note.txt','utf8');if(t.trim()!=='${token}'){console.error('note.txt 内容不符');process.exit(2);}`;
        const task = orchestrator.create({
          projectId: project.id,
          goal: `在当前工作区根目录创建 note.txt，内容恰好是一行文本：${token}\n除 note.txt 外不要创建或修改任何文件。`,
          scope: ['note.txt'],
          allowedCommands: [[process.execPath, '-e', check]],
          timeoutMs: 5 * 60 * 1000,
        });
        await orchestrator.approveAndQueue(task.id);
        const done = await orchestrator.dispatch(task.id);

        if (done.status !== 'pending_accept') {
          // 真失败必须可诊断：完整转储执行器报告，不改期望掩盖
          console.error('T04 探针失败诊断:', {
            status: done.status,
            error: done.error,
            verify_status: done.verify_status,
            verify_exit_code: done.verify_exit_code,
            verify_output: done.verify_output?.slice(0, 2000),
            executor_report: done.executor_report_json?.slice(0, 4000),
            workspace: done.workspace_path,
          });
        }

        // 任务记录断言
        expect(done.executor_name).toBe('codex-cli');
        expect(done.status).toBe('pending_accept');
        expect(done.verify_status).toBe('passed');
        expect(done.verify_exit_code).toBe(0);
        expect(done.error).toBeNull();

        // 磁盘独立复核：不信任任务记录，直接读文件
        const note = readFileSync(join(done.workspace_path!, 'note.txt'), 'utf8');
        expect(note.trim()).toBe(token);
      } finally {
        db.close();
        await bestEffortRm(dir);
      }
    },
    6 * 60 * 1000,
  );
});
