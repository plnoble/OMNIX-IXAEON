import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * M2 六类语义场景界面级验收（C12 重写：非空数据 + 真实用户动作 + 跨层断言）。
 *
 * 模型入口：IXAEON_FAKE_MODEL=1 + IXAEON_FAKE_MODEL_SCRIPT 指向预置响应 JSON
 * （生产代码仅在环境变量存在时读取，正常用户运行不构成任意写库入口）。
 * 每类场景先证明条目实际存在，再点击相应操作并验证前后状态；
 * 测试名与执行内容一致，不以空态断言代替场景验证。
 */

function findDesktopDir(): string {
  for (let dir = process.cwd(); ; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'out', 'main', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('找不到 out/main/index.js');
    dir = parent;
  }
}

const desktopDir = findDesktopDir();

interface ScenarioDef {
  id: string;
  title: string;
  docLines: string[];
  modelItems: Array<Record<string, unknown>>;
  uiAction:
    | { kind: 'confirm' }
    | { kind: 'reject' }
    | { kind: 'correct'; newText: string }
    | { kind: 'none' };
  /** 界面断言关键词（动作后理解页应包含） */
  uiExpectText: string;
  /** 简报断言 */
  briefExpect: Array<{ text: string; label?: string; absent?: boolean }>;
}

const SCENARIOS: ScenarioDef[] = [
  {
    id: 'S1',
    title: 'AI 提议但用户没答应',
    docLines: ['用户：项目日志现在有点乱，你有什么建议？', 'AI：建议启用远程项目日志服务。C12_S1_PROPOSAL'],
    modelItems: [
      {
        type: 'decision',
        statement: '启用远程项目日志服务集中保存日志',
        rationale: null,
        confidence: 0.85,
        segment_ref: 'S3',
        project_hint: null,
        excerpt: '建议启用远程项目日志服务',
      },
    ],
    uiAction: { kind: 'none' },
    uiExpectText: '启用远程项目日志服务',
    briefExpect: [{ text: '启用远程项目日志服务', label: '待用户确认' }],
  },
  {
    id: 'S2',
    title: '用户明确否决',
    docLines: ['用户：我决定不采用云同步方案。C12_S2_LOCAL', 'AI：明白，所有数据保存在本地。'],
    modelItems: [
      {
        type: 'rejected_option',
        statement: '云同步方案已被用户明确否决',
        rationale: null,
        confidence: 0.95,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: '不采用云同步方案',
      },
    ],
    uiAction: { kind: 'reject' },
    uiExpectText: '已不采纳',
    briefExpect: [{ text: '云同步方案已被用户明确否决', absent: true }],
  },
  {
    id: 'S3',
    title: '用户后来改口',
    docLines: ['用户：第一版先用 SQLite 做全文搜索。C12_S3_V1'],
    modelItems: [
      {
        type: 'decision',
        statement: '第一版采用 SQLite 全文搜索',
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: '第一版先用 SQLite 做全文搜索',
      },
    ],
    uiAction: { kind: 'correct', newText: '改为：第一版同时准备向量检索接口但默认关闭' },
    uiExpectText: '同时准备向量检索接口',
    briefExpect: [
      { text: '同时准备向量检索接口', label: '用户确认' },
      { text: '第一版采用 SQLite 全文搜索', absent: true },
    ],
  },
  {
    id: 'S4',
    title: '不同来源矛盾',
    docLines: ['用户：方案乙：改用 Tauri 打包桌面端。C12_S4_TAURI'],
    modelItems: [
      {
        type: 'decision',
        statement: '改用 Tauri 打包桌面端',
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: '改用 Tauri 打包桌面端',
      },
    ],
    uiAction: { kind: 'none' },
    uiExpectText: '改用 Tauri 打包桌面端',
    briefExpect: [{ text: '改用 Tauri 打包桌面端', label: '待用户确认' }],
  },
  {
    id: 'S5',
    title: '证据不足',
    docLines: ['用户：性能目标还没定，等测试数据出来再说。C12_S5_OPEN'],
    modelItems: [
      {
        type: 'open_loop',
        statement: '性能目标尚未确定，等待测试数据',
        rationale: null,
        confidence: 0.8,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: '性能目标还没定',
      },
    ],
    uiAction: { kind: 'none' },
    uiExpectText: '性能目标尚未确定',
    briefExpect: [{ text: '性能目标尚未确定' }],
  },
];

