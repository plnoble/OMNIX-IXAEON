# S3a 编码代理会话选择导入（核心） 交付

- 分支：grok/S3a，基于 main 188bbe1；档位 B
- 执行方：Grok
- 历史：第一版只交测试（远程 d976bd0）；整合方 2026-09-19 补全两处测弱的条件并重锁（main 846b9a4）后，本版交实现。

## 已实现

核心层 `ImportService` 三个方法（列出 / 估算 / 选择导入）+ 主进程内存清单（30 分钟过期）+ IPC 三个通道（contracts / 主进程 / preload）。列出只读每个 `.jsonl` 的**开头（≤20 个非空行且 ≤256KB）和末尾 256KB**，不整份读（条件 7 的字节计数由锁定测试用包一层 `node:fs` 的桩验证）。估算与导入复用 S1/S2 的解析器，不另写一套；解析规则没改。

改动（`git diff --stat origin/main...HEAD`）：

```
 apps/desktop/src/main/appRuntime.ts       |  58 +++++++++
 apps/desktop/src/main/ipc.ts              |   9 ++
 apps/desktop/src/preload/index.ts         |   3 +
 packages/contracts/src/ipc.ts             |  26 ++++
 packages/core/src/import/importService.ts | 173 ++++++++++++++++++++++++++++++
 packages/core/src/index.ts                |   7 +-
 6 files changed, 275 insertions(+), 1 deletion(-)
```

与规格不一样的地方：`estimateAgentSessions` / `importSelectedAgentSessions` 多了可选的末参 `listed`（内存清单里的会话）。原因：主进程估算/导入必须用列出那次拿到的清单（编号→路径），不能重扫——重扫会因新文件让编号错位；锁定测试的三参形式不变。

## 验收测试

测试由整合方 2026-09-19 补全并重锁，本交付**未改测试一行**（verify 的 acceptance-lock 核对通过）。

- `packages/core/test/acceptance/s3a-agent-session-select.test.ts`：条件 1（列 3 个，子代理/认不出只报数）、2（标题规则）、3（已导入/有更新）、4（只导勾选、计数、进 pendingExtraction）、6（估算字数=解析器两角色之和）、7（大文件只读头尾，读字节 <1MB，中间改名不进标题）
- `apps/desktop/test/acceptance/s3a-ipc-list.test.ts`：条件 5（编造清单号 / 编号不在清单（混着合法的也整批拒）/ 30 分钟过期 → `VALIDATION_FAILED` 什么都不导；对照：重列后能估算能导入）

## 自动化通过

- `node scripts/acceptance.mjs run S3a`：7/7 通过
- `node scripts/verify.mjs`：全部通过（lint、format、typecheck、unit 66、integration 480 通过 12 跳过、acceptance-lock 18 个锁定测试未改、acceptance 69、build、review 各轮、真实 Electron UI 各组）
- GitHub 上的 verify：推送后看，结论补记在「已知缺口」下

## 真机通过

1. `node_modules/.bin/jiti scripts/real/agent-sessions.ts`（改了会话导入必跑；确认解析器没退化）：

```
== Claude Code ==
{ "文件": 13, "认不出": 0, "子代理跳过": 0, "没有对话": 0, "会话": 13, "段": 1051,
  "用户段": 531, "用户字数": 106805, "回答字数": 1117232, "最慢": { "秒": 0.1, "MB": 41 } }
「用户」段的开头类别：  530 普通 / 1 以 [ 开头

== Codex ==
{ "文件": 315, "认不出": 0, "子代理跳过": 268, "没有对话": 0, "会话": 47, "段": 570,
  "用户段": 291, "用户字数": 176836, "回答字数": 1153797, "最慢": { "秒": 3, "MB": 1551 } }
「用户」段的开头类别：  283 普通 / 7 以 [ 开头 / 1 以 <user_action> 开头
```

2. 合成会话文件夹的列出与估算（临时数据目录；**没有对用户真实会话文件夹调列出**——标题就是内容）。检查脚本 2026-09-20 补提交到 `scripts/real/s3a-synthetic-list.ts`（规矩澄清前为卡行数未入库），全文如下，也可直接用 `jiti` 跑复现：

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ImportService, PermissionService, SourceStore, Vault, migrate, openDatabase,
} from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-s3a-real-'));
const folder = join(dir, 's');
mkdirSync(folder, { recursive: true });
const L = (o: unknown) => JSON.stringify(o);
const seg = (type: 'user' | 'assistant', content: unknown) =>
  L({
    sessionId: '11111111-2222-4333-8444-999999999999',
    cwd: 'D:/work/demo', isSidechain: false, type,
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
const imports = new ImportService(db, new Vault(join(dir, 'v')), new PermissionService(db), new SourceStore(db));
const preview = imports.previewAgentSessions(folder);
console.log('列出：', JSON.stringify(preview, null, 2));
const ids = preview.sessions.map((s) => s.id);
console.log('估算：', JSON.stringify(imports.estimateAgentSessions(folder, ids, preview.sessions), null, 2));
db.close();
rmSync(dir, { recursive: true, force: true });
```

输出（合成数据；path 是临时目录）：

```
列出： {
  "sessions": [
    { "id": 1, "tool": "claude_code", "title": "帮我把导入修好", "cwd": "D:/work/demo",
      "projectId": null, "mtimeMs": 1789826106164.401, "size": 439, "status": "new",
      "path": "C:\\Users\\87953\\AppData\\Local\\Temp\\ixaeon-s3a-real-HkUVbc\\s\\cc.jsonl" }
  ],
  "unrecognizedCount": 1,
  "subagentCount": 0
}
估算： {
  "items": [ { "id": 1, "userChars": 7, "assistantChars": 4 } ],
  "userChars": 7,
  "assistantChars": 4
}
```

## Codex 审查（A 档）

B 档，不跑 Codex，等整合方复审。

## 已知缺口

- 估算/导入会整份解析选中的会话，同步执行：真机实测（上面 agent-sessions 输出）最大的 Codex 会话 1551MB 解析约 3 秒。主进程单次调用会卡住这个量级；界面（S3b）做进度展示时如需要，再议是否移工作线程。
- 勾选界面、估算展示是 S3b，未做。
- GitHub CI：绿（verify 运行 35447511743，2026-09-19）。
- 用户接受：未发生（B 档，等整合方复审）。
