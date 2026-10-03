/**
 * D7 验收（规格 docs/委派/D7-编码任务交给我的模型.md）——网关执行器本体。
 * 按设置选执行器、设置页那一半拆成 D7b（apps/desktop/test/acceptance/d7b-*.test.ts）。
 * 执行方先推了一版，整合方 2026-10-03 锁定前重写补全（规格末尾「整合方审测试时的改正与补充」）。
 *
 * 钉住的接缝：`ModelCodingExecutor`（packages/core/src/execution/modelExecutor.ts）实现
 * `CodingExecutor`，构造参数 (provider: ModelProvider, modelName: string)，名字 `model:<模型名>`；
 * 只发一次 provider.chatStructured；任何一种失败都抛错（编排层把任务记成失败），副本一个字不改。
 *
 * 与验收条件的对应：
 * - 条件 6、10（发什么）：只发三类文本文件的内容——批准范围内的、根目录 README、目标里写了
 *   相对路径的；范围外又没点名的只进清单；二进制、密钥类文件名、链接那头的东西都不发；
 *   单文件 64 KB 截断、内容总量 12 万字符、清单 400 条。
 * - 条件 3：合格的改动写进副本，报告如实；模型自己说没做成时，它给的改动不写。
 * - 条件 4、12：范围外 / 绝对路径 / 带 .. / 路径上有链接——一处不合格整批不写，原因里有那个路径。
 * - 条件 11（不许盲改）：要覆盖一个已存在、但内容没完整发给模型的文件 → 整单失败。
 * - 条件 5：没按格式、超过 20 处、单文件超上限、请求失败 → 整单失败、不写。
 * - 条件 13：超时失败；已取消或超时之后才回来的响应不写。
 * - 条件 7：不起任何子进程，除了那一次模型请求不联网。
 *
 * 原版里等于没测到的两条（改掉了）：
 * - 「不起子进程」对一个临时对象 `{ spawn }` 下 spy，执行器引入的 child_process 不经过它，永远通过；
 * - 「只来自副本」把密钥文件放在副本外面再断言提示里没有，只读副本的实现本来就碰不到。
 *   真正会漏的是副本里一个指到外面的链接，这里测的是它。
 *
 * 整合方复审实现时又补了十条（规格末尾「整合方复审实现时补」条件 15–22）。头一版锁定的测试
 * 没盯住这些，执行方的实现在这十条上都是红的：
 * - 条件 15、16（不许盲改的三个漏洞）：总量放不下而没发的文件、换个大小写的写法（Windows）、
 *   副本里已有的密钥类文件；
 * - 条件 17：路径中间是个文件；条件 18：截断要标在文件旁边，比总量上限还大的文件也发开头；
 * - 条件 19：README 的各种写法；条件 20：目标里点名认中文路径和紧跟标点的路径；
 * - 条件 21：取消了马上结束；条件 22：模型说没做成时不再去核它给的改动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
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
import type * as ChildProcess from 'node:child_process';
import type { CodingTask } from '@ixaeon/contracts';

// 条件 7：执行器（连同它引入的模块）运行期间不许起任何子进程
const childCalls: string[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  const wrap =
    <K extends keyof typeof real>(name: K) =>
    (...args: unknown[]) => {
      childCalls.push(String(name));
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
  return {
    ...real,
    spawn: wrap('spawn'),
    spawnSync: wrap('spawnSync'),
    exec: wrap('exec'),
    execSync: wrap('execSync'),
    execFile: wrap('execFile'),
    execFileSync: wrap('execFileSync'),
    fork: wrap('fork'),
  };
});

const { FakeProvider } = await import('../../src/extraction/model/fake.js');
const { ModelCodingExecutor } = await import('../../src/execution/modelExecutor.js');
type Provider = InstanceType<typeof FakeProvider>;

let dir: string;
let workspace: string;

beforeEach(() => {
  childCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'ixa-d7-'));
  workspace = join(dir, 'ws');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '合成 README：README_BODY\n');
  writeFileSync(join(workspace, 'src', 'note.txt'), '范围内的文件：NOTE_BODY\n');
  writeFileSync(join(workspace, 'src', 'other.txt'), '范围外没点名的文件：OTHER_BODY\n');
  writeFileSync(join(workspace, 'docs', 'guide.md'), '目标里点了名的文件：GUIDE_BODY\n');
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function task(over: Partial<CodingTask> = {}): CodingTask {
  return {
    id: 't1',
    project_id: 'p1',
    goal: '在 src/note.txt 里加一行',
    scope_json: JSON.stringify(['src/note.txt']),
    status: 'queued',
    timeout_ms: 30_000,
    workspace_path: workspace,
    ...over,
  } as CodingTask;
}

const signal = () => new AbortController().signal;
const ok = (changes: unknown[]) => ({ changes, summary: '模型说改完了', claimedSuccess: true });
/** 发给模型的全部文字（系统提示 + 用户内容）。 */
const sentTo = (p: Provider) => {
  const c = p.structuredCalls[0]!;
  return `${c.system}\n${c.user}`;
};

