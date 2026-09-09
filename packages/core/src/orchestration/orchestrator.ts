import { z } from 'zod';
import { ErrorCodes, IxaError, type ProjectRelation } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import { ItemService } from '../storage/itemStore.js';
import { RelationService, type ProposeRelationInput } from './relationStore.js';
import { buildPersonalOverview } from '../personal/overview.js';

const TOOL_NAMES = ['retrieve_items', 'get_evidence', 'propose_relation', 'stop'] as const;
export type OrchestratorToolName = (typeof TOOL_NAMES)[number];

const uuidLike = z.string().uuid();

const retrieveArgsSchema = z.object({
  query: z.string().min(1).max(400),
  type: z.enum(['goal', 'constraint', 'decision', 'preference', 'open_loop']).optional(),
});

const evidenceArgsSchema = z.object({
  itemId: uuidLike,
});

const proposeArgsSchema = z.object({
  kind: z.enum([
    'serves_goal',
    'depends_on',
    'provides_capability',
    'reusable',
    'suspected_duplicate',
    'conflict',
  ]),
  fromProjectId: uuidLike,
  toEntityKind: z.enum(['project', 'item']),
  toEntityId: z.string().min(1).max(80),
  rationale: z.string().min(1).max(2000),
  evidenceItemIds: z.array(uuidLike).min(1).max(8),
  benefit: z.string().max(500).nullable().optional(),
  cost: z.string().max(500).nullable().optional(),
  independentAlternative: z.string().max(500).nullable().optional(),
});

const actionSchema = z.object({
  tool: z.enum(TOOL_NAMES),
  args: z.record(z.string(), z.unknown()).default({}),
  note: z.string().max(500).optional(),
});

export interface OrchestratorStep {
  round: number;
  tool: string;
  ok: boolean;
  detail: string;
}

export interface OrchestratorResult {
  goal: string;
  stopped: boolean;
  reason: string;
  steps: OrchestratorStep[];
  proposals: ProjectRelation[];
  coverage: ReturnType<typeof buildPersonalOverview>['coverage'];
}

const MAX_ROUNDS = 3;
const SYSTEM_PROMPT = [
  '你是 IXAEON 有界统筹器。只能输出一个 JSON 动作，不得输出命令、脚本或 URL。',
  '允许的 tool：retrieve_items、get_evidence、propose_relation、stop。',
  '规则：',
  '1. 项目 ID、条目 ID 必须来自工具结果，禁止编造。',
  '2. 没有足够证据时调用 stop，不要强行 propose_relation。',
  '3. 接受关系不等于接口已联通；不要建议改仓库或移动资料。',
  '4. 禁止任何联网、Shell、文件写入。',
].join('\n');

/**
 * S3 最小统筹运行器：单任务、白名单工具、校验 ID，不执行模型文本里的命令。
 */
export class Orchestrator {
  private readonly items: ItemService;
  private readonly relations: RelationService;

  constructor(
    private readonly db: CoreDatabase,
    private readonly provider: ModelProvider | null,
  ) {
    this.items = new ItemService(db);
    this.relations = new RelationService(db);
  }

  async run(goal: string): Promise<OrchestratorResult> {
    const trimmed = goal.trim();
    if (trimmed.length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '统筹目标不能为空');
    }
    const coverage = buildPersonalOverview(this.db).coverage;
    if (!this.provider) {
      return {
        goal: trimmed,
        stopped: true,
        reason: '模型未配置：只展示现有资料和缺口，不生成假理解。',
        steps: [],
        proposals: this.relations.list({ status: 'proposed' }),
        coverage,
      };
    }

