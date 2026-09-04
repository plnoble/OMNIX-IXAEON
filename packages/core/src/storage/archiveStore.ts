import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import type { CoreDatabase } from '../db/database.js';
import { openDatabase } from '../db/database.js';
import type { Vault } from '../vault.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { ExportResult, RestorePreview } from '@ixaeon/contracts';
import { recordAudit } from '../audit.js';

/**
 * 导出 / 恢复（计划 7.x）。
 *
 * 导出 ZIP 结构（全部人类可读 + manifest 校验）：
 * - manifest.json：版本、时间、计数
 * - readme.txt：说明（这是 IXAEON 数据导出）
 * - db.sqlite：完整数据库副本
 * - vault/：导入原文（sha256/ab/hash 布局，恢复时原样还原）
 *
 * 安全：
 * - 恢复只接受本应用导出的 ZIP（manifest + db 副本校验）
 * - ZIP 条目路径全部校验（zip slip 防护：拒绝 .. / 绝对路径 / 盘符）
 * - 恢复必须先 previewRestore（预览确认）；恢复前自动备份当前数据
 */
const MANIFEST_VERSION = 1;
const SQLITE_HEADER = 'SQLite format 3';

export class ArchiveService {
  constructor(
    private readonly db: CoreDatabase,
    private readonly deps: {
      dataDir: string;
      dbPath: string;
      /** Vault 实例（raw_path 解析 + 恢复时重建布局） */
      vault: Vault;
      /** 恢复时由调用方关闭当前连接后执行替换（见 restoreData） */
      closeCurrentDb: () => void;
    },
  ) {}

  /** 导出全部数据到 ZIP。 */
  async exportData(targetPath: string): Promise<ExportResult> {
    if (!targetPath.toLowerCase().endsWith('.zip')) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出目标必须是 .zip 文件');
    }
    const zip = new JSZip();
    let fileCount = 0;
    let totalChars = 0;

    // 1) manifest.json
    const counts = this.collectCounts();
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      counts,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    fileCount += 1;

    // 2) readme.txt（人类可读说明）
    const readme = [
      'IXAEON（析衍）数据导出',
      '=====================',
      '',
      `导出时间：${manifest.exportedAt}`,
      `应用版本：${manifest.appVersion}`,
      `数据库：${counts.sources} 个来源 / ${counts.segments} 个片段 / ${counts.items} 条结论`,
      '',
      '内容：',
      '- manifest.json：清单（版本与计数）',
      '- db.sqlite：数据库副本（项目、来源、条目、工作记录、审计）',
      '- vault/：导入原文（保留原始文件内容）',
      '',
      '恢复：在 IXAEON 桌面端"设置 → 数据"中选择本文件，',
      '先预览确认再恢复。恢复会替换当前全部数据（旧数据自动备份为 .bak-<时间>）。',
    ].join('\n');
    zip.file('readme.txt', readme);
    fileCount += 1;

    // 3) db.sqlite（WAL checkpoint 后复制）
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const dbBuffer = await readFile(this.deps.dbPath);
    zip.file('db.sqlite', dbBuffer);
    fileCount += 1;

    // 4) vault/（全部原文）
    const vaultFiles = this.listVaultFiles();
    for (const rel of vaultFiles) {
      const content = await readFile(this.vaultAbsPath(rel));
      zip.file(`vault/${rel}`, content);
      fileCount += 1;
      totalChars += content.length;
    }
    // 数据库文本字符（合计参考值）
    totalChars += this.dbTextChars();

    // 5) 写 ZIP
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await writeFile(targetPath, buffer);

    recordAudit(this.db, 'data.exported', { targetPath, fileCount, totalChars });

