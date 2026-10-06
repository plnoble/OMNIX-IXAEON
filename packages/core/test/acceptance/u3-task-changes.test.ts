/**
 * U3 验收（核心层，规格 docs/委派/U3-任务页看改动.md 条件 1–10、13）。
 * 条件 11（IPC）在 apps/desktop/test/acceptance/u3-ipc.test.ts；
 * 条件 12（界面）在 apps/desktop/test/acceptance/u3-tasks-page.test.ts。
 *
 * diff 方向 = 项目文件夹里现在的文件（旧）→ 副本里现在的文件（新），
 * 即「这个任务做了哪些改动」：+ 是副本新增的行，- 是被删掉的行。
 * 只读这条总约束（条件 13）在每条用例里都验：调用前后项目文件夹和副本里
 * 每个文件（含内容与链接状态）的指纹不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type * as FsTypes from 'node:fs';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
  readTaskChanges,
  type CodingTask,
  type CoreDatabase,
} from '@ixaeon/core';

/** 记录 readTaskChanges 期间所有 openSync 的调用（安全用例要证明被禁的文件连打开都没发生）。 */
const fsReads = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof FsTypes;
  return {
    ...actual,
    openSync: vi.fn(((...args: unknown[]) => {
      fsReads.calls.push(String(args[0]));
      return (actual.openSync as (...a: unknown[]) => unknown)(...args);
    }) as FsTypes['openSync']),
  };
});

let dir: string;
let db: CoreDatabase;
let root: string;
let workspace: string;
let task: CodingTask;

