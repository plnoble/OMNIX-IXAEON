import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from './db/database.js';
import type { Project } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

export class ProjectService {
  constructor(private readonly db: CoreDatabase) {}

  create(input: {
    name: string;
    rootPath: string | null;
    description: string | null;
    purpose?: string | null;
    currentState?: string | null;
    primaryIo?: string | null;
    capabilities?: string | null;
    relatedGoals?: string | null;
    unknowns?: string | null;
  }): Project {
    const name = input.name.trim();
    if (name.length === 0) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '项目名不能为空');
    const existing = this.db
      .prepare('SELECT id FROM projects WHERE lower(name) = lower(?)')
      .get(name) as { id: string } | undefined;
    if (existing) {
      throw new IxaError(ErrorCodes.CONFLICT, `已存在同名项目: ${name}`);
    }
    if (input.rootPath) {
      const sameRoot = this.db
        .prepare(
          "SELECT id, name FROM projects WHERE root_path IS NOT NULL AND lower(root_path) = lower(?) AND status != 'archived'",
        )
        .get(input.rootPath) as { id: string; name: string } | undefined;
      if (sameRoot) {
        throw new IxaError(
          ErrorCodes.CONFLICT,
          `该目录已登记为项目「${sameRoot.name}」，不凭同名或路径自动合并`,
        );
      }
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      root_path: input.rootPath,
      description: input.description,
      status: 'active',
      created_at: now,
      updated_at: now,
      purpose: input.purpose ?? null,
      current_state: input.currentState ?? null,
      primary_io: input.primaryIo ?? null,
      capabilities: input.capabilities ?? null,
      related_goals: input.relatedGoals ?? null,
      unknowns: input.unknowns ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, description, status, created_at, updated_at,
           purpose, current_state, primary_io, capabilities, related_goals, unknowns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.root_path,
        project.description,
        project.status,
        project.created_at,
        project.updated_at,
        project.purpose ?? null,
        project.current_state ?? null,
        project.primary_io ?? null,
        project.capabilities ?? null,
        project.related_goals ?? null,
        project.unknowns ?? null,
      );
    return project;
  }

  /**
   * 一次登记多个项目（各自根目录与授权由调用方分别传入）。
   * 构想可以没有目录。导入授权仍只读，不授予执行权。
   */
  createMany(
    inputs: Array<{
      name: string;
      rootPath: string | null;
      description: string | null;
      purpose?: string | null;
      currentState?: string | null;
      primaryIo?: string | null;
      capabilities?: string | null;
      relatedGoals?: string | null;
      unknowns?: string | null;
    }>,
  ): Project[] {
    return inputs.map((input) => this.create(input));
  }

  /** 目录搬迁/重命名后确认身份关联：不凭同名合并。 */
  rebindRoot(id: string, newRootPath: string | null): Project {
    const project = this.get(id);
    if (!project) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${id}`);
    this.db
      .prepare('UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?')
      .run(newRootPath, new Date().toISOString(), id);
    return this.get(id) as Project;
  }

  list(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Project[];
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      Project | undefined;
    return row ?? null;
  }

  updateStatus(id: string, status: Project['status']): Project {
    const project = this.get(id);
    if (!project) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${id}`);
    this.db
      .prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    return this.get(id) as Project;
  }

  /** 项目关联的来源数 / 结论数（项目卡概览用）。 */
  stats(id: string): { sources: number; items: number; workRuns: number } {
    const sources = (
      this.db.prepare('SELECT count(*) AS c FROM sources WHERE project_id = ?').get(id) as {
        c: number;
      }
    ).c;
    const items = (
      this.db
        .prepare("SELECT count(*) AS c FROM items WHERE project_id = ? AND state != 'superseded'")
        .get(id) as { c: number }
    ).c;
    const workRuns = (
      this.db.prepare('SELECT count(*) AS c FROM work_runs WHERE project_id = ?').get(id) as {
        c: number;
      }
    ).c;
    return { sources, items, workRuns };
  }
}
