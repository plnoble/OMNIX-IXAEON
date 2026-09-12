import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, runDeterministicMemoryEval } from '../../src/index.js';
import type { CoreDatabase } from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-memeval-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('B0/§9.1 记忆评测起始集（确定性子集，合成语料）', () => {
  it('60 个场景、六类各 10 个，全部确定性检查通过', () => {
    const report = runDeterministicMemoryEval(db);
    expect(report.scenarioCount).toBe(60);
    expect(report.categories).toHaveLength(6);
    for (const cat of report.categories) {
      expect(cat.total).toBe(10);
    }
    const failures = report.categories.flatMap((c) => c.failures);
    expect(failures).toEqual([]);
  });

  it('报告明示模型指标未运行，不冒充 ≥90%/95% 达成', () => {
    const report = runDeterministicMemoryEval(db);
    expect(report.modelRunNote).toMatch(/尚未运行|需真实模型/);
    expect(report.knownLimitations.length).toBeGreaterThan(0);
  });
});