beforeEach(() => {
  fsReads.calls = [];
  dir = mkdtempSync(join(tmpdir(), 'ixa-u3-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  root = join(dir, 'project');
  workspace = join(dir, 'ws');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'calc.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  new ProjectService(db).create({ name: 'U3 项目', rootPath: root, description: null });
  new PermissionService(db).grantFolder(root);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 直写一张任务行（含执行报告与副本），返回再读出来的 CodingTask。 */
function seedTask(opts: {
  changedPaths?: string[];
  baseHashes?: Record<string, string | null>;
  withReport?: boolean;
  noWorkspace?: boolean;
}): CodingTask {
  mkdirSync(workspace, { recursive: true });
  const id = randomUUID();
  const projRow = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
  db.prepare(
    `INSERT INTO coding_tasks (
       id, project_id, goal, scope_json, workspace_path, snapshot_ref, context_digest,
       allowed_commands_json, timeout_ms, status, version, approval_id, dispatch_key,
       generation, executor_name, executor_report_json, verify_status, verify_exit_code,
       verify_output, tests_modified, accepted_at, error, created_at, updated_at, origin_run_id,
       acceptance_json
     ) VALUES (?, ?, '合成任务', '["calc.mjs"]', ?, 'copy', ?, '[]', 900000,
               'pending_accept', 1, NULL, NULL, 1, 'scripted', ?, 'passed', 0,
               'out', 0, NULL, NULL, datetime('now'), datetime('now'), NULL, NULL)`,
  ).run(
    id,
    projRow.id,
    opts.noWorkspace ? null : workspace,
    'u3',
    opts.withReport === false
      ? null
      : JSON.stringify({
          claimedSuccess: true,
          summary: 'done',
          changedPaths: opts.changedPaths ?? [],
          testsModified: false,
          raw: '',
          ...(opts.baseHashes ? { baseHashes: opts.baseHashes } : {}),
        }),
  );
  task = db.prepare('SELECT * FROM coding_tasks WHERE id = ?').get(id) as unknown as CodingTask;
  return task;
}

const project = (): string => join(dir, 'project');

/** 项目与副本的文件指纹（调用前后必须一样——条件 13 只读）。 */
function snapshotBoth(): string[] {
  const snap = (r: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const abs = join(d, name);
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) out.push(`L ${abs}`);
        else if (st.isDirectory()) walk(abs);
        else out.push(`F ${abs}:${readFileSync(abs, 'utf8')}`);
      }
    };
    walk(r);
    return out.sort();
  };
  try {
    return [...snap(workspace), ...snap(project())];
  } catch {
    return [];
  }
}

/** 与 landing.ts 的 baseHashes 同一算法：LF 归一后 SHA-256。 */
function lfSha256(body: string): string {
  return createHash('sha256').update(body.replaceAll('\r\n', '\n')).digest('hex');
}

describe('条件 1：改了一个已有的文件', () => {
  it('modified；diff 有 - 行和 + 行；3 行以外的不出现；远改动分两段；挨着的并一段', () => {
    const t = seedTask({ changedPaths: ['calc.mjs'] });
    // 项目里是任务开始时的版本；副本里是任务做完的版本（改 1/改 2 挨着，改 3 远）
    writeFileSync(
      join(root, 'calc.mjs'),
      [
        'export function add(a, b) {',
        '  return a + b;',
        'filler1',
        'filler2',
        'filler3',
        'filler4',
        'filler5',
        'filler6',
        'filler7',
        'filler8',
        'filler9',
        'filler10',
        'filler11',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(workspace, 'calc.mjs'),
      [
        'export function add(a, b) {',
        '  // 改 1',
        '  // 改 2',
        '  return a + b;',
        'filler1',
        'filler2',
        'filler3',
        'filler4',
        'filler5',
        'filler6',
        'filler7',
        'filler8',
        '// 改 3（远处）',
        '}',
        '',
      ].join('\n'),
    );
    const { files } = readTaskChanges(db, t);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.kind).toBe('modified');
    expect(f.diff).not.toBeNull();
    const lines = f.diff!.split('\n');
    // 远改动分两段：段间一行 @@；挨着的两处改动并在一段里
    expect(lines.filter((l) => l === '@@')).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('-'))).toBe(true);
    expect(lines.some((l) => l.startsWith('+'))).toBe(true);
    // 三行上下文之外的不出现：第一段不能带第二段的内容
    const seg1 = lines.slice(0, lines.indexOf('@@')).join('\n');
    expect(seg1).not.toContain('改 3');
    // 副本加的改 1/改 2；副本删掉的 filler9/filler10；远段的改 3
    expect(f.diff).toContain('+  // 改 1');
    expect(f.diff).toContain('+  // 改 2');
    expect(f.diff).toContain('-filler9');
    expect(f.diff).toContain('-filler10');
    expect(f.diff).toContain('+// 改 3（远处）');
    // 两段的上下文边界：每段前后最多 3 行没变的。第一段尾上下文是 return/filler1/filler2，
    // 第二段首上下文是 filler6/filler7/filler8；两段之间夹着的 filler3/4/5 不出现。
    expect(f.diff).toContain('filler2');
    expect(f.diff).toContain('filler6');
    expect(f.diff).not.toContain('filler3');
    expect(f.diff).not.toContain('filler4');
    expect(f.diff).not.toContain('filler5');
    expect(f.note).toBeNull();
  });
});

describe('条件 2：新加的文件', () => {
  it('added；每行 + 开头，内容齐全', () => {
    const t = seedTask({ changedPaths: ['new.txt'] });
    writeFileSync(join(workspace, 'new.txt'), '第一行\n第二行\n');
    const { files } = readTaskChanges(db, t);
    expect(files[0]!.kind).toBe('added');
    const lines = files[0]!.diff!.split('\n');
    expect(lines.every((l) => l.startsWith('+'))).toBe(true);
    expect(files[0]!.diff).toContain('+第一行');
    expect(files[0]!.diff).toContain('+第二行');
  });
});

describe('条件 3：删掉的文件', () => {
  it('deleted；每行 - 开头', () => {
    const t = seedTask({ changedPaths: ['gone.txt'] });
    writeFileSync(join(root, 'gone.txt'), '一行\n两行\n');
    const { files } = readTaskChanges(db, t);
    expect(files[0]!.kind).toBe('deleted');
    const lines = files[0]!.diff!.split('\n');
    expect(lines.every((l) => l.startsWith('-'))).toBe(true);
    expect(files[0]!.diff).toContain('-一行');
  });
});

