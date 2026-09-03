import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from './db/database.js';
import type { Project } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

export class ProjectService {
  constructor(private readonly db: CoreDatabase) {}

  create(input: { name: string; rootPath: string | null; description: string | null }): Project {
    const name = input.name.trim();
    if (name.length === 0) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '项目名不能为空');
    const existing = this.db
      .prepare('SELECT id FROM projects WHERE lower(name) = lower(?)')
      .get(name) as { id: string } | undefined;
    if (existing) {
      throw new IxaError(ErrorCodes.CONFLICT, `已存在同名项目: ${name}`);
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
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.root_path,
        project.description,
        project.status,
        project.created_at,
        project.updated_at,
      );
    return project;
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
