/**
 * D2 验收测试（规格 docs/委派/D2-验证按档位进沙箱.md，v2 写法：先测试后实现）。
 * 本文件对应验收条件 1（零依赖档）与 6（权限参数剥离、非 node 拒绝不变）。
 *
 * 条件 1：合成的 TS 项目（node:test + 可剥离写法 + 显式 .ts 导入扩展名、
 * 零 npm 依赖）放进副本后经 defaultCheck 直跑——通过例退出码 0
 * （编排层 verify() 把它记 verify_status='passed'），故意失败的例子退出码
 * 非 0（记 'failed'）。本文件断言 defaultCheck 层的结果，passed/failed 的
 * 状态映射由既有编排层代码与回归测试保证。
 * 条件 6：命令自带的 --permission / --allow-fs-* 一律剥离（更宽的权限不会
 * 生效——验证器不能自己扩权）；node 以外的可执行程序照旧 ran=false 拒绝。
 *
 * 整合方补（2026-09-30，规格「改正与补充」第 2 条）：
 * 条件 8：副本里有目录链接（藏在子目录里也算）就不跑，ran=false，输出写明「链接」；
 * 链接那头的目录里没多出任何东西。Node 权限模型判写权限看链接所在的路径，
 * 会顺着链接写到副本外（D2 实验 E1）——测试里的验证脚本正是去写链接那头。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyProjectWorkspace } from '../../src/execution/workspaceCopy.js';
import { defaultCheck } from '../../src/execution/executor.js';

const PASS_SRC = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './lib.ts';",
  '',
  "test('zero-dep pass', () => {",
  '  assert.equal(add(40, 2), 42);',
  '});',
  '',
].join('\n');

const FAIL_SRC = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './lib.ts';",
  '',
  "test('zero-dep intentional failure', () => {",
  '  assert.equal(add(1, 2), 99);',
  '});',
  '',
].join('\n');

function makeZeroDepProject(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'lib.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  writeFileSync(join(dir, 'verify.pass.test.ts'), PASS_SRC);
  writeFileSync(join(dir, 'verify.fail.test.ts'), FAIL_SRC);
  // 副本外的文件：若宽权限参数没有被剥离就会被读到
  const outer = join(dir, '..', `outer-${Date.now()}.txt`);
  writeFileSync(outer, 'OUTER_SECRET');
  return outer;
}

describe('D2 条件 1：零依赖档在副本里直跑，退出码如实', () => {
  it('通过例：node:test + 显式 .ts 导入，退出码 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ixaeon-d2-tier0-'));
    const proj = join(root, 'proj');
    makeZeroDepProject(proj);
    const copy = join(root, 'copy');
    copyProjectWorkspace(proj, copy);
    const r = await defaultCheck([process.execPath, 'verify.pass.test.ts'], copy);
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('故意失败的例子：退出码非 0（编排层记 failed，不允许执行器自报通过）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ixaeon-d2-tier0-'));
    const proj = join(root, 'proj');
    makeZeroDepProject(proj);
    const copy = join(root, 'copy');
    copyProjectWorkspace(proj, copy);
    const r = await defaultCheck([process.execPath, 'verify.fail.test.ts'], copy);
    expect(r.ran).toBe(true);
    expect(r.exitCode).not.toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('D2 条件 6：自带权限参数剥离、非 node 程序拒绝（现状不变）', () => {
  it('命令自带的宽范围 --allow-fs-read 被剥离：读副本外文件被权限模型拦住', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ixaeon-d2-tier0-'));
    const proj = join(root, 'proj');
    const outer = makeZeroDepProject(proj);
    writeFileSync(
      join(proj, 'strip-probe.mjs'),
      [
        "import { readFileSync } from 'node:fs';",
        'try {',
        "  readFileSync(process.argv[2]); console.log('READ_OUTER_ALLOWED');",
        '} catch (e) {',
        "  console.log('READ_OUTER_BLOCKED(' + e.code + ')');",
        '}',
        '',
      ].join('\n'),
    );
    const copy = join(root, 'copy');
    copyProjectWorkspace(proj, copy);
    // 自带的 --allow-fs-read=<整个盘> 必须被剥离，否则就会读到副本外的文件
    const r = await defaultCheck(
      [process.execPath, '--permission', '--allow-fs-read=C:/', 'strip-probe.mjs', outer],
      copy,
    );
    expect(r.ran).toBe(true);
    expect(r.output).toContain('READ_OUTER_BLOCKED');
    rmSync(root, { recursive: true, force: true });
  });

  it('node 以外的可执行程序：ran=false，不算验证', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ixaeon-d2-tier0-'));
    const r = await defaultCheck([join(root, 'npm.exe'), 'test'], root);
    expect(r.ran).toBe(false);
    expect(r.output).toContain('不裸跑');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('D2 条件 8（整合方补）：副本里有链接，零依赖档不跑', () => {
  // 验证脚本去写链接那头：没有这条守卫时，Node 权限模型按链接所在路径放行，写得进去
  const WRITE_THROUGH_SRC = [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.argv[2] + '/escaped.txt', 'ESCAPED');",
    '',
  ].join('\n');

  for (const where of ['linked', 'src/deep/linked']) {
    it(`副本里 ${where} 是指到副本外的目录链接：不跑，链接那头没多出东西`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'ixaeon-d2-tier0-'));
      const proj = join(root, 'proj');
      makeZeroDepProject(proj);
      mkdirSync(join(proj, 'src', 'deep'), { recursive: true });
      writeFileSync(join(proj, 'src', 'deep', 'keep.txt'), '占位，让子目录被复制');
      writeFileSync(join(proj, 'write-through.mjs'), WRITE_THROUGH_SRC);
      const copy = join(root, 'copy');
      copyProjectWorkspace(proj, copy);
      // 执行器阶段留下的目录链接（建目录链接不需要管理员权限）
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(copy, where), 'junction');

      const r = await defaultCheck([process.execPath, 'write-through.mjs', where], copy);

      expect(r.ran).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(r.output).toContain('链接');
      expect(readdirSync(outside)).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    });
  }
});