describe('条件 4：副本和项目里一样', () => {
  it('same；diff null；note 写明', () => {
    seedTask({ changedPaths: ['calc.mjs'] });
    const body = 'export function add(a, b) {\n  return a + b;\n}\n';
    writeFileSync(join(root, 'calc.mjs'), body);
    writeFileSync(join(workspace, 'calc.mjs'), body);
    const { files } = readTaskChanges(db, task);
    expect(files[0]!.kind).toBe('same');
    expect(files[0]!.diff).toBeNull();
    expect(files[0]!.note).toContain('一样');
  });

  it('空文件不算读不出来：两边空是 same；一边空按新增/删除给差异', () => {
    seedTask({ changedPaths: ['empty.txt', 'added-empty.txt', 'deleted-empty.txt'] });
    writeFileSync(join(root, 'empty.txt'), '');
    writeFileSync(join(workspace, 'empty.txt'), '');
    writeFileSync(join(workspace, 'added-empty.txt'), '');
    writeFileSync(join(root, 'deleted-empty.txt'), '');
    const { files } = readTaskChanges(db, task);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('empty.txt')!.kind).toBe('same');
    expect(byPath.get('empty.txt')!.note).toBe('和项目里现在的文件一样（可能已经合并过了）');
    expect(byPath.get('added-empty.txt')!.kind).toBe('added');
    expect(byPath.get('added-empty.txt')!.diff).not.toBeNull();
    expect(byPath.get('deleted-empty.txt')!.kind).toBe('deleted');
    expect(byPath.get('deleted-empty.txt')!.diff).not.toBeNull();
  });
});

