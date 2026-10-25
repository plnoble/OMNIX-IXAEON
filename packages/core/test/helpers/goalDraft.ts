import { readFileSync } from 'node:fs';
import { migrate, type CoreDatabase } from '../../src/index.js';

/** 仅限开发用临时库：加载既有草案 SQL，不登记/发布迁移，不替代迁移验收。 */
export function loadGoalDraft(db: CoreDatabase, tables = ['goals', 'goal_events']): void {
  migrate(db);
  const draft = readFileSync(
    new URL('../../../../docs/委派/G1-GoalEngine-草案.md', import.meta.url),
    'utf8',
  );
  const blocks = [...draft.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
  for (const table of tables) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    // 草案里的 SQL 块常以注释开头，所以按建表语句本身定位，切到该语句结尾的 `);`
    const block = blocks.find((sql) => sql.includes(`CREATE TABLE ${table} (`));
    const start = block?.indexOf(`CREATE TABLE ${table} (`) ?? -1;
    const end = start < 0 ? -1 : block!.indexOf('\n);', start);
    if (!block || start < 0 || end < 0) throw new Error(`草案缺少 ${table} SQL`);
    db.exec(block.slice(start, end + 3));
  }
}
