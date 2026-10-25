import { readFileSync } from 'node:fs';
import { migrate, type CoreDatabase } from '../../src/index.js';

/** 仅限开发用临时库：加载既有草案 SQL，不登记/发布迁移，不替代迁移验收。 */
export function loadGoalDraft(db: CoreDatabase): void {
  migrate(db);
  const draft = readFileSync(
    new URL('../../../../docs/委派/G1-GoalEngine-草案.md', import.meta.url),
    'utf8',
  );
  const blocks = [...draft.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
  for (const table of ['goals', 'goal_events']) {
    const block = blocks.find((sql) => sql.startsWith(`CREATE TABLE ${table} (`));
    if (!block) throw new Error(`草案缺少 ${table} SQL`);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      db.exec(block);
  }
}