/** 副本全貌：链接记成链接、不进去；文件记内容。 */
function snapshot(root = workspace): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const rel = abs.slice(root.length + 1).replaceAll('\\', '/');
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push(`L ${rel}`);
      else if (st.isDirectory()) {
        out.push(`D ${rel}`);
        walk(abs);
      } else out.push(`F ${rel}:${readFileSync(abs, 'utf8')}`);
    }
  };
  walk(root);
  return out.sort();
}

async function expectRejected(
  provider: Provider,
  t: CodingTask,
  reason: RegExp,
  sig: AbortSignal = signal(),
): Promise<void> {
  const before = snapshot();
  await expect(new ModelCodingExecutor(provider, 'm').run(t, workspace, sig)).rejects.toThrow(
    reason,
  );
  expect(snapshot(), '副本应一个字都没改').toEqual(before);
}

/** 只跑一次（模型不改任何文件），返回发给模型的全部文字。 */
async function sentFor(t: CodingTask): Promise<string> {
  const provider = new FakeProvider('d7');
  provider.enqueueStructured(ok([]));
  await new ModelCodingExecutor(provider, 'm').run(t, workspace, signal());
  expect(provider.structuredCalls, '一次任务只发一次模型请求').toHaveLength(1);
  return sentTo(provider);
}

