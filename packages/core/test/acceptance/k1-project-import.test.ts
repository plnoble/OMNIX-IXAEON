/**
 * K1 验收（规格 docs/委派/K1-项目清单导入.md，A 档：测试和实现一起交）。
 *
 * 条件 1：库里 A=active、B=paused；清单 A→archived、B 不变、C 新增 →
 *          预览「新增 1、变化 1、不变 1、无效 0」；确认前数据库不变。
 * 条件 2：确认后 C 已新建且状态对；A 是 archived；B 不变。
 * 条件 3：无效条目（status 不合法、name 为空、清单内 name 重复）进「无效」并给原因；其他条目照常导入。
 * 条件 4：同一份清单再导入一次 → 全部「不变」（幂等）。
 * 条件 5：库里有、清单里没有的 D → 导入前后完全一致。
 * 条件 6：导入后没有任何新的 `project_snapshot` 来源。
 * 条件 7：库里已有两个都叫 E 的项目，清单里有 E → E 进「无效」、原因写同名；两个 E 都不变。
 * 条件 8：清单里已有项目的 `description` 和库里不同 → 库里的 `description` 不变。
 *
 * 条件 7 的「库里两个同名项目」：`projects.name` 建表就是 UNIQUE（区分大小写），
 * 完全同名的两行正常进不去；但 `E` / `e` 这种大小写不同的历史数据能并存，`lower(name)` 查出来就是两行。
 * 这一条用真库直接插第二行来测同一个分支（两个 E 都不变）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProjectImport,
  migrate,
  openDatabase,
  planProjectImport,
  ProjectService,
  type CoreDatabase,
} from '../../src/index.js';
import type { Project, ProjectImportPlan } from '@ixaeon/contracts';

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-k1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  projects = new ProjectService(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关 */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 建一个项目；status 不是 active 时照界面那条路再改状态。 */
function add(
  name: string,
  status: Project['status'] = 'active',
  patch: { rootPath?: string | null; description?: string | null } = {},
): Project {
  const p = projects.create({
    name,
    rootPath: patch.rootPath ?? null,
    description: patch.description ?? null,
  });
  return status === 'active' ? p : projects.updateStatus(p.id, status);
}

/** 库里全部项目，按名字排；用来比「完全一致」。 */
function snapshot(): Project[] {
  return [...projects.list()].sort((a, b) => a.name.localeCompare(b.name));
}

function counts(plan: ProjectImportPlan): {
  create: number;
  update: number;
  unchanged: number;
  invalid: number;
} {
  return {
    create: plan.create.length,
    update: plan.update.length,
    unchanged: plan.unchanged.length,
    invalid: plan.invalid.length,
  };
}

/** 条件 1 用的合成清单（A 改 archived、B 不变、C 新增）。 */
const listABC = {
  version: 1,
  projects: [
    { name: 'A', status: 'archived' },
    { name: 'B', status: 'paused' },
    { name: 'C', status: 'active' },
  ],
};

