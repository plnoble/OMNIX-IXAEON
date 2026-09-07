import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * M2 六类语义场景界面级验收（C12 重写：非空数据 + 真实用户动作 + 跨层断言；
 * RF07 修正：场景名、资料和断言一一对应，两种否决语义分开验证）。
 *
 * - S1「AI 提议但用户没答应」：用户对 AI 建议点【不采纳】——验证“用户否决 AI 建议”。
 * - S2「用户明确否决」：AI 已把否决记录为 rejected_option，用户点【确认正确】
 *   确认“这条理解正确”——验证“否决被正确记住”，与 S1 是两种不同的动作。
 * - S4「不同来源矛盾」：两个真实来源给出相反结论（方案甲 vs 方案乙），
 *   验证双方同时保留、都标冲突、不自动选边。
 *
 * 模型入口：IXAEON_FAKE_MODEL=1 + IXAEON_FAKE_MODEL_SCRIPT 指向预置响应 JSON
 * （生产代码仅在环境变量存在时读取，正常用户运行不构成任意写库入口）。
 * 每个来源一次提取 → 每来源一个完整 { items: [...] } 响应。
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

interface SourceDef {
  /** 来源文件名（不含扩展名）*/
  id: string;
  docLines: string[];
  modelItems: Array<Record<string, unknown>>;
}

interface BriefExpect {
  text: string;
  label?: string;
  absent?: boolean;
}

interface DbExpect {
  statement: string;
  state?: string;
  confirmation?: string;
  needsReview?: boolean;
}

interface ScenarioDef {
  id: string;
  title: string;
  sources: SourceDef[];
  uiAction:
    | { kind: 'confirm' }
    | { kind: 'reject' }
    | { kind: 'correct'; newText: string }
    | { kind: 'none' };
  /** 界面断言关键词（动作后理解页应包含，逐个断言）*/
  uiExpectTexts: string[];
  /** 动作前简报断言（验证操作前状态；不设则跳过）*/
  briefExpectBefore?: BriefExpect[];
  /** 动作后简报断言 */
  briefExpect: BriefExpect[];
  /** 动作后持久化断言（state / confirmation / needs_review）*/
  dbExpect?: DbExpect[];
}

const SCENARIOS: ScenarioDef[] = [
  {
    id: 'S1',
    title: 'AI 提议但用户没答应（用户不采纳 AI 建议）',
    sources: [
      {
        id: 'S1',
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
      },
    ],
    uiAction: { kind: 'reject' },
    uiExpectTexts: ['启用远程项目日志服务', '已不采纳'],
    briefExpectBefore: [{ text: '启用远程项目日志服务', label: '待用户确认' }],
    dbExpect: [{ statement: '启用远程项目日志服务', confirmation: 'rejected' }],
    briefExpect: [{ text: '启用远程项目日志服务集中保存日志', absent: true }],
  },
  {
    id: 'S2',
    title: '用户明确否决（AI 记录正确，用户确认这条理解）',
    sources: [
      {
        id: 'S2',
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
      },
    ],
    uiAction: { kind: 'confirm' },
    uiExpectTexts: ['云同步方案已被用户明确否决', '用户已确认'],
    briefExpectBefore: [{ text: '云同步方案已被用户明确否决', label: '待用户确认' }],
    dbExpect: [{ statement: '云同步方案已被用户明确否决', confirmation: 'confirmed' }],
    briefExpect: [{ text: '云同步方案已被用户明确否决', label: '用户已确认' }],
  },
  {
    id: 'S3',
    title: '用户后来改口',
    sources: [
      {
        id: 'S3',
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
      },
    ],
    uiAction: { kind: 'correct', newText: '改为：第一版同时准备向量检索接口但默认关闭' },
    uiExpectTexts: ['同时准备向量检索接口', '用户确认'],
    briefExpect: [
      { text: '同时准备向量检索接口', label: '用户确认' },
      { text: '第一版采用 SQLite 全文搜索', absent: true },
    ],
    dbExpect: [{ statement: '第一版采用 SQLite 全文搜索', state: 'superseded' }],
  },
  {
    id: 'S4',
    title: '不同来源矛盾（双来源相反结论，双方保留不选边）',
    sources: [
      {
        id: 'S4A',
        docLines: ['用户：桌面端打包框架选择方案甲，继续用现有 Electron 工具链。C12_S4_KEEP'],
        modelItems: [
          {
            type: 'decision',
            statement: '桌面端打包框架选择方案甲',
            rationale: null,
            confidence: 0.9,
            segment_ref: 'S2',
            project_hint: null,
            excerpt: '桌面端打包框架选择方案甲',
          },
        ],
      },
      {
        id: 'S4B',
        docLines: ['用户：桌面端打包框架选择方案乙，改用 Tauri 减小安装包体积。C12_S4_SWITCH'],
        modelItems: [
          {
            type: 'decision',
            statement: '桌面端打包框架选择方案乙',
            rationale: null,
            confidence: 0.88,
            segment_ref: 'S2',
            project_hint: null,
            excerpt: '桌面端打包框架选择方案乙',
          },
        ],
      },
    ],
    uiAction: { kind: 'none' },
    uiExpectTexts: ['桌面端打包框架选择方案甲', '桌面端打包框架选择方案乙', '冲突'],
    briefExpect: [
      { text: '桌面端打包框架选择方案甲', label: '存在冲突' },
      { text: '桌面端打包框架选择方案乙', label: '存在冲突' },
    ],
    // 不自动选边：双方都保留、都是 disputed、都没有被替用户确认或否决
    dbExpect: [
      { statement: '桌面端打包框架选择方案甲', state: 'disputed', confirmation: 'none', needsReview: true },
      { statement: '桌面端打包框架选择方案乙', state: 'disputed', confirmation: 'none', needsReview: true },
    ],
  },
  {
    id: 'S5',
    title: '证据不足',
    sources: [
      {
        id: 'S5',
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
      },
    ],
    uiAction: { kind: 'none' },
    uiExpectTexts: ['性能目标尚未确定'],
    briefExpect: [{ text: '性能目标尚未确定' }],
  },
];