    return { zipPath: targetPath, fileCount, totalChars };
  }

  /** 恢复预览（只读；不写任何数据）。 */
  async previewRestore(zipPath: string): Promise<RestorePreview> {
    const zip = await this.openExportZip(zipPath);
    const manifest = await this.readManifest(zip);

    const dbFile = zip.file('db.sqlite');
    const warnings: string[] = [];
    let projects: Array<{ id: string; name: string }> = [];
    if (!dbFile) {
      warnings.push('导出包缺少 db.sqlite（无法恢复）');
    } else {
      const inspect = await this.inspectDbInZip(dbFile);
      projects = inspect.projects;
      warnings.push(...inspect.warnings);
    }
    // 恢复会替换现有数据的提醒
    const currentCounts = this.collectCounts();
    warnings.push(
      `恢复将替换当前全部数据（当前：${currentCounts.projects} 项目 / ` +
        `${currentCounts.sources} 来源 / ${currentCounts.items} 条结论）；` +
        `旧数据将备份为 .bak-<时间戳> 目录。`,
    );

    return {
      manifestVersion: manifest.manifestVersion,
      exportedAt: manifest.exportedAt,
      appVersion: manifest.appVersion,
      counts: manifest.counts,
      projects,
      warnings,
    };
  }

  /**
   * 恢复（整体替换）：
   * 1. 校验 zip（manifest + db + vault 条目路径安全）
   * 2. 备份当前数据目录 → dataDir.bak-<ts>/
   * 3. 关闭当前 db 连接（调用方回调）
   * 4. 写入新 db.sqlite 与 vault 文件
   */
  async restoreData(zipPath: string): Promise<{ ok: true; backupDir: string }> {
    const zip = await this.openExportZip(zipPath);
    const manifest = await this.readManifest(zip);
    if (manifest.manifestVersion !== MANIFEST_VERSION) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `不支持的清单版本 ${manifest.manifestVersion}（当前 ${MANIFEST_VERSION}）`,
      );
    }
    const dbFile = zip.file('db.sqlite');
    if (!dbFile) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出包缺少 db.sqlite，无法恢复');
    }
    const dbBuffer = await dbFile.async('nodebuffer');
    if (dbBuffer.length < 100 || dbBuffer.subarray(0, 15).toString('utf8') !== SQLITE_HEADER) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'db.sqlite 不是有效的 SQLite 数据库');
    }

    // zip slip 防护 + 未知条目拒绝（只允许 vault/ 下的安全相对路径）
    const vaultEntries: Array<{ rel: string; data: Buffer }> = [];
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir || name === 'manifest.json' || name === 'readme.txt' || name === 'db.sqlite') {
        continue;
      }
      if (!name.startsWith('vault/')) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, `导出包含未知条目（拒绝）：${name}`);
      }
      const rel = name.slice('vault/'.length);
      if (!this.isSafeRelativePath(rel)) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, `非法路径条目（zip slip 防护）：${name}`);
      }
      vaultEntries.push({ rel, data: await entry.async('nodebuffer') });
    }

    // 1) 关闭当前连接（Windows 上打开中的文件无法 rename）
    this.deps.closeCurrentDb();

    // 2) 备份当前数据目录
    const backupDir = `${this.deps.dataDir}.bak-${Date.now()}`;
    await mkdir(backupDir, { recursive: true });
    // 移动当前文件（rename 失败时退化为留在原地，随后被新数据覆盖）
    const { rename } = await import('node:fs/promises');
    await rename(this.deps.dbPath, join(backupDir, 'ixaeon.db')).catch(() => {});
    const vaultRoot = this.deps.vault.absolutePath('sha256/x').slice(0, -2);
    if (existsSync(vaultRoot)) {
      await rename(vaultRoot, join(backupDir, 'vault')).catch(() => {});
    }

    // 3) 写入新数据（vault 条目按 sha256/ab/hash → 物理布局 ab/hash）
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(this.deps.dbPath, dbBuffer);
    for (const { rel, data } of vaultEntries) {
      const abs = this.vaultAbsPath(rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, data);
    }

    // 4) 校验恢复后的数据库可打开
    const check = openDatabase(this.deps.dbPath);
    const integrity = check.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const okIntegrity = integrity.length > 0 && integrity[0]!.integrity_check === 'ok';
    check.close();
    if (!okIntegrity) {
      throw new IxaError(ErrorCodes.UNKNOWN, '恢复后数据库完整性检查失败');
    }

    return { ok: true, backupDir };
  }

  // --- 内部 ---

  private collectCounts(): Record<string, number> {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      projects: count('projects'),
      sources: count('sources'),
      segments: count('segments'),
      items: count('items'),
      item_evidence: count('item_evidence'),
      corrections: count('corrections'),
      work_runs: count('work_runs'),
      permissions: count('permissions'),
      audit_events: count('audit_events'),
    };
  }

  private dbTextChars(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM segments')
      .get() as { chars: number };
    return row.chars;
  }

  private listVaultFiles(): string[] {
    const rows = this.db
      .prepare('SELECT raw_path FROM sources WHERE raw_path IS NOT NULL')
      .all() as Array<{ raw_path: string }>;
    const files: string[] = [];
    for (const { raw_path } of rows) {
      const abs = this.vaultAbsPath(raw_path);
      if (existsSync(abs) && statSync(abs).isFile() && !files.includes(raw_path)) {
        files.push(raw_path);
      }
    }
    return files;
  }

  /** raw_path 形如 vault/ab/hash.ext（数据目录相对路径）。 */
  /** raw_path（sha256/ab/hash）→ vault 内物理绝对路径。 */
  private vaultAbsPath(rel: string): string {
    return this.deps.vault.absolutePath(rel);
  }

  private async openExportZip(zipPath: string): Promise<JSZip> {
    let data: Buffer;
    try {
      data = await readFile(zipPath);
    } catch {
      throw new IxaError(ErrorCodes.NOT_FOUND, `导出包不存在：${zipPath}`);
    }
    try {
      return await JSZip.loadAsync(data);
    } catch {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出包不是有效的 ZIP 文件');
    }
  }

  private async readManifest(zip: JSZip): Promise<{
    manifestVersion: number;
    exportedAt: string;
    appVersion: string;
    counts: Record<string, number>;
  }> {
    const file = zip.file('manifest.json');
    if (!file) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出包缺少 manifest.json');
    }
    const text = await file.async('string');
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'manifest.json 解析失败');
    }
    const m = manifest as {
      manifestVersion?: unknown;
      exportedAt?: unknown;
      appVersion?: unknown;
      counts?: unknown;
    };
    if (typeof m.manifestVersion !== 'number') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'manifest.json 缺少版本号');
    }
    return {
      manifestVersion: m.manifestVersion,
      exportedAt: typeof m.exportedAt === 'string' ? m.exportedAt : '',
      appVersion: typeof m.appVersion === 'string' ? m.appVersion : '',
      counts: (m.counts as Record<string, number>) ?? {},
    };
  }

  /** 在临时文件上打开 zip 内 db 只读检查（预览用）。 */
  private async inspectDbInZip(dbFile: JSZip.JSZipObject): Promise<{
    projects: Array<{ id: string; name: string }>;
    warnings: string[];
  }> {
    const buffer = await dbFile.async('nodebuffer');
    if (buffer.subarray(0, 15).toString('utf8') !== SQLITE_HEADER) {
      return { projects: [], warnings: ['db.sqlite 损坏（非 SQLite 格式）'] };
    }
    const tmp = join(this.deps.dataDir, `restore-inspect-${Date.now()}.sqlite`);
    await writeFile(tmp, buffer);
    try {
      const db = openDatabase(tmp);
      const projects = db.prepare('SELECT id, name FROM projects').all() as Array<{
        id: string;
        name: string;
      }>;
      const warnings: string[] = [];
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length > 0 && integrity[0]!.integrity_check !== 'ok') {
        warnings.push('数据库完整性检查未通过');
      }
      db.close();
      return { projects, warnings };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private isSafeRelativePath(rel: string): boolean {
    if (rel.length === 0) return false;
    if (rel.split(/[\\/]/).includes('..')) return false;
    if (rel.startsWith('/') || rel.startsWith('\\')) return false;
    if (/^[a-zA-Z]:[\\/]/.test(rel)) return false;
    return true;
  }
}
