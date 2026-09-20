/**
 * S3a 真机检查（合成数据）：临时数据目录里放一个合成的 Claude Code 会话
 * 和一个认不出的文件，走「列出 → 估算」两步，确认编号、识别与字数统计。
 * 没有对用户真实会话文件夹调列出（标题就是内容）。
 *   node_modules/.bin/jiti scripts/real/s3a-synthetic-list.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ImportService,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
} from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-s3a-real-'));
const folder = join(dir, 's');
mkdirSync(folder, { recursive: true });
const L = (o: unknown) => JSON.stringify(o);
const seg = (type: 'user' | 'assistant', content: unknown) =>
  L({
    sessionId: '11111111-2222-4333-8444-999999999999',
    cwd: 'D:/work/demo',
    isSidechain: false,
    type,
    timestamp: '2026-09-19T01:00:01.000Z',
    message: { role: type, content },
  });
writeFileSync(
  join(folder, 'cc.jsonl'),
  `${seg('user', '帮我把导入修好')}\n${seg('assistant', [{ type: 'text', text: '改好了。' }])}`,
  'utf8',
);
writeFileSync(join(folder, 'noise.jsonl'), L({ hello: 'world' }), 'utf8');
const db = openDatabase(join(dir, 'ixaeon.db'));
migrate(db);
const imports = new ImportService(
  db,
  new Vault(join(dir, 'v')),
  new PermissionService(db),
  new SourceStore(db),
);
const preview = imports.previewAgentSessions(folder);
console.log('列出：', JSON.stringify(preview, null, 2));
const ids = preview.sessions.map((s) => s.id);
console.log(
  '估算：',
  JSON.stringify(imports.estimateAgentSessions(folder, ids, preview.sessions), null, 2),
);
db.close();
rmSync(dir, { recursive: true, force: true });