const ALL_SOURCES = SCENARIOS.flatMap((sc) => sc.sources);

test.describe('M2 六类语义场景界面级验收（C12 + RF07）', () => {
  let app: ElectronApplication;
  let page: Page;
  let dataDir: string;

  /** 经真实本地 HTTP 端点取项目简报（跨层断言用）。 */
  const fetchBrief = async (task: string) => {
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
          body: JSON.stringify({ project_ref: '${projectId}', task: '${task}', max_chars: 12000 }),
        });
        if (!r.ok) throw new Error(String(r.status) + await r.text());
        process.stdout.write(JSON.stringify(await r.json()));`,
      ],
      { timeout: 15_000, encoding: 'utf8' },
    );
    return JSON.parse(briefJson) as {
      decisions: Array<{ text: string }>;
      rejected_options: Array<{ text: string }>;
      open_loops: Array<{ text: string }>;
      risks: Array<{ text: string }>;
    };
  };

  const assertBrief = (
    brief: Awaited<ReturnType<typeof fetchBrief>>,
    expects: BriefExpect[],
    phase: string,
  ) => {
    const briefText = JSON.stringify([
      ...brief.decisions,
      ...brief.rejected_options,
      ...brief.open_loops,
      ...brief.risks,
    ]);
    for (const exp of expects) {
      if (exp.absent) {
        expect(briefText.includes(exp.text), `${phase}简报不应包含「${exp.text}」`).toBe(false);
      } else {
        expect(briefText.includes(exp.text), `${phase}简报应包含「${exp.text}」`).toBe(true);
        if (exp.label) {
          const entry = [
            ...brief.decisions,
            ...brief.rejected_options,
            ...brief.open_loops,
            ...brief.risks,
          ].find((e) => e.text.includes(exp.text));
          expect(
            entry?.text.includes(exp.label),
            `${phase}简报条目应带「${exp.label}」标注，实际：${entry?.text}`,
          ).toBe(true);
        }
      }
    }
  };

  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ixaeon-c12-'));
    for (const src of ALL_SOURCES) {
      writeFileSync(
        join(dataDir, `${src.id}.md`),
        `# 场景${src.id}\n\n${src.docLines.join('\n\n')}\n`,
        'utf8',
      );
    }
    const scriptPath = join(dataDir, 'model-script.json');
    writeFileSync(
      scriptPath,
      JSON.stringify({
        // FakeProvider 每次消费一个 { items: [...] } 完整响应；
        // 每个来源一次提取 → 每来源一个响应（含该来源全部条目）
        structured: ALL_SOURCES.map((src) => ({ items: src.modelItems })),
        text: ['（合成回答）待确认事项已列出。'],
      }),
      'utf8',
    );

    process.env.IXAEON_TEST_DIALOG_RESPONSES = `documents|${ALL_SOURCES.map(
      (src) => join(dataDir, `${src.id}.md`),
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
    await expect(page.locator('tbody tr')).toHaveCount(ALL_SOURCES.length, { timeout: 20_000 });
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
      if (jobs.length >= ALL_SOURCES.length && pending === 0) {
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
      // 1) 非空前提：本场景每条条目在数据库中实际存在
      for (const src of sc.sources) {
        for (const modelItem of src.modelItems) {
          const items = await page.evaluate(async (keyword) => {
            if (!window.ixaeon) throw new Error('preload API 未就绪');
            const list = await window.ixaeon.listItems({ projectId: null });
            return list.filter((i) => i.statement.includes(keyword));
          }, modelItem.statement as string);
          expect(
            items.length,
            `${sc.id}/${src.id} 条目必须存在（非空验证）：${String(modelItem.statement)}`,
          ).toBeGreaterThan(0);
        }
      }

      // 2) 动作前状态（RF07：确认/不采纳流程验证操作前后变化）
      if (sc.briefExpectBefore) {
        const before = await fetchBrief(`C12 ${sc.id} before`);
        assertBrief(before, sc.briefExpectBefore, `${sc.id} 动作前`);
      }

      // 3) 真实界面操作
      const firstStatement = sc.sources[0]!.modelItems[0]!.statement as string;
      if (sc.uiAction.kind === 'confirm' || sc.uiAction.kind === 'reject') {
        await page.getByTestId('nav-inbox').click();
        const row = page.locator('.project-row', { hasText: firstStatement });
        await expect(row).toBeVisible();
        if (sc.uiAction.kind === 'confirm') {
          await row.getByRole('button', { name: '确认正确' }).click();
        } else {
          await row.getByRole('button', { name: '不采纳' }).click();
        }
        await page.waitForTimeout(500);
      } else if (sc.uiAction.kind === 'correct') {
        await page.getByTestId('nav-understanding').click();
        const row = page.locator('.item-row', { hasText: firstStatement });
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: '纠正' }).click();
        await page.getByTestId('correction-input').fill(sc.uiAction.newText);
        await page.getByTestId('correction-preview').click();
        await page.getByTestId('correction-confirm').click();
        await page.waitForTimeout(500);
      }

      // 4) 界面断言（动作后的理解页状态；逐关键词断言，等待列表加载完成）
      await page.getByTestId('nav-understanding').click();
      for (const text of sc.uiExpectTexts) {
        await expect
          .poll(
            async () => {
              const body = await page.textContent('[data-testid="page-understanding"]');
              return body ?? '';
            },
            { timeout: 10_000 },
          )
          .toContain(text);
      }

      // 5) 持久化断言（RF07：动作后的真实落库状态）
      if (sc.dbExpect) {
        const allItems = await page.evaluate(async () => {
          if (!window.ixaeon) throw new Error('preload API 未就绪');
          return window.ixaeon.listItems({ projectId: null });
        });
        for (const exp of sc.dbExpect) {
          const hit = allItems.filter((i) => i.statement.includes(exp.statement));
          expect(hit.length, `${sc.id} 持久化条目应存在：${exp.statement}`).toBeGreaterThan(0);
          for (const item of hit) {
            if (exp.state) {
              expect(item.state, `${sc.id}「${exp.statement}」state 应为 ${exp.state}`).toBe(exp.state);
            }
            if (exp.confirmation) {
              expect(
                item.confirmation,
                `${sc.id}「${exp.statement}」confirmation 应为 ${exp.confirmation}`,
              ).toBe(exp.confirmation);
            }
            if (exp.needsReview !== undefined) {
              expect(
                item.needs_review,
                `${sc.id}「${exp.statement}」needs_review 应为 ${exp.needsReview}`,
              ).toBe(exp.needsReview);
            }
          }
        }
      }

      // 6) MCP 简报跨层断言（动作后）
      const brief = await fetchBrief(`C12 ${sc.id}`);
      assertBrief(brief, sc.briefExpect, `${sc.id} 动作后`);
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
