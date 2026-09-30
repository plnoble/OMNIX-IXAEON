/**
 * D1 补充回归（非锁定）：范围写法的规范化。
 * `src/`、`./src` 与 `src` 是同一个范围；改动 `src/hello.txt` 在其中，
 * 不该因写法差异被误报「改动超出批准范围」。（Codex 实现审查 2026-09-28 提出）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodingTaskStore,
  ProjectService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('范围写法规范化', () => {
  const cases: Array<[string, string]> = [
    ['src', 'src'],
    ['src/', 'src'],
    ['./src', 'src'],
    ['src/.', 'src'],
    ['././src', 'src'],
    ['.', '.'],
    ['./', '.'],
  ];
  for (const [scope, label] of cases) {
    it(`范围写成「${scope}」：${label === '.' ? '整个项目' : 'src/hello.txt'} 不算越界`, () => {
      dir = mkdtempSync(join(tmpdir(), 'ixa-d1-scope-'));
      db = openDatabase(join(dir, 'ixaeon.db'));
      migrate(db);
      const store = new CodingTaskStore(db);
      const project = new ProjectService(db).create({
        name: '合成项目',
        rootPath: join(dir, 'proj'),
        description: null,
      });
      const task = store.create({
        projectId: project.id,
        goal: '加文件',
        scope: [scope],
        allowedCommands: [],
      });
      db.prepare('UPDATE coding_tasks SET workspace_path = ? WHERE id = ?').run(
        join(dir, 'ws'),
        task.id,
      );
      const stored = store.get(task.id);
      if (label === '.') {
        // 整个项目：根下与子目录里的改动都不算越界
        expect(() => store.assertChangedPathsInScope(stored, ['hello.txt'])).not.toThrow();
        expect(() => store.assertChangedPathsInScope(stored, ['src/hello.txt'])).not.toThrow();
        expect(() => store.assertChangedPathsInScope(stored, ['other/x.txt'])).not.toThrow();
      } else {
        expect(() => store.assertChangedPathsInScope(stored, ['src/hello.txt'])).not.toThrow();
        expect(() => store.assertChangedPathsInScope(stored, ['./src/hello.txt'])).not.toThrow();
        expect(() => store.assertChangedPathsInScope(stored, ['other/x.txt'])).toThrow(
          /超出批准范围/,
        );
      }
    });
  }
});
