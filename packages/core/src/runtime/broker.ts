import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { ItemService } from '../storage/itemStore.js';
import { SearchService } from '../storage/search.js';
import { assertSourceAuthorized, modelMayReadItem } from '../access.js';
import { CodingOrchestrator } from '../execution/executor.js';
import { ProjectService } from '../projects.js';
import { fetchApprovedSource, type FetchDeps } from '../research/fetchApproved.js';
import type { WebSearchExecutor } from '../research/webSearch.js';
import { SkillCandidateStore } from './skills.js';
import { createRetrievalAdapter } from '../storage/retrieval.js';
import { sanitizePublicQuery } from '../memory/querySanitize.js';

export const CORE_TOOL_NAMES = [
  'search_memory',
  'get_evidence',
  'get_project_context',
  'record_observation',
  'search_web',
  'read_web',
  'propose_task',
  'dispatch_coding_task',
  'get_task_result',
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

export interface BrokerContext {
  audience: 'model' | 'coding_client';
  runId: string;
  projectId?: string | null;
}

/**
 * Runtime 只能通过这里碰 Core。模型参数里的 approved=true 不算授权。
 */
export class CoreToolBroker {
  constructor(
    private readonly db: CoreDatabase,
    private readonly items: ItemService,
    private readonly search: SearchService,
    private readonly coding: CodingOrchestrator,
    private readonly projects: ProjectService,
    private readonly fetchDeps: FetchDeps = {},
    /** 受控网页搜索（B3）；未配置时 search_web 诚实失败 */
    private readonly webSearch?: WebSearchExecutor,
  ) {}

  async invoke(
    name: CoreToolName,
    args: Record<string, unknown>,
    ctx: BrokerContext,
  ): Promise<unknown> {
    switch (name) {
      case 'search_memory': {
        const q = String(args.query ?? '').trim();
        if (!q) throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'search_memory 需要 query');
        const projectId =
          typeof args.projectId === 'string' ? args.projectId : (ctx.projectId ?? null);
        const retrieved = createRetrievalAdapter(this.db).lookup(q, { projectId, limit: 8 });
        const items = retrieved.items.filter(
          (item) => ctx.audience !== 'model' || modelMayReadItem(this.db, item.ref),
        );
        return {
          backend: retrieved.backend,
          degraded: retrieved.degraded,
          notice: retrieved.notice,
          segments: retrieved.segments.map((h) => ({
            segmentId: h.segmentId,
            title: h.sourceTitle,
            excerpt: h.excerpt,
          })),
          items: items.map((item) => ({
            id: item.ref,
            type: item.type,
            statement: item.excerpt,
            projectId: item.project_id,
          })),
        };
      }
      case 'get_evidence': {
        const itemId = String(args.itemId ?? '');
        const item = this.items.get(itemId);
        if (ctx.audience === 'model' && !modelMayReadItem(this.db, itemId)) {
          throw new IxaError(ErrorCodes.SCOPE_DENIED, '该条目未获准外发给模型');
        }
        if (item.extracted_from_source_id) {
          assertSourceAuthorized(this.db, item.extracted_from_source_id);
        }
        return { id: item.id, statement: item.statement, origin: item.origin, type: item.type };
      }
      case 'get_project_context': {
        const projectId = String(args.projectId ?? ctx.projectId ?? '').trim();
        if (!projectId) {
          throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'get_project_context 需要 projectId');
        }
        const project = this.projects.get(projectId);
        if (!project) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${projectId}`);
        const skills = new SkillCandidateStore(this.db).approvedForProject(projectId);
        const goals = this.items
          .list({ projectId, type: 'goal', shelved: false, excludeSuperseded: true })
          .filter((i) => i.origin === 'user' || i.confirmation === 'confirmed')
          .slice(0, 8)
          .map((i) => i.statement);
        return {
          id: project.id,
          name: project.name,
          purpose: project.purpose,
          currentState: project.current_state,
          capabilities: project.capabilities,
          unknowns: project.unknowns,
          rootPathPresent: Boolean(project.root_path),
          goals,
          approvedSkills: skills.map((s) => ({ id: s.id, title: s.title, method: s.method })),
        };
      }
      case 'record_observation': {
        const statement = String(args.statement ?? '').trim();
        if (!statement) {
          throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'record_observation 需要 statement');
        }
        const projectId =
          typeof args.projectId === 'string' ? args.projectId : (ctx.projectId ?? null);
        const item = this.items.createAssistantSuggestion({
          projectId,
          type: 'open_loop',
          statement,
          rationale: 'runtime observation; not a user goal',
          scope: projectId ? 'project' : 'unassigned',
        });
        return { id: item.id, origin: item.origin, type: item.type };
      }
      case 'search_web': {
        const raw = String(args.query ?? '').trim();
        const sanitized = sanitizePublicQuery(raw);
        if (!sanitized.query) {
          throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'search_web 需要可公开的 query');
        }
        if (!this.webSearch) {
          throw new IxaError(
            ErrorCodes.SERVER_UNAVAILABLE,
            `真实搜索入口未配置（缺服务/Key）。公开查询已本地检查（redacted=${sanitized.redacted}）：${sanitized.query}。不能把用户给网址或模拟页面当成搜索完成。`,
          );
        }
        const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 10);
        const outcome = await this.webSearch.search(sanitized.query, limit);
        return {
          provider: outcome.provider,
          redacted: sanitized.redacted,
          reasons: sanitized.reasons,
          query: outcome.query,
          hits: outcome.hits,
        };
      }
      case 'read_web': {
        const url = String(args.url ?? '').trim();
        if (!url) throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'read_web 需要 url');
        const approved = this.db
          .prepare('SELECT id FROM research_sources WHERE url = ? LIMIT 1')
          .get(url) as { id: string } | undefined;
        if (!approved) {
          throw new IxaError(
            ErrorCodes.PERMISSION_DENIED,
            '网页读取只允许已批准研究来源；无 URL 搜索未接通前不开放任意抓取。',
          );
        }
        const fetched = await fetchApprovedSource(url, this.fetchDeps);
        return {
          finalUrl: fetched.finalUrl,
          status: fetched.status,
          excerpt: fetched.body.slice(0, 2000),
        };
      }
      case 'propose_task': {
        const projectId = String(args.projectId ?? ctx.projectId ?? '');
        const goal = String(args.goal ?? '').trim();
        if (!projectId || !goal) {
          throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'propose_task 需要 projectId 与 goal');
        }
        const scope = Array.isArray(args.scope) ? (args.scope as string[]) : ['note.txt'];
        return this.coding.create({
          projectId,
          goal,
          scope,
          allowedCommands: [
            [
              process.execPath,
              '-e',
              "const fs=require('fs');if(!fs.existsSync('note.txt'))process.exit(2);if(!String(fs.readFileSync('note.txt','utf8')).trim())process.exit(3);",
            ],
          ],
        });
      }
      case 'dispatch_coding_task':
        throw new IxaError(
          ErrorCodes.PERMISSION_DENIED,
          '派发编码必须由桌面用户批准，不能由模型参数授权',
        );
      case 'get_task_result': {
        const id = String(args.taskId ?? '');
        return this.coding.store.get(id);
      }
      default:
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, `未知工具：${name as string}`);
    }
  }
}
