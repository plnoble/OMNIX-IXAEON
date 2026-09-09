import { existsSync, statSync, renameSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import type { CoreDatabase } from '../db/database.js';
import { openDatabase } from '../db/database.js';
import { migrate, currentMigrationVersion, MIGRATIONS } from '../db/migrations.js';
import { Vault } from '../vault.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { ExportResult, RestorePreview } from '@ixaeon/contracts';
import { recordAudit } from '../audit.js';

/**
 * 导出 / 恢复（计划 2.1.8 / 7；修复 P1-7）。
 *
 * 导出 ZIP 结构（人类可读优先 + 完整副本）：
 * - manifest.json：版本、时间、计数、文件清单
 * - readme.txt：说明（这是 IXAEON 数据导出）
 * - data/projects.json、sources.json、segments.json、items.json、
 *   item-evidence.json、corrections.json、work-runs.json、permissions.json
 *   （字段命名稳定，带 formatVersion；不依赖 IXAEON 即可阅读）
 * - db.sqlite：完整数据库副本（快速完整恢复用；不是唯一数据表达）
 * - vault/：导入原文（sha256/ab/hash 布局，恢复时原样还原）
 *
 * 恢复（原子替换 + 失败回滚）：
 * 1. 临时目录解压全部内容（zip slip 防护：条目路径白名单校验）
 * 2. 临时目录内完成：SQLite 头校验、integrity_check、迁移版本兼容检查、
 *    raw_path 严格格式校验（防恶意路径）、vault 文件与 raw_path 一致性
 * 3. 全部通过 → 关闭当前连接 → 备份当前数据目录（rename，失败即中止）
 * 4. 原子替换（rename staging 目录为正式目录）
 * 5. 任一步失败：staging 废弃 + 备份回滚，原数据保持可用
 */
const MANIFEST_VERSION = 2;
const DATA_FORMAT_VERSION = 2;
const SQLITE_HEADER = 'SQLite format 3';

/** 允许的 ZIP 条目（其余一律拒绝）。 */
const TOP_ENTRIES = new Set([
  'manifest.json',
  'readme.txt',
  'db.sqlite',
  'data/projects.json',
  'data/sources.json',
  'data/segments.json',
  'data/items.json',
  'data/item-evidence.json',
  'data/corrections.json',
  'data/work-runs.json',
  'data/permissions.json',
  'data/item-links.json',
  'data/disclosure-grants.json',
  'data/project-relations.json',
  'data/research-topics.json',
  'data/research-sources.json',
  'data/research-findings.json',
  'data/research-runs.json',
  'data/coding-tasks.json',
  'data/coding-approvals.json',
]);

/**
 * 恢复凭证注册表（修复 R1）：进程级共享，生命周期与主进程一致。
 * previewRestore（实例 A）签发、restoreData（实例 B）消费 —— 同一进程内
 * 任意 ArchiveService 实例都能核销同一张凭证（一次性 + 有效期规则不变）。
 */
const RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000;
const restoreTokenStore = new Map<string, { zipPath: string; expiresAt: number }>();

function issueRestoreToken(zipPath: string): string {
  // 清理过期凭证后签发（进程级共享，修复 R1 实例隔离问题）
  const now = Date.now();
  for (const [t, e] of restoreTokenStore) {
    if (now > e.expiresAt) restoreTokenStore.delete(t);
  }
  const token = randomBytes(24).toString('hex');
  restoreTokenStore.set(token, { zipPath, expiresAt: now + RESTORE_TOKEN_TTL_MS });
  return token;
}

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

  /** 导出全部数据到 ZIP（人类可读 JSON + 完整数据库 + 原文）。 */
  async exportData(targetPath: string): Promise<ExportResult> {
    if (!targetPath.toLowerCase().endsWith('.zip')) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出目标必须是 .zip 文件');
    }
    const zip = new JSZip();
    let fileCount = 0;
    let totalChars = 0;

    // 1) 人类可读数据 JSON（修复 P1-7.1）
    const dataFiles: Array<[string, unknown]> = [
      ['data/projects.json', this.dumpTable('projects')],
      ['data/sources.json', this.dumpTable('sources')],
      ['data/segments.json', this.dumpTable('segments')],
      ['data/items.json', this.dumpTable('items')],
      ['data/item-evidence.json', this.dumpTable('item_evidence')],
      ['data/corrections.json', this.dumpTable('corrections')],
      ['data/work-runs.json', this.dumpTable('work_runs')],
      ['data/permissions.json', this.dumpTable('permissions')],
      ['data/item-links.json', this.dumpTable('item_links')],
      ['data/disclosure-grants.json', this.dumpTable('disclosure_grants')],
      ['data/project-relations.json', this.dumpTable('project_relations')],
      ['data/research-topics.json', this.dumpTable('research_topics')],
      ['data/research-sources.json', this.dumpTable('research_sources')],
      ['data/research-findings.json', this.dumpTable('research_findings')],
      ['data/research-runs.json', this.dumpTable('research_runs')],
      ['data/coding-tasks.json', this.dumpTable('coding_tasks')],
      ['data/coding-approvals.json', this.dumpTable('coding_approvals')],
    ];
    for (const [name, rows] of dataFiles) {
      const payload = {
        formatVersion: DATA_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        count: (rows as unknown[]).length,
        rows,
      };
      const text = JSON.stringify(payload, null, 2);
      zip.file(name, text);
      fileCount += 1;
      totalChars += text.length;
    }

    // 2) manifest.json
    const counts = this.collectCounts();
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: '0.2.3',
      counts,
      dataFormatVersion: DATA_FORMAT_VERSION,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    fileCount += 1;

    // 3) readme.txt（人类可读说明）
    const readme = [
      'IXAEON（析衍）数据导出',
      '=====================',
      '',
      `导出时间：${manifest.exportedAt}`,
      `应用版本：${manifest.appVersion}`,
      `数据库：${counts.sources} 个来源 / ${counts.segments} 个片段 / ${counts.items} 条结论`,
      '',
      '内容：',
      '- data/*.json：项目、来源、片段、当前理解、依据、纠正、工作记录、权限、关联、分享授权、项目关系提案、研究关注、编码任务',
      '  （人类可读 JSON，字段命名稳定，带 formatVersion）',
      '- db.sqlite：数据库副本（完整快速恢复用）',
      '- vault/：导入原文（sha256/xx/<64位哈希> 布局，逐字保留）',
      '',
      '恢复：在 IXAEON 桌面端"设置 → 本地数据"中选择本文件，',
      '先预览确认再恢复。恢复会原子替换当前全部数据（旧数据备份为 .bak-<时间>）。',
    ].join('\n');
    zip.file('readme.txt', readme);
    fileCount += 1;

    // 4) db.sqlite（WAL checkpoint 后复制）
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const dbBuffer = await readFile(this.deps.dbPath);
    zip.file('db.sqlite', dbBuffer);
    fileCount += 1;

    // 5) vault/（全部原文；raw_path 严格校验防越界读取）
    const vaultFiles = this.listVaultFiles();
    for (const rel of vaultFiles) {
      const content = await readFile(this.vaultAbsPath(rel));
      // raw_path 形如 sha256/xx/hash；ZIP 条目为 vault/xx/hash（统一正斜杠）
      zip.file(`vault/${rel.replace(/\\/g, '/').slice('sha256/'.length)}`, content);
      fileCount += 1;
      totalChars += content.length;
    }
    // 数据库文本字符（合计参考值）
    totalChars += this.dbTextChars();

    // 6) 写 ZIP
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await writeFile(targetPath, buffer);

    recordAudit(this.db, 'data.exported', { targetPath, fileCount, totalChars });

    return { zipPath: targetPath, fileCount, totalChars };
  }

  /** 恢复预览（只读；签发一次性 previewToken，恢复必须携带）。 */
  async previewRestore(zipPath: string): Promise<RestorePreview> {
    const { manifest, zip } = await this.openAndValidateManifest(zipPath);

    const dbFile = zip.file('db.sqlite');
    const warnings: string[] = [];
    let projects: Array<{ id: string; name: string }> = [];
    if (!dbFile) {
      warnings.push('导出包缺少 db.sqlite（无法恢复）');
    } else {
      const inspect = await this.inspectDbInZip(dbFile, zipPath);
      projects = inspect.projects;
      warnings.push(...inspect.warnings);
    }
    // 人类可读 JSON 检查（提示可读性）
    if (!zip.file('data/projects.json')) {
      warnings.push('导出包缺少人类可读 data/*.json（较旧版本导出）');
    }
    // 恢复会替换现有数据的提醒
    const currentCounts = this.collectCounts();
    warnings.push(
      `恢复将替换当前全部数据（当前：${currentCounts.projects} 项目 / ` +
        `${currentCounts.sources} 来源 / ${currentCounts.items} 条结论）；` +
        `旧数据将备份为 .bak-<时间戳> 目录。`,
    );

    // 签发一次性恢复凭证（进程级注册表，10 分钟有效）
    const previewToken = issueRestoreToken(zipPath);

    return {
      manifestVersion: manifest.manifestVersion,
      exportedAt: manifest.exportedAt,
      appVersion: manifest.appVersion,
      counts: manifest.counts,
      projects,
      warnings,
      previewToken,
    };
  }

  /** 消费一次性恢复凭证（伪造/过期/重复使用必须失败）。 */
  consumePreviewToken(token: string): string {
    const entry = restoreTokenStore.get(token);
    if (!entry) {
      throw new IxaError(
        ErrorCodes.INVALID_TOKEN,
        '恢复凭证无效：请先执行「预览」确认导出包内容，再恢复',
      );
    }
    restoreTokenStore.delete(token); // 一次性使用
    if (Date.now() > entry.expiresAt) {
      throw new IxaError(ErrorCodes.INVALID_TOKEN, '恢复凭证已过期：请重新预览导出包');
    }
    return entry.zipPath;
  }

  /** 带凭证恢复：先消费 previewToken，再执行原子替换（空 token 视为未预览）。 */
  async restoreDataWithToken(previewToken: string): Promise<{ ok: true; backupDir: string }> {
    const zipPath = this.consumePreviewToken(previewToken);
    return this.restoreData(zipPath);
  }

  /**
   * 恢复（整体原子替换 + 失败回滚）：
   * 1. 临时目录解压 + 全部校验（zip slip / SQLite 完整性 / 迁移兼容 / raw_path 严格格式）
   * 2. 校验通过 → 备份当前数据目录（rename 失败立即中止，不吞异常）
   * 3. staging → 正式目录替换；任一步失败 → 按每一步实际完成情况精确回滚
   *    （修复 R2：备份半途失败也还原已移走的旧库；安装半途失败连 vault 一起回滚，
   *    不留「新数据库＋旧 vault」的混合状态）
   */
  async restoreData(zipPath: string): Promise<{ ok: true; backupDir: string }> {
    const stagingDir = `${this.deps.dataDir}.restore-staging-${Date.now()}`;
    const backupDir = `${this.deps.dataDir}.bak-${Date.now()}`;
    // 每一步的实际完成情况（回滚依据）
    let oldDbInBackup = false;
    let oldVaultInBackup = false;
    let newDbInstalled = false;
    let newVaultInstalled = false;
    let closed = false;

    try {
      const { manifest, zip } = await this.openAndValidateManifest(zipPath);
      if (manifest.manifestVersion < 1 || manifest.manifestVersion > MANIFEST_VERSION) {
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

      // 1) 条目白名单 + zip slip 防护 → 解压到 staging
      await mkdir(stagingDir, { recursive: true });
      const vaultEntries: Array<{ rel: string; data: Buffer }> = [];
      for (const [rawName, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        // 条目名统一正斜杠（不同平台导出可能带反斜杠）
        const name = rawName.replace(/\\/g, '/');
        if (name === 'manifest.json' || name === 'readme.txt' || name === 'db.sqlite') continue;
        if (TOP_ENTRIES.has(name)) continue;
        if (!name.startsWith('vault/')) {
          throw new IxaError(ErrorCodes.VALIDATION_FAILED, `导出包含未知条目（拒绝）：${name}`);
        }
        const rel = name.slice('vault/'.length);
        if (!Vault.isStrictVaultRelPath(`sha256/${rel}`)) {
          throw new IxaError(
            ErrorCodes.VALIDATION_FAILED,
            `非法路径条目（zip slip 防护）：${name}`,
          );
        }
        vaultEntries.push({ rel, data: await entry.async('nodebuffer') });
      }
      // vault 相对路径 sha256/xx/hash → 物理布局 xx/hash
      for (const { rel, data } of vaultEntries) {
        const abs = join(stagingDir, 'vault', rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, data);
      }
      await writeFile(join(stagingDir, 'ixaeon.db'), dbBuffer);

      // 2) staging 内校验：完整性 + 迁移兼容 + raw_path 严格格式
      const stagingDb = openDatabase(join(stagingDir, 'ixaeon.db'));
      try {
        const integrity = stagingDb.pragma('integrity_check') as Array<{
          integrity_check: string;
        }>;
        if (integrity.length === 0 || integrity[0]!.integrity_check !== 'ok') {
          throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出包数据库完整性检查未通过');
        }
        const version = currentMigrationVersion(stagingDb);
        if (version > MIGRATIONS[MIGRATIONS.length - 1]!.id) {
          throw new IxaError(
            ErrorCodes.VALIDATION_FAILED,
            `导出包数据库来自更新的版本（迁移 ${version}，本应用最高 ${MIGRATIONS[MIGRATIONS.length - 1]!.id}），拒绝恢复`,
          );
        }
        // raw_path 严格校验：恶意路径（../、绝对路径、盘符、错误哈希长度）在替换前拒绝。
        // Windows 导出的 raw_path 含反斜杠 —— 统一按正斜杠校验后要求库内写回规范形态。
        const rawPaths = stagingDb
          .prepare('SELECT raw_path FROM sources WHERE raw_path IS NOT NULL')
          .all() as Array<{ raw_path: string }>;
        const normalizeRawPath = (p: string): string => p.replace(/\\/g, '/');
        const updateRawPath = stagingDb.prepare(
          'UPDATE sources SET raw_path = ? WHERE raw_path = ?',
        );
        for (const { raw_path } of rawPaths) {
          const normalized = normalizeRawPath(raw_path);
          if (!isStrictRawPath(normalized)) {
            throw new IxaError(
              ErrorCodes.VALIDATION_FAILED,
              `导出包数据库含非法 raw_path（拒绝恢复）：${raw_path.slice(0, 60)}`,
            );
          }
          const expected = `sha256/${normalized.slice(7, 9)}/${normalized.slice(10)}`;
          if (normalized !== expected) {
            throw new IxaError(
              ErrorCodes.VALIDATION_FAILED,
              `raw_path 与 sha256 布局不一致（拒绝恢复）：${raw_path.slice(0, 60)}`,
            );
          }
          // 规范化写回（跨平台导出包统一为正斜杠形态）
          if (normalized !== raw_path) {
            updateRawPath.run(normalized, raw_path);
          }
        }
        // raw_path 指向的 vault 文件必须存在于包内（防半套数据）
        for (const { raw_path } of rawPaths) {
          const normalized = normalizeRawPath(raw_path);
          const abs = join(stagingDir, 'vault', normalized.slice('sha256/'.length));
          if (!existsSync(abs)) {
            throw new IxaError(
              ErrorCodes.VALIDATION_FAILED,
              `导出包缺少 raw_path 对应的原文文件：${normalized.slice(0, 60)}`,
            );
          }
        }
        // 迁移到当前 schema（旧导出包向前兼容）
        migrate(stagingDb);
      } finally {
        stagingDb.close();
      }

      // 3) 关闭当前连接（Windows 上打开中的文件无法 rename）
      this.deps.closeCurrentDb();
      closed = true;

      // 4) 备份当前数据目录（rename 失败立即中止 —— 修复静默吞异常）
      const vaultRoot = join(this.deps.dataDir, 'vault');
      const logsDir = join(this.deps.dataDir, 'logs');
      await mkdir(backupDir, { recursive: true });
      if (existsSync(this.deps.dbPath)) {
        renameSync(this.deps.dbPath, join(backupDir, 'ixaeon.db'));
        oldDbInBackup = true;
      }
      if (existsSync(vaultRoot)) {
        renameSync(vaultRoot, join(backupDir, 'vault'));
        oldVaultInBackup = true;
      }
      if (existsSync(logsDir)) {
        try {
          renameSync(logsDir, join(backupDir, 'logs'));
        } catch {
          // 日志目录非关键：留在原处不影响数据一致性
        }
      }

      // 5) staging → 正式目录替换（数据库 + vault；记录每步完成状态供回滚）
      const newDb = join(stagingDir, 'ixaeon.db');
      const newVault = join(stagingDir, 'vault');
      renameSync(newDb, this.deps.dbPath);
      newDbInstalled = true;
      if (existsSync(newVault)) {
        const targetVault = join(this.deps.dataDir, 'vault');
        if (existsSync(targetVault)) rmSync(targetVault, { recursive: true, force: true });
        renameSync(newVault, targetVault);
        newVaultInstalled = true;
      }

      // 6) 替换后校验（可打开 + 完整性）
      const check = openDatabase(this.deps.dbPath);
      try {
        const integrity = check.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (integrity.length === 0 || integrity[0]!.integrity_check !== 'ok') {
          throw new IxaError(ErrorCodes.UNKNOWN, '恢复后数据库完整性检查失败');
        }
      } finally {
        check.close();
      }

      // staging 清理（config.json 不迁移：恢复保持当前机器的本地令牌/扩展配对）
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: true, backupDir };
    } catch (err) {
      // 精确回滚（修复 R2）：按每一步实际完成情况还原，保证数据库与 vault 一起回去
      let rollbackError: Error | null = null;
      const vaultRoot = join(this.deps.dataDir, 'vault');
      const logsDir = join(this.deps.dataDir, 'logs');
      try {
        // a) 移开所有已安装的新数据（不完整的新库/新 vault 一律退出正式位置）
        if (newVaultInstalled) {
          rmSync(vaultRoot, { recursive: true, force: true });
        } else if (existsSync(vaultRoot) && oldVaultInBackup) {
          // vault 安装中途失败留下的部分内容：移到 staging 保留供核查，不混入旧数据
          const partial = join(stagingDir, 'vault-partial');
          renameSync(vaultRoot, partial);
        }
        if (newDbInstalled && existsSync(this.deps.dbPath)) {
          rmSync(this.deps.dbPath, { force: true });
        }
        // b) 旧数据从备份回到原位（数据库与 vault 都恢复）
        if (oldVaultInBackup && existsSync(join(backupDir, 'vault'))) {
          renameSync(join(backupDir, 'vault'), vaultRoot);
        }
        if (oldDbInBackup && existsSync(join(backupDir, 'ixaeon.db'))) {
          renameSync(join(backupDir, 'ixaeon.db'), this.deps.dbPath);
        }
        // c) 日志目录跟随还原（尽力而为）
        if (existsSync(join(backupDir, 'logs')) && !existsSync(logsDir)) {
          renameSync(join(backupDir, 'logs'), logsDir);
        }
      } catch (rollbackErr) {
        // 回滚失败是极端情况（磁盘故障）：备份目录仍在，数据未丢失，但必须明确报错
        rollbackError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        process.stderr.write(
          `[ixaeon-restore] ${new Date().toISOString()} 恢复回滚异常（备份保留于 ${backupDir}）：${String(rollbackErr)}\n`,
        );
      }
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (rollbackError) {
        // 修复 N5：回滚自身失败是独立的故障状态 —— 抛出的错误携带
        // rollbackIncomplete 标记，调用方（AppRuntime）据此进入恢复故障态，
        // 不得自动创建空数据库或恢复正常写入。
        const fault = new IxaError(
          ErrorCodes.UNKNOWN,
          `恢复失败且回滚未完成（旧数据完整保留在备份目录 ${backupDir}，需手动恢复）：${String(rollbackError)}`,
        );
        (fault as IxaError & { rollbackIncomplete: true; backupDir: string }).rollbackIncomplete =
          true;
        (fault as IxaError & { rollbackIncomplete: true; backupDir: string }).backupDir = backupDir;
        throw fault;
      }
      if (closed) {
        // 连接已关闭且数据已回滚：调用方（AppRuntime）负责重开数据库并重启服务
      }
      throw err;
    }
  }

  // --- 内部 ---

  private dumpTable(table: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  }

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
      item_links: count('item_links'),
      disclosure_grants: count('disclosure_grants'),
      project_relations: count('project_relations'),
      research_topics: count('research_topics'),
      research_sources: count('research_sources'),
      research_findings: count('research_findings'),
      research_runs: count('research_runs'),
      coding_tasks: count('coding_tasks'),
      coding_approvals: count('coding_approvals'),
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

  /** raw_path（sha256/ab/hash 严格格式）→ vault 内物理绝对路径。 */
  private vaultAbsPath(rel: string): string {
    return this.deps.vault.absolutePath(rel);
  }

  private async openAndValidateManifest(zipPath: string): Promise<{
    manifest: {
      manifestVersion: number;
      exportedAt: string;
      appVersion: string;
      counts: Record<string, number>;
    };
    zip: JSZip;
  }> {
    let data: Buffer;
    try {
      data = await readFile(zipPath);
    } catch {
      throw new IxaError(ErrorCodes.NOT_FOUND, `导出包不存在：${zipPath}`);
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出包不是有效的 ZIP 文件');
    }
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
      manifest: {
        manifestVersion: m.manifestVersion,
        exportedAt: typeof m.exportedAt === 'string' ? m.exportedAt : '',
        appVersion: typeof m.appVersion === 'string' ? m.appVersion : '',
        counts: (m.counts as Record<string, number>) ?? {},
      },
      zip,
    };
  }

  /** 在临时文件上打开 zip 内 db 只读检查（预览用）。 */
  private async inspectDbInZip(
    dbFile: JSZip.JSZipObject,
    zipPath: string,
  ): Promise<{
    projects: Array<{ id: string; name: string }>;
    warnings: string[];
  }> {
    const buffer = await dbFile.async('nodebuffer');
    if (buffer.subarray(0, 15).toString('utf8') !== SQLITE_HEADER) {
      return { projects: [], warnings: ['db.sqlite 损坏（非 SQLite 格式）'] };
    }
    const tmp = `${zipPath}.inspect-${Date.now()}.sqlite`;
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
      // raw_path 严格校验（预览阶段就发现恶意路径）
      const badPaths = db
        .prepare('SELECT COUNT(*) AS n FROM sources WHERE raw_path IS NOT NULL')
        .get() as { n: number };
      if (badPaths.n > 0) {
        const checked = db
          .prepare('SELECT raw_path FROM sources WHERE raw_path IS NOT NULL LIMIT 500')
          .all() as Array<{ raw_path: string }>;
        if (checked.some((r) => !isStrictRawPath(r.raw_path))) {
          warnings.push('数据库含非法 raw_path（恢复将被拒绝）');
        }
      }
      db.close();
      return { projects, warnings };
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

function isStrictRawPath(rawPath: string): boolean {
  return /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(rawPath.replace(/\\/g, '/'));
}