describe('D7 条件 6、10：发给模型的是什么', () => {
  it('范围内的文件、README、目标里写了路径的文件发内容；范围外又没点名的只进清单', async () => {
    const goal = '照 docs/guide.md 的写法，在 src/note.txt 里加一行';
    const sent = await sentFor(task({ goal }));
    expect(sent).toContain(goal);
    expect(sent).toContain('NOTE_BODY');
    expect(sent).toContain('README_BODY');
    expect(sent).toContain('GUIDE_BODY');
    expect(sent, '范围外又没点名的文件不发内容').not.toContain('OTHER_BODY');
    expect(sent, '但它在文件清单里').toContain('src/other.txt');
  });

  it('批准范围是一个目录：目录下的文件都发；范围是整个项目（.）：副本里的文本文件都发', async () => {
    const dirScope = await sentFor(task({ scope_json: JSON.stringify(['src']) }));
    expect(dirScope).toContain('NOTE_BODY');
    expect(dirScope).toContain('OTHER_BODY');
    expect(dirScope).not.toContain('GUIDE_BODY');
    const whole = await sentFor(task({ scope_json: JSON.stringify(['.']) }));
    for (const body of ['NOTE_BODY', 'OTHER_BODY', 'GUIDE_BODY', 'README_BODY']) {
      expect(whole).toContain(body);
    }
  });

  it('不发：二进制、密钥类文件名、链接那头的东西（即使都在批准范围里）', async () => {
    writeFileSync(
      join(workspace, 'src', 'image.bin'),
      Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]),
    );
    // 副本本来不会有密钥文件（复制时跳过）；万一有，也不发
    writeFileSync(join(workspace, '.env'), 'ENV_SECRET=inside-copy\n');
    writeFileSync(join(workspace, 'src', 'server.pem'), 'PEM_SECRET\n');
    // 副本里一个指到外面的目录链接：执行器不许顺着它把外面的文件发出去
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'private.txt'), 'OUTSIDE_SECRET\n');
    symlinkSync(outside, join(workspace, 'src', 'linked'), 'junction');

    const sent = await sentFor(task({ scope_json: JSON.stringify(['.']) }));
    expect(sent).not.toContain('BIN\u0000SECRET');
    expect(sent).not.toContain('ENV_SECRET');
    expect(sent).not.toContain('PEM_SECRET');
    expect(sent).not.toContain('OUTSIDE_SECRET');
    expect(sent, '链接里面的文件不进清单').not.toContain('linked/private.txt');
    expect(sent).toContain('NOTE_BODY');
  });

  it('根目录下 README 的各种写法都发；子目录里的 README 不算', async () => {
    writeFileSync(join(workspace, 'README'), 'README_PLAIN_BODY\n');
    writeFileSync(join(workspace, 'readme.txt'), 'README_TXT_BODY\n');
    writeFileSync(join(workspace, 'docs', 'README.md'), 'DOCS_README_BODY\n');
    const sent = await sentFor(task());
    expect(sent).toContain('README_BODY');
    expect(sent).toContain('README_PLAIN_BODY');
    expect(sent).toContain('README_TXT_BODY');
    expect(sent, '子目录里的 README 既不在范围里也没被点名').not.toContain('DOCS_README_BODY');
  });

  it('目标里点名：中文路径、路径后面紧跟标点，都算点到了', async () => {
    mkdirSync(join(workspace, '文档'));
    writeFileSync(join(workspace, '文档', '说明.md'), 'CJK_PATH_BODY\n');
    const sent = await sentFor(
      task({ goal: '照文档/说明.md的格式，参考 docs/guide.md。在 src/note.txt 里加一行' }),
    );
    expect(sent).toContain('CJK_PATH_BODY');
    expect(sent).toContain('GUIDE_BODY');
    expect(sent).not.toContain('OTHER_BODY');
  });

  it('单个文件超过 64 KB：只发开头，并在这个文件旁边标明截断；发全了的标明完整', async () => {
    writeFileSync(join(workspace, 'src', 'big.md'), `BIG_HEAD_${'A'.repeat(70_000)}_BIG_TAIL`);
    const sent = await sentFor(task({ scope_json: JSON.stringify(['src']) }));
    expect(sent).toContain('BIG_HEAD_');
    expect(sent, '超过 64 KB 的部分不发').not.toContain('_BIG_TAIL');
    expect(sent.match(/A{1000,}/)![0].length).toBeLessThanOrEqual(65_536);
    // 模型要能分清哪些文件给全了（只有给全了的才许改写）
    expect(sent).toMatch(/big\.md[^\n]*截断/);
    expect(sent).not.toMatch(/note\.txt[^\n]*截断/);
    expect(sent).toMatch(/note\.txt[^\n]*完整/);
    expect(sent).not.toMatch(/big\.md[^\n]*完整/);
  });

  it('比总量上限还大的文件：也只是截断，开头照发', async () => {
    writeFileSync(join(workspace, 'src', 'huge.md'), `HUGE_HEAD_${'B'.repeat(150_000)}_HUGE_TAIL`);
    const sent = await sentFor(task({ scope_json: JSON.stringify(['src/huge.md']) }));
    expect(sent).toContain('HUGE_HEAD_');
    expect(sent).not.toContain('_HUGE_TAIL');
    expect(sent.match(/B{1000,}/)![0].length).toBeLessThanOrEqual(65_536);
  });

  it('文件内容总量不超过 12 万字符：放不下的不发', async () => {
    for (const n of ['a', 'b', 'c', 'd']) {
      writeFileSync(join(workspace, 'src', `fill-${n}.md`), `FILL_${n}_${'x'.repeat(50_000)}`);
    }
    const sent = await sentFor(task({ scope_json: JSON.stringify(['src']) }));
    // 四个文件加起来二十万字符；清单与说明另算，但整份提示不该大出一截
    expect((sent.match(/x/g) ?? []).length).toBeLessThanOrEqual(120_000);
    expect(sent.length).toBeLessThanOrEqual(120_000 + 20_000);
  });

  it('文件清单最多 400 条', async () => {
    mkdirSync(join(workspace, 'many'));
    for (let i = 1; i <= 405; i += 1) writeFileSync(join(workspace, 'many', `f${i}.txt`), '');
    const sent = await sentFor(task());
    // 按出现的路径数，不依赖遍历顺序
    const listed = new Set(sent.match(/many\/f\d+\.txt/g) ?? []);
    expect(listed.size).toBeGreaterThan(0);
    expect(listed.size).toBeLessThanOrEqual(400);
  });
});

