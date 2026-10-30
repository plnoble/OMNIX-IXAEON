import {
  ErrorCodes,
  IxaError,
  projectImportEntrySchema,
  type Project,
  type ProjectImportEntry,
  type ProjectImportPlan,
  type ProjectStatus,
} from '@ixaeon/contracts';
import type { CoreDatabase } from './db/database.js';
import { ProjectService } from './projects.js';

/**
 * K1：从清单批量登记项目和状态（规格 docs/委派/K1-项目清单导入.md）。
 *
 * - `planProjectImport` 只算、不写库：已有项目按 name（大小写不敏感，和 ProjectService 一致）匹配；
 *   只有状态不同才算「变化」；同名项目在库里不止一个、清单内重名、条目格式不合法都进「无效」。
 * - `applyProjectImport` 只用 ProjectService 的 `createMany` / `updateStatus`；已有项目只改 status，
 *   `root_path` / `description` 一律不动。`root_path` 只登记，不读目录，不产生 `project_snapshot` 来源。
 * - 清单里的 `note` 只给预览看，不进库。
 */

/** 条目本身不合法时的人话原因；合法返回 null。 */
function entryProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '条目不是对象';
  const parsed = projectImportEntrySchema.safeParse(raw);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  const value = (raw as Record<string, unknown>)[String(field)];
  if (field === 'name') {
    if (typeof value !== 'string') return '项目名必须是字符串';
    if (value.trim().length === 0) return '项目名不能为空';
    return '项目名不能超过 80 字';
  }
  if (field === 'status') return 'status 不合法（只能是 active / paused / archived）';
  if (field === 'root_path') return 'root_path 必须是字符串';
  if (field === 'description') return 'description 必须是字符串';
  if (field === 'note') return 'note 必须是字符串';
  return issue?.message ?? '条目格式不合法';
}

/** 清单整体（version / projects）不合法就整份拒绝；条目级的错留给 invalid。 */
function rawEntries(list: unknown): unknown[] {
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, '清单必须是 { version: 1, projects: [...] }');
  }
  const l = list as { version?: unknown; projects?: unknown };
  if (l.version !== 1) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '清单版本必须是 1');
  if (!Array.isArray(l.projects)) {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, '清单的 projects 必须是数组');
  }
  return l.projects;
}

/** 库里同名项目的行（大小写不敏感，和 ProjectService.create 的判重一致）。 */
function sameNameRows(db: CoreDatabase, name: string): Project[] {
  return db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?)').all(name) as Project[];
}

/** 同一个目录是否已经登记给别的（未归档的）项目；照 ProjectService.create 的那条检查。 */
function rootOwner(db: CoreDatabase, rootPath: string): { name: string } | undefined {
  return db
    .prepare(
      "SELECT name FROM projects WHERE root_path IS NOT NULL AND lower(root_path) = lower(?) AND status != 'archived'",
    )
    .get(rootPath) as { name: string } | undefined;
}

export function planProjectImport(db: CoreDatabase, list: unknown): ProjectImportPlan {
  const raw = rawEntries(list);
  const plan: ProjectImportPlan = { create: [], update: [], unchanged: [], invalid: [] };
  /** 清单内已经收下的名字（大小写不敏感）；后来重名的进无效。 */
  const seen = new Map<string, number>();
  /** 清单内已经收下的新目录；同一个目录的两条新项目只能留一条。 */
  const plannedRoots = new Map<string, number>();

  raw.forEach((item, index) => {
    const nameOf = (v: unknown): string | undefined =>
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as { name?: unknown }).name === 'string'
        ? (v as { name: string }).name
        : undefined;
    const problem = entryProblem(item);
    if (problem) {
      plan.invalid.push({
        index,
        ...(nameOf(item) ? { name: nameOf(item) } : {}),
        reason: problem,
      });
      return;
    }
    const entry = projectImportEntrySchema.parse(item) as ProjectImportEntry;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      plan.invalid.push({
        index,
        name: entry.name,
        reason: `清单内项目名重复（第 ${seen.get(key)! + 1} 条已经用过）`,
      });
      return;
    }

    const rows = sameNameRows(db, entry.name);
    if (rows.length > 1) {
      plan.invalid.push({
        index,
        name: entry.name,
        reason: `库里有 ${rows.length} 个同名项目，不猜是哪个`,
      });
      return;
    }
    if (rows.length === 1) {
      const project = rows[0]!;
      if (project.status === entry.status) plan.unchanged.push(project);
      else plan.update.push({ project, status: entry.status });
      return;
    }

    if (entry.root_path) {
      const owner = rootOwner(db, entry.root_path);
      if (owner) {
        plan.invalid.push({
          index,
          name: entry.name,
          reason: `该目录已登记为项目「${owner.name}」，不凭同名或路径自动合并`,
        });
        return;
      }
      const rootKey = entry.root_path.toLowerCase();
      if (plannedRoots.has(rootKey)) {
        plan.invalid.push({
          index,
          name: entry.name,
          reason: `清单内项目目录重复（第 ${plannedRoots.get(rootKey)! + 1} 条已经用过）`,
        });
        return;
      }
      plannedRoots.set(rootKey, index);
    }
    // 只有真正收下的条目才记名字：前面因为目录冲突被拒的同名条目，不该让后来这条变成「重复」。
    seen.set(key, index);
    plan.create.push(entry);
  });

  return plan;
}

export function applyProjectImport(
  db: CoreDatabase,
  plan: ProjectImportPlan,
): { created: number; updated: number } {
  const service = new ProjectService(db);
  let created = 0;
  let updated = 0;
  const run = db.transaction(() => {
    const made = service.createMany(
      plan.create.map((entry) => ({
        name: entry.name,
        rootPath: entry.root_path ?? null,
        description: entry.description ?? null,
      })),
    );
    created = made.length;
    // create() 只会建出 active；清单要 paused / archived 的再改状态。
    made.forEach((project, i) => {
      const target = plan.create[i]!.status as ProjectStatus;
      if (project.status !== target) service.updateStatus(project.id, target);
    });
    for (const item of plan.update) {
      if (item.project.status === item.status) continue;
      service.updateStatus(item.project.id, item.status);
      updated += 1;
    }
  });
  run();
  return { created, updated };
}