describe('条件 5：只差换行符', () => {
  it('算一样不给出 diff；真有改动的文件只出真改动', () => {
    seedTask({ changedPaths: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'] });
    // a：CRLF 对 LF、且末尾换行不同 → 行一模一样、原文不同，note「只有换行符不同」
    writeFileSync(join(root, 'a.txt'), '一行\n两行\n');
    writeFileSync(join(workspace, 'a.txt'), '一行\r\n两行');
    // b：只差末尾换行 →「只有换行符不同」
    writeFileSync(join(root, 'b.txt'), '内容\n');
    writeFileSync(join(workspace, 'b.txt'), '内容');
    // c：CRLF/LF 混着，其中一行真改了 → 只出真改动，换行不算
    writeFileSync(join(root, 'c.txt'), 'keep\nold line\nkeep2\r\n');
    writeFileSync(join(workspace, 'c.txt'), 'keep\r\nnew line\r\nkeep2\n');
    // d：两边原文一字不差（都 CRLF）→ note「一样」（可能已经合并过了）
    writeFileSync(join(root, 'd.txt'), 'D\r\nE\r\n');
    writeFileSync(join(workspace, 'd.txt'), 'D\r\nE\r\n');
    // e：只差 CRLF/LF（末尾换行一样）→「只有换行符不同」
    writeFileSync(join(root, 'e.txt'), 'F\r\nG\r\n');
    writeFileSync(join(workspace, 'e.txt'), 'F\nG\n');
    const { files } = readTaskChanges(db, task);
    expect(files).toHaveLength(5);
    for (const f of files.slice(0, 2)) {
      expect(f.kind).toBe('same');
      expect(f.diff).toBeNull();
      expect(f.note).toBe('只有换行符不同');
    }
    expect(files[2]!.kind).toBe('modified');
    expect(files[2]!.diff).toContain('-old line');
    expect(files[2]!.diff).toContain('+new line');
    expect(files[2]!.diff).not.toContain('-keep');
    expect(files[2]!.diff).not.toContain('+keep');
    expect(files[3]!.kind).toBe('same');
    expect(files[3]!.diff).toBeNull();
    expect(files[3]!.note).toBe('和项目里现在的文件一样（可能已经合并过了）');
    expect(files[4]!.kind).toBe('same');
    expect(files[4]!.diff).toBeNull();
    expect(files[4]!.note).toBe('只有换行符不同');
  });
});

describe('条件 6：看不了的每一种', () => {
  it('diff null、note 写原因；项目里的内容不出现在返回值里', () => {
    seedTask({
      changedPaths: [
        '../escape.txt',
        'C:/Windows/x.txt',
        '.env',
        'secret.pem',
        'docs',
        'huge.txt',
        'big.bin',
        'long.txt',
        'link/esc-dir',
        'link/esc-dir/esc.txt',
      ],
    });
    // 越界入口外面放一个真能读到的标记文件：../escape.txt 指向它，读了就会露馅
    const escapeTarget = join(dir, 'escape.txt');
    writeFileSync(escapeTarget, 'ROOT_ESCAPE=1\n');
    // 项目侧放带标记的内容（都不许出现在结果里）
    writeFileSync(join(root, '.env'), 'ROOT_SECRET_ENV=1\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'x.md'), 'ROOT_DOCS=1\n');
    writeFileSync(join(root, 'huge.txt'), `ROOT_HUGE${'H'.repeat(300 * 1024)}`);
    const bin = Buffer.alloc(4096, 0x42);
    bin[512] = 0;
    writeFileSync(join(root, 'big.bin'), bin);
    writeFileSync(
      join(root, 'long.txt'),
      `ROOT_LONG_MARK\n${Array.from({ length: 2010 }, () => 'r'.repeat(50)).join('\n')}\n`,
    );
    mkdirSync(join(root, 'link'), { recursive: true });
    mkdirSync(join(root, 'link-target'), { recursive: true });
    writeFileSync(join(root, 'link-target', 'esc.txt'), 'ROOT_LINK_SECRET=1\n');
    symlinkSync(join(root, 'link-target'), join(root, 'link', 'esc-dir'), 'junction');
    // 副本侧放对应的内容（装作任务改过）
    writeFileSync(join(workspace, '.env'), 'WS_SECRET=1\n');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'x.md'), 'WS_DOCS=1\n');
    writeFileSync(join(workspace, 'huge.txt'), `WS_HUGE${'H'.repeat(300 * 1024)}`);
    const binWs = Buffer.alloc(4096, 0x43);
    binWs[512] = 0;
    writeFileSync(join(workspace, 'big.bin'), binWs);
    writeFileSync(
      join(workspace, 'long.txt'),
      `WS_LONG_MARK\n${Array.from({ length: 2010 }, () => 'w'.repeat(50)).join('\n')}\n`,
    );
    mkdirSync(join(workspace, 'link'), { recursive: true });
    symlinkSync(join(root, 'link-target'), join(workspace, 'link', 'esc-dir'), 'junction');

    const { files } = readTaskChanges(db, task);
    expect(files).toHaveLength(10);
    const whole = JSON.stringify(files);
    for (const probe of [
      'ROOT_SECRET_ENV',
      'ROOT_DOCS',
      'ROOT_HUGE',
      'ROOT_LONG',
      'ROOT_LINK_SECRET',
      'ROOT_ESCAPE',
      'WS_SECRET',
      'WS_DOCS',
      'WS_LONG',
    ]) {
      expect(whole).not.toContain(probe);
    }
    for (const f of files) {
      expect(f.diff).toBeNull();
      expect(f.note).not.toBeNull();
    }
    const notes = files.map((f) => f.note).join('；');
    expect(notes).toContain('路径不合规');
    expect(notes).toContain('密钥类文件');
    expect(notes).toContain('不是普通文件');
    expect(notes).toContain('文件太大');
    expect(notes).toContain('二进制文件');
    expect(notes).toContain('行数太多');
    expect(notes).toContain('是链接');
    // 被禁的文件不只是「内容不在返回值里」：readFileSync 根本没碰过它们。
    // 允许读的只有对照用的合规文件（这里 long.txt / big.bin）。
    const readSet = new Set(fsReads.calls.map((p) => p.replaceAll('\\', '/')));
    expect(readSet.size).toBeGreaterThan(0);
    // 越界标记文件与链接下面的文件：按绝对路径核对，一次都没被读过
    expect(readSet.has(escapeTarget.replaceAll('\\', '/'))).toBe(false);
    for (const bad of ['C:/Windows', '.env', 'secret.pem', '/docs/', 'huge.txt', '/link/esc-dir']) {
      for (const p of readSet) expect(p, `不该读 ${p}`).not.toContain(bad);
    }
  });

  it('两边都没有：unknown、note 写明（契约 3 的那一行）', () => {
    seedTask({ changedPaths: ['nowhere.txt'] });
    const { files } = readTaskChanges(db, task);
    expect(files[0]!.kind).toBe('unknown');
    expect(files[0]!.diff).toBeNull();
    expect(files[0]!.note).toBe('项目里和副本里都没有这个文件');
  });
});

describe('条件 7：没有授权', () => {
  it('没绑文件夹：diff 全 null、note 写明、两边的内容都不出现', () => {
    const t = seedTask({ changedPaths: ['calc.mjs'] });
    db.prepare('UPDATE projects SET root_path = NULL WHERE id = ?').run(t.project_id);
    writeFileSync(join(workspace, 'calc.mjs'), 'WS_BODY\n');
    const { files } = readTaskChanges(db, task);
    expect(files[0]!.diff).toBeNull();
    expect(files[0]!.note).toContain('没有这个项目文件夹的读取授权');
    expect(JSON.stringify(files)).not.toContain('WS_BODY');
    expect(JSON.stringify(files)).not.toContain('add(a, b)');
    // 内容不出现还不够：没有授权时连读都没读过（项目里和副本里的 calc.mjs 都没碰）
    expect(fsReads.calls.filter((p) => p.includes('calc.mjs'))).toEqual([]);
  });

  it('授权撤销了：一样不显示', () => {
    seedTask({ changedPaths: ['calc.mjs'] });
    writeFileSync(join(workspace, 'calc.mjs'), 'WS_BODY\n');
    db.prepare("UPDATE permissions SET status = 'revoked' WHERE scope_type = 'folder'").run();
    const { files } = readTaskChanges(db, task);
    expect(files[0]!.diff).toBeNull();
    expect(files[0]!.note).toContain('没有这个项目文件夹的读取授权');
    expect(JSON.stringify(files)).not.toContain('add(a, b)');
  });

  it('撤销授权后所有条目统一提示没有授权（越界、密钥类也一样），且都不读', () => {
    seedTask({ changedPaths: ['../x.txt', '.env', 'calc.mjs'] });
    writeFileSync(join(workspace, '.env'), 'WS_SECRET=1\n');
    db.prepare("UPDATE permissions SET status = 'revoked' WHERE scope_type = 'folder'").run();
    const { files } = readTaskChanges(db, task);
    expect(files.map((f) => f.kind)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(
      files.map((f) => f.note).every((n) => n === '没有这个项目文件夹的读取授权，不显示内容'),
    ).toBe(true);
    expect(fsReads.calls).toEqual([]);
  });
});

describe('条件 8：基准变过', () => {
  it('任务开始之后项目里的文件被改过 → 差异照给、note 写明；没变的不写', () => {
    const v1 = 'line1\nline2\n';
    const v2 = 'line1\nline2 changed\n';
    const t = seedTask({
      changedPaths: ['calc.mjs', 'keep.mjs', 'new.mjs'],
      baseHashes: {
        'calc.mjs': lfSha256(v1),
        'keep.mjs': lfSha256('keep\n'),
        'new.mjs': null,
      },
    });
    // 项目里 calc.mjs 在任务开始之后被改成 v2；keep.mjs 没变；new.mjs 任务后出现又没了副本
    writeFileSync(join(root, 'calc.mjs'), v2);
    writeFileSync(join(root, 'keep.mjs'), 'keep\n');
    writeFileSync(join(root, 'new.mjs'), '外部新加的\n');
    // 副本里：任务的版本
    writeFileSync(join(workspace, 'calc.mjs'), 'line1\nline2\nline3\n');
    writeFileSync(join(workspace, 'keep.mjs'), 'keep\n');
    const { files } = readTaskChanges(db, t);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('calc.mjs')!.note).toContain('任务开始之后变过');
    expect(byPath.get('calc.mjs')!.diff).not.toBeNull();
    const keepNote = byPath.get('keep.mjs')!.note!;
    expect(keepNote).toContain('一样');
    expect(keepNote).not.toContain('变过');
    expect(byPath.get('new.mjs')!.note).toContain('任务开始之后变过');
  });

  it('报告里没有这一项的指纹：不写「变过」', () => {
    seedTask({
      changedPaths: ['listed.mjs', 'unlisted.mjs'],
      baseHashes: { 'listed.mjs': lfSha256('v1\n') },
    });
    // listed.mjs 指纹没变、有真 diff → note 是 null；unlisted.mjs 报告里没这项 → 不猜，note 也是 null
    writeFileSync(join(root, 'listed.mjs'), 'v1\n');
    writeFileSync(join(workspace, 'listed.mjs'), 'v1 extra\n');
    writeFileSync(join(root, 'unlisted.mjs'), '外部新增\n');
    const { files } = readTaskChanges(db, task);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('listed.mjs')!.note).toBeNull();
    expect(byPath.get('unlisted.mjs')!.kind).toBe('deleted');
    expect(byPath.get('unlisted.mjs')!.diff).not.toBeNull();
    expect(byPath.get('unlisted.mjs')!.note).toBeNull();
  });
});