describe('D7 条件 3：合格的改动写进副本，报告如实', () => {
  it('改一个、新建两个（含新目录）、删两个：副本照做；报告的各项如实', async () => {
    writeFileSync(join(workspace, 'src', 'old.txt'), '要删的\n');
    const provider = new FakeProvider('d7');
    const long = `// ${'长'.repeat(9000)}\n`;
    provider.enqueueStructured(
      ok([
        { path: 'src/note.txt', action: 'write', content: '第一行\n第二行' },
        { path: 'src/long.ts', action: 'write', content: long },
        { path: 'src/new.test.ts', action: 'write', content: 'export {};\n' },
        { path: 'src\\deep\\dir\\new.txt', action: 'write', content: '反斜杠也认' },
        { path: 'src/other.txt', action: 'delete' },
        { path: 'src/old.txt', action: 'delete', content: null },
      ]),
    );
    const exe = new ModelCodingExecutor(provider, 'my-model');
    const report = await exe.run(
      task({ scope_json: JSON.stringify(['src']) }),
      workspace,
      signal(),
    );
    expect(exe.name).toBe('model:my-model');
    expect(report.changedPaths.slice().sort()).toEqual([
      'src/deep/dir/new.txt',
      'src/long.ts',
      'src/new.test.ts',
      'src/note.txt',
      'src/old.txt',
      'src/other.txt',
    ]);
    expect(report.claimedSuccess).toBe(true);
    expect(report.summary).toBe('模型说改完了');
    expect(report.testsModified).toBe(true);
    // raw 存的是截短后的原始返回（这次的返回有九千多字）
    expect(typeof report.raw).toBe('string');
    expect(report.raw.length).toBeGreaterThan(0);
    expect(report.raw.length).toBeLessThanOrEqual(8000);
    expect(readFileSync(join(workspace, 'src', 'note.txt'), 'utf8')).toBe('第一行\n第二行');
    expect(readFileSync(join(workspace, 'src', 'long.ts'), 'utf8')).toBe(long);
    expect(readFileSync(join(workspace, 'src', 'new.test.ts'), 'utf8')).toBe('export {};\n');
    expect(readFileSync(join(workspace, 'src', 'deep', 'dir', 'new.txt'), 'utf8')).toBe(
      '反斜杠也认',
    );
    expect(existsSync(join(workspace, 'src', 'other.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'src', 'old.txt'))).toBe(false);
    // 范围外的文件一个没动
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toContain('README_BODY');
  });

  it('没有改测试文件：testsModified 是 false', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(ok([{ path: 'src/note.txt', action: 'write', content: 'x' }]));
    const report = await new ModelCodingExecutor(provider, 'm').run(task(), workspace, signal());
    expect(report.changedPaths).toEqual(['src/note.txt']);
    expect(report.testsModified).toBe(false);
  });

  it('模型自己说没做成（claimedSuccess=false）：照实报告，它给的改动不写', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured({
      changes: [{ path: 'src/note.txt', action: 'write', content: '半截改动' }],
      summary: '范围里做不到',
      claimedSuccess: false,
    });
    const before = snapshot();
    const report = await new ModelCodingExecutor(provider, 'm').run(task(), workspace, signal());
    expect(report.claimedSuccess).toBe(false);
    expect(report.summary).toBe('范围里做不到');
    expect(report.changedPaths).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('模型说没做成、给的改动还不合格：照它说的报告，不另外报路径错', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured({
      changes: [{ path: 'README.md', action: 'write', content: '范围外' }],
      summary: '要改 README 才行，范围里做不到',
      claimedSuccess: false,
    });
    const before = snapshot();
    const report = await new ModelCodingExecutor(provider, 'm').run(task(), workspace, signal());
    expect(report.claimedSuccess).toBe(false);
    expect(report.summary).toBe('要改 README 才行，范围里做不到');
    expect(report.changedPaths).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
});

describe('D7 条件 4、12：不合格的改动——一处不合格，整批不写', () => {
  // 路径本身不合格的几条用「整个项目」当批准范围：这样拦下它们的只能是路径检查，不是范围检查
  const NOTE = ['src/note.txt'];
  const ALL = ['.'];
  const cases: Array<[string, string[], Record<string, unknown>, RegExp]> = [
    ['范围外的写入', NOTE, { path: 'README.md', action: 'write', content: 'x' }, /README\.md/],
    ['范围外的新文件', NOTE, { path: 'other.txt', action: 'write', content: 'x' }, /other\.txt/],
    ['范围外的删除', NOTE, { path: 'src/other.txt', action: 'delete' }, /src\/other\.txt/],
    [
      '盘符开头的绝对路径',
      ALL,
      { path: 'C:/Windows/d7.ini', action: 'write', content: 'x' },
      /d7\.ini/,
    ],
    [
      '斜杠开头的绝对路径',
      ALL,
      { path: '/abs-d7.txt', action: 'write', content: 'x' },
      /abs-d7\.txt/,
    ],
    ['带 ..', ALL, { path: 'src/../../escape.txt', action: 'write', content: 'x' }, /escape\.txt/],
    [
      '反斜杠的 ..',
      ALL,
      { path: 'src\\..\\..\\escape.txt', action: 'write', content: 'x' },
      /escape/,
    ],
    ['写到一个目录上', ALL, { path: 'docs', action: 'write', content: 'x' }, /docs/],
    [
      '路径中间是个文件',
      ALL,
      { path: 'src/other.txt/child.txt', action: 'write', content: 'x' },
      /other\.txt/,
    ],
    ['删一个不存在的文件', ALL, { path: 'src/ghost.txt', action: 'delete' }, /ghost\.txt/],
    ['删一个目录', ALL, { path: 'docs', action: 'delete' }, /docs/],
  ];
  for (const [label, scope, change, reason] of cases) {
    it(`${label}：不写，原因里有那个路径；同一批里合格的那处也不写`, async () => {
      const provider = new FakeProvider('d7');
      provider.enqueueStructured(
        ok([{ path: 'src/note.txt', action: 'write', content: '这处本身合格' }, change]),
      );
      await expectRejected(provider, task({ scope_json: JSON.stringify(scope) }), reason);
      expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
      expect(existsSync(join(workspace, 'abs-d7.txt'))).toBe(false);
    });
  }

  it('路径上有链接：不写，链接那头的目录没多出东西', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, 'src', 'linked'), 'junction');
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(
      ok([{ path: 'src/linked/planted.txt', action: 'write', content: 'ESCAPED' }]),
    );
    await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /linked/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('要删的正好是一个链接：不删，链接和它那头的东西都还在', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), '外面的文件');
    symlinkSync(outside, join(workspace, 'src', 'linked'), 'junction');
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(ok([{ path: 'src/linked', action: 'delete' }]));
    await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /linked/);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('外面的文件');
  });
});