describe('K1 从清单批量登记项目和状态', () => {
  it('条件 1：预览给出新增 1、变化 1、不变 1、无效 0，确认前数据库不变', () => {
    const a = add('A', 'active');
    const b = add('B', 'paused');
    const before = snapshot();

    const plan = planProjectImport(db, listABC);
    expect(counts(plan)).toEqual({ create: 1, update: 1, unchanged: 1, invalid: 0 });
    expect(plan.create.map((e) => e.name)).toEqual(['C']);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.project.id).toBe(a.id);
    expect(plan.update[0]!.status).toBe('archived');
    expect(plan.unchanged.map((p) => p.id)).toEqual([b.id]);
    expect(plan.invalid).toEqual([]);

    // 只算了，没有写：A 还是 active，C 还没出现，updated_at 也没动
    expect(snapshot()).toEqual(before);
  });

  it('条件 2：确认后 C 新建且状态对、A 是 archived、B 不变', () => {
    const a = add('A', 'active');
    const b = add('B', 'paused');
    const plan = planProjectImport(db, listABC);

    expect(applyProjectImport(db, plan)).toEqual({ created: 1, updated: 1 });

    const rows = projects.list();
    const byName = new Map(rows.map((p) => [p.name, p]));
    const c = byName.get('C');
    expect(c).toBeDefined();
    expect(c!.status).toBe('active');
    expect(byName.get('A')!.status).toBe('archived');
    expect(byName.get('A')!.id).toBe(a.id);
    expect(byName.get('B')!.status).toBe('paused');
    expect(byName.get('B')!.id).toBe(b.id);
  });

  it('新建项目按清单设成 paused / archived（create 默认 active 之外，条件 2 的「状态对」）', () => {
    const plan = planProjectImport(db, {
      version: 1,
      projects: [
        { name: '新暂停项目', status: 'paused' },
        { name: '新归档项目', status: 'archived' },
      ],
    });
    expect(plan.create.map((e) => e.name)).toEqual(['新暂停项目', '新归档项目']);

    expect(applyProjectImport(db, plan)).toEqual({ created: 2, updated: 0 });
    const byName = new Map(projects.list().map((p) => [p.name, p.status]));
    expect(byName.get('新暂停项目')).toBe('paused');
    expect(byName.get('新归档项目')).toBe('archived');
  });

  it('条件 3：无效条目进「无效」并给原因，其他条目照常导入', () => {
    const plan = planProjectImport(db, {
      version: 1,
      projects: [
        { name: '好项目', status: 'active' },
        { name: '坏状态', status: 'done' },
        { name: '   ', status: 'active' },
        { name: '好项目', status: 'paused' },
      ],
    });

    expect(counts(plan)).toEqual({ create: 1, update: 0, unchanged: 0, invalid: 3 });
    expect(plan.create.map((e) => e.name)).toEqual(['好项目']);
    expect(plan.invalid.map((v) => v.index)).toEqual([1, 2, 3]);
    expect(plan.invalid[0]!.name).toBe('坏状态');
    expect(plan.invalid[1]!.reason).toContain('空');
    expect(plan.invalid[2]!.name).toBe('好项目');
    expect(plan.invalid[2]!.reason).toContain('重复');
    expect(plan.invalid[0]!.reason).toContain('status');

    expect(applyProjectImport(db, plan)).toEqual({ created: 1, updated: 0 });
    const names = projects.list().map((p) => p.name);
    expect(names).toEqual(['好项目']);
  });

  it('条件 4：同一份清单再导入一次 → 全部「不变」', () => {
    add('A', 'active');
    add('B', 'paused');
    applyProjectImport(db, planProjectImport(db, listABC));

    const again = planProjectImport(db, listABC);
    expect(counts(again)).toEqual({ create: 0, update: 0, unchanged: 3, invalid: 0 });
    expect(again.unchanged.map((p) => p.name).sort()).toEqual(['A', 'B', 'C']);
    expect(applyProjectImport(db, again)).toEqual({ created: 0, updated: 0 });
  });

  it('条件 5：库里有、清单里没有的 D 导入前后完全一致', () => {
    add('A', 'active');
    add('B', 'paused');
    const d = add('D', 'paused', { description: 'D 的说明' });
    const before = projects.get(d.id);

    applyProjectImport(db, planProjectImport(db, listABC));

    expect(projects.get(d.id)).toEqual(before);
    expect(snapshot().map((p) => p.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('条件 6：导入后没有任何新的 project_snapshot 来源', () => {
    add('A', 'active');
    add('B', 'paused');
    const count = (): number =>
      (
        db.prepare("SELECT count(*) AS c FROM sources WHERE kind = 'project_snapshot'").get() as {
          c: number;
        }
      ).c;
    expect(count()).toBe(0);

    applyProjectImport(db, planProjectImport(db, listABC));

    expect(count()).toBe(0);
  });

  it('条件 7：库里两个同名 E（E / e）→ E 进「无效」、原因写同名，两个 E 都不变', () => {
    const made = add('E', 'active');
    // 真库第二行：SQLite 的 UNIQUE 区分大小写，`E` / `e` 能并存（早年数据可能是这样）。
    db.prepare(
      `INSERT INTO projects (id, name, root_path, description, status, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'paused', ?, ?)`,
    ).run(randomUUID(), 'e', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z');
    const before = snapshot();

    const plan = planProjectImport(db, {
      version: 1,
      projects: [{ name: 'E', status: 'paused' }],
    });

    expect(plan.invalid).toHaveLength(1);
    expect(plan.invalid[0]!.index).toBe(0);
    expect(plan.invalid[0]!.name).toBe('E');
    expect(plan.invalid[0]!.reason).toContain('同名');
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual([]);
    // 两行都没被动过
    expect(snapshot()).toEqual(before);
    expect(projects.get(made.id)).toEqual(made);
  });

  it('条件 8：清单里的 description 和库里不同 → 库里的 description 不变', () => {
    const a = add('A', 'active', { description: '库里的 A 说明' });
    const b = add('B', 'paused', { description: '库里的 B 说明' });
    const plan = planProjectImport(db, {
      version: 1,
      projects: [
        // A 状态变化（update 路径），B 不变（unchanged 路径）
        { name: 'A', status: 'archived', description: '清单里的 A 说明' },
        { name: 'B', status: 'paused', description: '清单里的 B 说明' },
      ],
    });
    expect(counts(plan)).toEqual({ create: 0, update: 1, unchanged: 1, invalid: 0 });

    applyProjectImport(db, plan);

    expect(projects.get(a.id)!.description).toBe('库里的 A 说明');
    expect(projects.get(b.id)!.description).toBe('库里的 B 说明');
    expect(projects.get(a.id)!.status).toBe('archived');
  });

  it('清单条目的未知字段丢弃，不入库', () => {
    const plan = planProjectImport(db, {
      version: 1,
      projects: [{ name: '未知字段项目', status: 'active', extra: '不要' }],
    });
    expect(plan.create).toHaveLength(1);
    expect('extra' in plan.create[0]!).toBe(false);
  });
});