describe('条件 9：上限', () => {
  it('超过 50 个文件只列 50 个，total 是总数；差异合计超限后面的不给差异', () => {
    const paths: string[] = [];
    for (let i = 1; i <= 60; i += 1) paths.push(`f${i}.txt`);
    seedTask({ changedPaths: paths });
    for (const p of paths) {
      writeFileSync(join(root, p), `old ${p}\n`);
      // 每个文件约 5000 字符差异：前 40 个左右用完 20 万字符预算
      writeFileSync(join(workspace, p), `new ${p}\n${'x'.repeat(5000)}\n`);
    }
    const { files, total } = readTaskChanges(db, task);
    expect(total).toBe(60);
    expect(files).toHaveLength(50);
    // 写死的 200 000 字符契约：用实现同款规则（给差异前预算 > 0）精确重算边界，
    // 实现提前停一串文件、或边界挪动一点都会对不上。
    const diffLenOf = (p: string): number => `-old ${p}\n+new ${p}\n+${'x'.repeat(5000)}`.length;
    let budget = 200_000;
    let expectedUsed = 0;
    let expectedFirstNull = files.length;
    for (let i = 0; i < files.length; i += 1) {
      const len = diffLenOf(files[i]!.path);
      if (budget <= 0) {
        expectedFirstNull = i;
        break;
      }
      budget -= len;
      expectedUsed += len;
    }
    files.slice(0, expectedFirstNull).forEach((f) => {
      expect(f.diff, `文件 ${f.path} 该有差异`).not.toBeNull();
      expect(f.diff!.length).toBe(diffLenOf(f.path));
    });
    expect(expectedFirstNull).toBeLessThan(50);
    const firstNull = files.findIndex((f) => f.diff === null);
    expect(firstNull).toBe(expectedFirstNull);
    const used = files.slice(0, firstNull).reduce((sum, f) => sum + f.diff!.length, 0);
    expect(used).toBe(expectedUsed);
    for (const f of files.slice(firstNull)) {
      expect(f.diff).toBeNull();
      expect(f.note).toBe('改动太多，后面的不显示差异');
    }
  });
});

