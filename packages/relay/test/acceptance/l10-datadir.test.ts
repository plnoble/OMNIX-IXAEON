/**
 * L10 验收测试（六）：数据目录挪出 AppData（规格条件 7，对应契约第 6 条）。
 *
 * 逐条对应：
 * - 不设 `IXAEON_RELAY_DIR`、把 `USERPROFILE` / `HOME` 指到临时目录 → `relay status` 打出来的
 *   数据目录是 `~/.ixaeon/relay` 那一处（打印时用户目录遮成 `~`）；
 * - （Windows）`LOCALAPPDATA` 指到临时目录、它下面 `IXAEON/relay/state.json` 存在 →
 *   多打一行旧位置提醒。
 *
 * 全在临时目录里；不调真模型、不连 GitHub。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l10-harness.js';

const dirs: string[] = [];
const worlds: World[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('条件 7：数据目录默认在 ~/.ixaeon/relay', () => {
  it('不设 IXAEON_RELAY_DIR、HOME/USERPROFILE 指到临时目录 → status 打的就是那里', async () => {
    const home = tmp('ixa-l10-home-');
    const w = makeWorld();
    worlds.push(w);
    const r = await w.run(['status'], {
      IXAEON_RELAY_DIR: undefined,
      IXAEON_WORKTREES: tmp('ixa-l10-trees-'),
      // 旧位置也指到空目录：不然会读到这台机器上真的 IXAEON/relay（提醒行里会带 appdata）
      LOCALAPPDATA: tmp('ixa-l10-local-empty-'),
      USERPROFILE: home,
      HOME: home,
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    // dataDir 是 <home>/.ixaeon/relay；打印时 home 遮成 ~
    expect(r.stdout).toMatch(/\.ixaeon[\\/]+relay/);
    // 不该再是 LOCALAPPDATA 那一处
    expect(r.stdout.toLowerCase()).not.toContain('appdata');
  }, 120_000);

  it('LOCALAPPDATA/<IXAEON>/relay 里还有 state.json → 多打一行旧位置提醒', async () => {
    const home = tmp('ixa-l10-home2-');
    const local = tmp('ixa-l10-local-');
    const oldDir = join(local, 'IXAEON', 'relay');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'state.json'), '{"turns":0}\n', 'utf8');

    const w = makeWorld();
    worlds.push(w);
    const r = await w.run(['status'], {
      IXAEON_RELAY_DIR: undefined,
      IXAEON_WORKTREES: tmp('ixa-l10-trees2-'),
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: local,
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('旧的数据目录里还有文件');
    // 提醒里只说路径：那一行里没有旧文件的内容
    const line = r.stdout.split('\n').find((l) => l.includes('旧的数据目录里还有文件')) ?? '';
    expect(line).not.toContain('{"turns":0}');
  }, 120_000);
});