describe('D7 条件 11：不许盲改', () => {
  it('要覆盖一个只发了开头的文件（超过 64 KB 被截断）：整单失败、不写', async () => {
    const big = `BIG_HEAD_${'A'.repeat(70_000)}_BIG_TAIL`;
    writeFileSync(join(workspace, 'src', 'big.md'), big);
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(
      ok([{ path: 'src/big.md', action: 'write', content: '模型只看到了开头就重写整份' }]),
    );
    await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /big\.md/);
    expect(readFileSync(join(workspace, 'src', 'big.md'), 'utf8')).toBe(big);
  });

  it('要覆盖一个没发内容的二进制文件：整单失败、不写', async () => {
    const bytes = Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x01, 0x02]);
    writeFileSync(join(workspace, 'src', 'image.bin'), bytes);
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(
      ok([{ path: 'src/image.bin', action: 'write', content: '当成文本重写' }]),
    );
    await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /image\.bin/);
    expect(readFileSync(join(workspace, 'src', 'image.bin')).equals(bytes)).toBe(true);
  });

  it('要覆盖总量放不下、内容没发出去的文件：整单失败、不写', async () => {
    // 四个文件加起来二十万字符，最多放得下两个；模型把四个都重写了
    const names = ['a', 'b', 'c', 'd'].map((n) => `src/fill-${n}.md`);
    for (const rel of names) writeFileSync(join(workspace, rel), `FILL_${'x'.repeat(50_000)}`);
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(
      ok(names.map((path) => ({ path, action: 'write', content: '没看过就重写' }))),
    );
    await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /fill-[a-d]\.md/);
  });

  it('副本里已有的密钥类文件（内容从不发）：不许覆盖', async () => {
    writeFileSync(join(workspace, '.env'), 'ENV_SECRET=inside-copy\n');
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(ok([{ path: '.env', action: 'write', content: 'OVERWRITTEN=1\n' }]));
    await expectRejected(provider, task({ scope_json: JSON.stringify(['.']) }), /\.env/);
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('ENV_SECRET=inside-copy\n');
  });

  // Windows 的文件系统不分大小写：换个大小写写同一个文件，不能绕过上面的检查
  it.runIf(process.platform === 'win32')(
    '换个大小写的写法去覆盖只发了开头的文件：一样不许',
    async () => {
      const big = `BIG_HEAD_${'A'.repeat(70_000)}_BIG_TAIL`;
      writeFileSync(join(workspace, 'src', 'big.md'), big);
      const provider = new FakeProvider('d7');
      provider.enqueueStructured(
        ok([{ path: 'src/BIG.md', action: 'write', content: '换个大小写重写' }]),
      );
      await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /BIG\.md/);
      expect(readFileSync(join(workspace, 'src', 'big.md'), 'utf8')).toBe(big);
    },
  );
});