describe('条件 10：没有副本、没有执行报告、changedPaths 空', () => {
  it('返回空清单，不报错', () => {
    const a = seedTask({ withReport: false });
    expect(readTaskChanges(db, a)).toEqual({ files: [], total: 0 });
    const b = seedTask({ changedPaths: [] });
    expect(readTaskChanges(db, b)).toEqual({ files: [], total: 0 });
    const c = seedTask({ changedPaths: ['x.txt'], noWorkspace: true });
    expect(readTaskChanges(db, c)).toEqual({ files: [], total: 0 });
    // 副本路径还在任务上、目录已经被清了：一样是空清单，不把项目文件误报成 deleted
    const d = seedTask({ changedPaths: ['x.txt'] });
    rmSync(workspace, { recursive: true, force: true });
    expect(readTaskChanges(db, d)).toEqual({ files: [], total: 0 });
  });
});

describe('条件 13：只读', () => {
  it('调用前后项目文件夹和副本里每个文件的指纹不变', () => {
    const t = seedTask({ changedPaths: ['calc.mjs', 'new.txt'] });
    writeFileSync(join(workspace, 'calc.mjs'), 'WS\n');
    writeFileSync(join(root, 'calc.mjs'), 'ROOT\n');
    writeFileSync(join(workspace, 'new.txt'), 'WS_NEW\n');
    const before = snapshotBoth();
    readTaskChanges(db, t);
    expect(snapshotBoth()).toEqual(before);
  });
});
