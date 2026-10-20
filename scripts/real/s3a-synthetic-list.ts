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

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
const maskOut = (v: unknown): string => {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

// 结论由脚本自己算出来的值决定：一处不符就不写「通过」；脚本出错也非零退出
let passed = true;
let firstFail = '';
const fail = (why: string): void => {
  console.log('不符：', why);
  if (passed) firstFail = why;
  passed = false;
};
const crash = (err: unknown): void => {
  console.log('脚本出错：', err);
  console.log('RESULT 没通过：脚本出错：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

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
if (preview.sessions.length !== 1)
  fail(`认得出的会话数不对（期望 1 个 claude_code 会话，实际 ${preview.sessions.length} 个）`);
if (preview.unrecognizedCount !== 1)
  fail(`认不出的文件数不对（期望 1 个，实际 ${preview.unrecognizedCount} 个）`);
const listed = preview.sessions[0];
if (listed && (listed.id !== 1 || listed.tool !== 'claude_code'))
  fail(
    `编号或识别不对（期望编号 1、识别成 claude_code，实际编号 ${listed.id}、识别成 ${listed.tool}）`,
  );
const ids = preview.sessions.map((s) => s.id);
console.log(
  '估算：',
  JSON.stringify(imports.estimateAgentSessions(folder, ids, preview.sessions), null, 2),
);
const estimate = imports.estimateAgentSessions(folder, ids, preview.sessions);
if (estimate.items.length !== 1 || estimate.items[0]?.id !== 1)
  fail(`估算的条目不对（期望 1 条、编号 1，实际 ${estimate.items.length} 条）`);
if (estimate.userChars !== 7 || estimate.assistantChars !== 4)
  fail(
    `字数统计不对（期望用户 7 字、助手 4 字，实际用户 ${estimate.userChars} 字、助手 ${estimate.assistantChars} 字）`,
  );
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  'RESULT',
  passed
    ? '通过：列出 1 个 claude_code 会话（编号 1）+ 1 个认不出的文件，估算 1 条：用户 7 字、助手 4 字'
    : `没通过：${firstFail}`,
);
process.exit(passed ? 0 : 1);