describe('D7 条件 5：模型回得不对或请求失败——整单失败、不写', () => {
  it('没按格式返回', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured({ notTheShape: true });
    await expectRejected(provider, task(), /没按格式/);
  });

  it('写入没带内容', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(ok([{ path: 'src/note.txt', action: 'write' }]));
    await expectRejected(provider, task(), /没按格式|内容/);
  });

  it('超过 20 处改动', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(
      ok(
        Array.from({ length: 21 }, (_, i) => ({
          path: `src/f${i}.md`,
          action: 'write',
          content: `x${i}`,
        })),
      ),
    );
    await expectRejected(provider, task({ scope_json: JSON.stringify(['src']) }), /20 处/);
  });

  it('单个文件内容超过 20 万字符', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(
      ok([{ path: 'src/note.txt', action: 'write', content: 'X'.repeat(200_001) }]),
    );
    await expectRejected(provider, task(), /note\.txt/);
  });

  it('模型请求失败：原因里有模型那边的错误', async () => {
    const provider = new FakeProvider('d7'); // 队列为空：chatStructured 抛错
    await expectRejected(provider, task(), /FakeProvider 队列为空/);
  });
});

describe('D7 条件 13：超时与取消——晚到的响应不写', () => {
  const lateWrite = ok([{ path: 'src/note.txt', action: 'write', content: '晚到的改动' }]);
  const settle = () => new Promise((r) => setTimeout(r, 450));

  it('模型请求超过任务时限：整单失败，原因写超时；响应回来之后也不写', async () => {
    const provider = new FakeProvider('d7');
    provider.chatDelayMs = 300;
    provider.enqueueStructured(lateWrite);
    const started = Date.now();
    await expectRejected(provider, task({ timeout_ms: 60 }), /超时/);
    expect(Date.now() - started, '到时限就失败，不等模型回来').toBeLessThan(250);
    await settle();
    expect(readFileSync(join(workspace, 'src', 'note.txt'), 'utf8')).toContain('NOTE_BODY');
  });

  it('等模型的时候取消了：马上结束，不写（响应回来之后也不写）', async () => {
    const provider = new FakeProvider('d7');
    provider.chatDelayMs = 300;
    provider.enqueueStructured(lateWrite);
    const ac = new AbortController();
    const before = snapshot();
    const started = Date.now();
    const run = new ModelCodingExecutor(provider, 'm').run(task(), workspace, ac.signal);
    setTimeout(() => ac.abort(), 50);
    // 取消后要么抛错、要么如实报告没做成；无论哪种，都不许写
    const report = await run.catch(() => null);
    // 不等模型回来：等着的话，编排层「同时只跑一个」的位置会一直被这个已取消的任务占着
    expect(Date.now() - started, '取消了就结束，不等模型回来').toBeLessThan(250);
    if (report) expect(report.claimedSuccess).toBe(false);
    await settle();
    expect(snapshot()).toEqual(before);
  });

  it('开工前就已经取消：不发模型请求、不写', async () => {
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(lateWrite);
    const ac = new AbortController();
    ac.abort();
    const before = snapshot();
    const report = await new ModelCodingExecutor(provider, 'm')
      .run(task(), workspace, ac.signal)
      .catch(() => null);
    if (report) expect(report.claimedSuccess).toBe(false);
    expect(provider.structuredCalls, '已经取消就不该再把文件发给模型').toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });
});

describe('D7 条件 7：不起任何子进程，不自己联网', () => {
  it('跑完一次有写入的任务：没调用过 child_process 的任何入口，也没自己发网络请求', async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      fetchCalls.push(args[0]);
      throw new Error('执行器不许自己联网');
    });
    const provider = new FakeProvider('d7');
    provider.enqueueStructured(ok([{ path: 'src/note.txt', action: 'write', content: 'ok' }]));
    childCalls.length = 0;
    await new ModelCodingExecutor(provider, 'm').run(task(), workspace, signal());
    expect(childCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(provider.structuredCalls).toHaveLength(1);
  });

  it('执行器的源码里没有引入 child_process', () => {
    const src = readFileSync(
      new URL('../../src/execution/modelExecutor.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/child_process/);
  });
});
