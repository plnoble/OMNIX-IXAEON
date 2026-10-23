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

/** `relay status` 第一段 JSON 里的 dataDir（打印时用户目录已遮成 `~`），斜杠统一成 `/`。 */
const dataDirOf = (stdout: string): string => {
  const m = /"dataDir":\s*"((?:[^"\\]|\\.)*)"/.exec(stdout);
  if (!m) throw new Error(`status 输出里没有 dataDir：${stdout}`);
  return (JSON.parse(`"${m[1]}"`) as string).replaceAll('\\', '/');
};

describe('条件 7：数据目录默认在 ~/.ixaeon/relay', () => {
  // 整合方改（2026-10-23，审测试）：原来没把 LOCALAPPDATA 指开，本机真的旧数据目录会多打一行提醒、
  // 让「不含 appdata」在实现写对时也红；改成 LOCALAPPDATA 指到空的临时目录，并逐字比 dataDir。
  it('不设 IXAEON_RELAY_DIR、HOME/USERPROFILE 指到临时目录 → status 打的就是 ~/.ixaeon/relay', async () => {
    const home = tmp('ixa-l10-home-');
    const w = makeWorld();
    worlds.push(w);
    const r = await w.run(['status'], {
      IXAEON_RELAY_DIR: undefined,
      IXAEON_WORKTREES: tmp('ixa-l10-trees-'),
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: tmp('ixa-l10-local-empty-'),
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    // dataDir 是 <home>/.ixaeon/relay；打印时 home 遮成 ~
    expect(dataDirOf(r.stdout)).toBe('~/.ixaeon/relay');
    // 旧位置都是空的 → 不打提醒；也不该再出现 AppData
    expect(r.stdout).not.toContain('旧的数据目录里还有文件');
    expect(r.stdout.toLowerCase()).not.toContain('appdata');
  }, 120_000);

  // 整合方改（2026-10-23，审测试）：原来断言「不含 turns」——status 本来就打 state 里的 turns，实现写对也红；
  // 改成哨兵字样。契约说「Windows 上再查」：别的系统上不该打这一行。
  it('LOCALAPPDATA/IXAEON/relay 里还有 state.json →（Windows）多打一行旧位置提醒，不带内容', async () => {
    const home = tmp('ixa-l10-home2-');
    const local = tmp('ixa-l10-local-');
    const oldDir = join(local, 'IXAEON', 'relay');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'state.json'), '{"stoppedReason":"SENTINEL-不该出现"}\n', 'utf8');

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
    expect(dataDirOf(r.stdout)).toBe('~/.ixaeon/relay');
    const hint = r.stdout.split('\n').filter((l) => l.includes('旧的数据目录里还有文件'));
    if (process.platform === 'win32') {
      expect(hint).toHaveLength(1);
      expect(hint[0]!.toLowerCase()).toContain(oldDir.toLowerCase());
    } else {
      expect(hint).toHaveLength(0);
    }
    expect(`${r.stdout}${r.stderr}`).not.toContain('SENTINEL');
  }, 120_000);
});