test.describe('M2 六类语义场景界面级验收（C12）', () => {
  let app: ElectronApplication;
  let page: Page;
  let dataDir: string;

  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-c12-'));
    const allItems: Array<Record<string, unknown>> = [];
    for (const sc of SCENARIOS) {
      writeFileSync(
        join(dataDir, `${sc.id}.md`),
        `# 场景${sc.id}\n\n${sc.docLines.join('\n\n')}\n`,
        'utf8',
      );
      allItems.push(...sc.modelItems);
    }
    const scriptPath = join(dataDir, 'model-script.json');
    writeFileSync(
      scriptPath,
      JSON.stringify({
        // FakeProvider 每次消费一个 { items: [...] } 完整响应；
        // 每个场景一次提取 → 每场景一个响应（含该场景全部条目）
        structured: SCENARIOS.map((sc) => ({ items: sc.modelItems })),
        text: ['（合成回答）待确认事项已列出。'],
      }),
      'utf8',
    );

    process.env.IXAEON_TEST_DIALOG_RESPONSES = `documents|${SCENARIOS.map(
      (sc) => join(dataDir, `${sc.id}.md`),
    ).join(',')}`;

    app = await electron.launch({
      args: [join(desktopDir, 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        IXAEON_DATA_DIR: dataDir,
        IXAEON_FAKE_MODEL: '1',
        IXAEON_FAKE_MODEL_SCRIPT: scriptPath,
      },
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('setup-next-1').click();
    await page.getByTestId('setup-model-name').fill('fake-model');
    await page.getByTestId('setup-next-2').click();
    await page.getByTestId('setup-project-name').fill('语义主项目');
    await page.getByTestId('setup-finish').click();
    await expect(page.getByTestId('main-nav')).toBeVisible({ timeout: 20_000 });

    // 导入全部场景文档 → 触发提取（FakeProvider 预置响应）
    await page.getByTestId('nav-sources').click();
    await page.getByTestId('sources-import-docs').click();
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('tbody tr')).toHaveCount(SCENARIOS.length, { timeout: 20_000 });
    // 等全部提取任务完成（轮询任务表，最长 30s；失败也如实暴露）
    const deadline = Date.now() + 30_000;
    let extractDone = false;
    while (Date.now() < deadline) {
      const jobs = await page.evaluate(async () => {
        if (!window.ixaeon) throw new Error('preload API 未就绪');
        const list = await window.ixaeon.listJobs(50);
        return list.filter((j) => j.kind === 'extract').map((j) => j.status);
      });
      const pending = jobs.filter((s) => s === 'queued' || s === 'running').length;
      if (jobs.length >= SCENARIOS.length && pending === 0) {
        extractDone = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    expect(extractDone, '全部提取任务应在 30s 内完成').toBe(true);
    const failedJobs = await page.evaluate(async () => {
      if (!window.ixaeon) throw new Error('preload API 未就绪');
      const list = await window.ixaeon.listJobs(50);
      return list
        .filter((j) => j.status === 'failed')
        .map((j) => ({ kind: j.kind, error: j.error?.slice(0, 200) }));
    });
    expect(failedJobs, `提取任务不应失败: ${JSON.stringify(failedJobs)}`).toEqual([]);

    // 把全部场景来源绑定到「语义主项目」（界面等价操作：来源详情选择项目；
    // 此处经公开 IPC 批量完成，简报断言才能命中该项目）
    await page.evaluate(async () => {
      if (!window.ixaeon) throw new Error('preload API 未就绪');
      const projects = await window.ixaeon.listProjects();
      const target = projects.find((p) => p.name === '语义主项目') ?? projects[0]!;
      const sources = await window.ixaeon.listSources({ projectId: null });
      for (const s of sources) {
        await window.ixaeon.bindSourceProject({
          sourceId: s.source.id,
          projectId: target.id,
        });
      }
    });
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.IXAEON_TEST_DIALOG_RESPONSES;
  });

  for (const sc of SCENARIOS) {
    test(`${sc.id}：${sc.title}（非空数据 + 界面操作 + 跨层断言）`, async () => {
      // 1) 非空前提：条目在数据库中实际存在
      const items = await page.evaluate(async (keyword) => {
        if (!window.ixaeon) throw new Error('preload API 未就绪');
        const list = await window.ixaeon.listItems({ projectId: null });
        return list.filter((i) => i.statement.includes(keyword));
      }, sc.modelItems[0]!.statement as string);
      expect(items.length, `${sc.id} 条目必须存在（非空验证）`).toBeGreaterThan(0);

      // 2) 真实界面操作
      if (sc.uiAction.kind === 'confirm' || sc.uiAction.kind === 'reject') {
        await page.getByTestId('nav-inbox').click();
        const row = page.locator('.project-row', { hasText: items[0]!.statement });
        await expect(row).toBeVisible();
        if (sc.uiAction.kind === 'confirm') {
          await row.getByRole('button', { name: '确认正确' }).click();
        } else {
          await row.getByRole('button', { name: '不采纳' }).click();
        }
        await page.waitForTimeout(500);
      } else if (sc.uiAction.kind === 'correct') {
        await page.getByTestId('nav-understanding').click();
        const row = page.locator('.item-row', { hasText: items[0]!.statement });
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: '纠正' }).click();
        await page.getByTestId('correction-input').fill(sc.uiAction.newText);
        await page.getByTestId('correction-preview').click();
        await page.getByTestId('correction-confirm').click();
        await page.waitForTimeout(500);
      }

      // 3) 界面断言（动作后的理解页状态；等待列表加载完成再断言）
      await page.getByTestId('nav-understanding').click();
      await expect
        .poll(
          async () => {
            const body = await page.textContent('[data-testid="page-understanding"]');
            return body ?? '';
          },
          { timeout: 10_000 },
        )
        .toContain(sc.uiExpectText);

      // 4) MCP 简报跨层断言
      const localToken = await page.evaluate(async () => {
        if (!window.ixaeon) throw new Error('preload API 未就绪');
        const s = await window.ixaeon.getSettings();
        return s.mcp.localToken;
      });
      const projectId = await page.evaluate(async () => {
        if (!window.ixaeon) throw new Error('preload API 未就绪');
        const ps = await window.ixaeon.listProjects();
        return ps.find((p) => p.name === '语义主项目')?.id ?? ps[0]!.id;
      });
      const briefJson = execFileSync(
        process.execPath,
        [
          '-e',
          `const r = await fetch('http://127.0.0.1:43191/api/mcp/prepare-task', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ${localToken}' },
            body: JSON.stringify({ project_ref: '${projectId}', task: 'C12 ${sc.id}', max_chars: 12000 }),
          });
          if (!r.ok) throw new Error(String(r.status) + await r.text());
          process.stdout.write(JSON.stringify(await r.json()));`,
        ],
        { timeout: 15_000, encoding: 'utf8' },
      );
      const brief = JSON.parse(briefJson) as {
        decisions: Array<{ text: string }>;
        rejected_options: Array<{ text: string }>;
        open_loops: Array<{ text: string }>;
        risks: Array<{ text: string }>;
      };
      const briefText = JSON.stringify([
        ...brief.decisions,
        ...brief.rejected_options,
        ...brief.open_loops,
        ...brief.risks,
      ]);
      for (const exp of sc.briefExpect) {
        if (exp.absent) {
          expect(briefText.includes(exp.text), `${sc.id} 简报不应包含「${exp.text}」`).toBe(false);
        } else {
          expect(briefText.includes(exp.text), `${sc.id} 简报应包含「${exp.text}」`).toBe(true);
          if (exp.label) {
            const entry = [...brief.decisions, ...brief.risks].find((e) =>
              e.text.includes(exp.text),
            );
            expect(
              entry?.text.includes(exp.label),
              `${sc.id} 简报条目应带「${exp.label}」标注`,
            ).toBe(true);
          }
        }
      }
    });
  }

  test('S6：编码 agent 声称完成但用户未验收（界面 + 简报 + 引用展开）', async () => {
    const localToken = await page.evaluate(async () => {
      if (!window.ixaeon) throw new Error('preload API 未就绪');
      const s = await window.ixaeon.getSettings();
      return s.mcp.localToken;
    });
    const projectId = await page.evaluate(async () => {
      if (!window.ixaeon) throw new Error('preload API 未就绪');
      const ps = await window.ixaeon.listProjects();
      return ps.find((p) => p.name === '语义主项目')?.id ?? ps[0]!.id;
    });
    execFileSync(
      process.execPath,
      [
        '-e',
        `const r = await fetch('http://127.0.0.1:43191/api/mcp/record-work-result', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ${localToken}' },
          body: JSON.stringify({
            project_ref: '${projectId}',
            agent_name: 'codex-c12',
            task: 'C12_S6_AGENT_TASK 修复登录页',
            outcome: 'success',
            summary: 'agent 自报完成（用户未验收）',
            changes: [], tests: [], open_loops: [],
          }),
        });
        if (!r.ok) throw new Error(String(r.status));`,
      ],
      { timeout: 15_000 },
    );

    // 界面：项目页最近工作可见（C10 接入；等待列表加载完成）
    await page.getByTestId('nav-projects').click();
    await expect
      .poll(
        async () => {
          const projBody = await page.textContent('[data-testid="page-projects"]');
          return projBody ?? '';
        },
        { timeout: 10_000 },
      )
      .toContain('C12_S6_AGENT_TASK');
    const projBody = (await page.textContent('[data-testid="page-projects"]')) ?? '';
    expect(projBody).toContain('agent 自报');

    // 简报：recent_work 可见且 origin=work_result
    const briefJson = execFileSync(
      process.execPath,
      [
        '-e',
        `const r = await fetch('http://127.0.0.1:43191/api/mcp/prepare-task', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ${localToken}' },
          body: JSON.stringify({ project_ref: '${projectId}', task: 'C12 S6', max_chars: 12000 }),
        });
        if (!r.ok) throw new Error(String(r.status));
        process.stdout.write(JSON.stringify(await r.json()));`,
      ],
      { timeout: 15_000, encoding: 'utf8' },
    );
    const brief = JSON.parse(briefJson) as {
      recent_work: Array<{ text: string; origin: string | null; ref: string }>;
    };
    const entry = brief.recent_work.find((e) => e.text.includes('C12_S6_AGENT_TASK'));
    expect(entry, 'S6 简报 recent_work 应包含该工作').toBeDefined();
    expect(entry!.origin).toBe('work_result');

    // C09：工作引用可展开（含「用户尚未验收」标注）
    const excerptJson = execFileSync(
      process.execPath,
      [
        '-e',
        `const r = await fetch('http://127.0.0.1:43191/api/mcp/get-source-excerpt', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ${localToken}' },
          body: JSON.stringify({ ref: '${entry!.ref}', max_chars: 2000 }),
        });
        if (!r.ok) throw new Error(String(r.status));
        process.stdout.write(JSON.stringify(await r.json()));`,
      ],
      { timeout: 15_000, encoding: 'utf8' },
    );
    const excerpt = JSON.parse(excerptJson) as { excerpt: string };
    expect(excerpt.excerpt).toContain('用户尚未验收');
  });
});