    const steps: OrchestratorStep[] = [];
    const proposals: ProjectRelation[] = [];
    let transcript = `目标：${trimmed}\n覆盖：项目 ${coverage.projectCount}，未分析来源 ${coverage.unanalyzedSources}，未整理 ${coverage.unassignedItems}`;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      let raw: z.infer<typeof actionSchema>;
      try {
        raw = await this.provider.chatStructured({
          system: SYSTEM_PROMPT,
          user: transcript,
          schema: actionSchema,
        });
      } catch (err) {
        steps.push({
          round,
          tool: 'invalid',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
        return {
          goal: trimmed,
          stopped: true,
          reason: '模型响应无效，已失败退出，未降级为任意脚本。',
          steps,
          proposals,
          coverage,
        };
      }

      if (!TOOL_NAMES.includes(raw.tool)) {
        steps.push({ round, tool: raw.tool, ok: false, detail: '未知工具' });
        return {
          goal: trimmed,
          stopped: true,
          reason: `拒绝未授权工具：${raw.tool}`,
          steps,
          proposals,
          coverage,
        };
      }

      const executed = this.execute(raw.tool, raw.args);
      steps.push({ round, tool: raw.tool, ok: executed.ok, detail: executed.detail });
      transcript += `\n[工具 ${raw.tool} ${executed.ok ? '成功' : '失败'}]\n${executed.detail}`;
      if (executed.proposal) proposals.push(executed.proposal);
      if (raw.tool === 'stop' || !executed.ok) {
        return {
          goal: trimmed,
          stopped: true,
          reason: executed.detail,
          steps,
          proposals,
          coverage,
        };
      }
    }

    return {
      goal: trimmed,
      stopped: true,
      reason: `已达 ${MAX_ROUNDS} 轮上限，停止。`,
      steps,
      proposals,
      coverage,
    };
  }

  private execute(
    tool: OrchestratorToolName,
    args: Record<string, unknown>,
  ): { ok: boolean; detail: string; proposal?: ProjectRelation } {
    switch (tool) {
      case 'retrieve_items': {
        const parsed = retrieveArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { ok: false, detail: `retrieve_items 参数无效：${parsed.error.message}` };
        }
        const all = this.items.list({
          projectId: null,
          state: 'current',
          type: parsed.data.type,
          limit: 80,
        });
        const q = parsed.data.query.toLowerCase();
        const hits = all
          .filter((i) => i.statement.toLowerCase().includes(q) || i.type === parsed.data.type)
          .slice(0, 12)
          .map((i) => ({
            id: i.id,
            type: i.type,
            project_id: i.project_id,
            statement: i.statement,
          }));
        return { ok: true, detail: JSON.stringify(hits) };
      }
      case 'get_evidence': {
        const parsed = evidenceArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { ok: false, detail: `get_evidence 参数无效：${parsed.error.message}` };
        }
        try {
          const item = this.items.get(parsed.data.itemId);
          const evidence = this.items.getEvidence(parsed.data.itemId);
          return {
            ok: true,
            detail: JSON.stringify({
              itemId: item.id,
              statement: item.statement,
              evidence: evidence.map((e) => ({
                segmentId: e.segment_id,
                excerpt: e.excerpt,
                sourceTitle: e.sourceTitle,
              })),
            }),
          };
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'propose_relation': {
        const parsed = proposeArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { ok: false, detail: `propose_relation 参数无效：${parsed.error.message}` };
        }
        if (parsed.data.toEntityKind === 'project') {
          const idCheck = uuidLike.safeParse(parsed.data.toEntityId);
          if (!idCheck.success) {
            return { ok: false, detail: '目标项目 ID 无效' };
          }
        }
        const input: ProposeRelationInput = {
          kind: parsed.data.kind,
          fromProjectId: parsed.data.fromProjectId,
          toEntityKind: parsed.data.toEntityKind,
          toEntityId: parsed.data.toEntityId,
          rationale: parsed.data.rationale,
          evidence: parsed.data.evidenceItemIds.map((id) => ({ itemId: id })),
          benefit: parsed.data.benefit ?? null,
          cost: parsed.data.cost ?? null,
          independentAlternative: parsed.data.independentAlternative ?? null,
          proposer: 'system',
        };
        try {
          const rel = this.relations.propose(input);
          if (!rel) return { ok: true, detail: '同样证据已被拒绝，不再催促。' };
          return { ok: true, detail: `已保存提案 ${rel.id}（accepted ≠ 已联通）`, proposal: rel };
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'stop':
        return {
          ok: true,
          detail: typeof args['reason'] === 'string' ? args['reason'] : '正常停止',
        };
      default:
        return { ok: false, detail: `拒绝未授权工具：${String(tool)}` };
    }
  }
}
