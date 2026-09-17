import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { recordAudit } from '../audit.js';

export type ModelTier = 'cloud' | 'local';
export type ModelPrivacyScope = 'public' | 'local_only';
export type SupportedTask = 'extraction' | 'research' | 'coding' | 'chat';

export interface ModelDescriptor {
  id: string;
  name: string;
  provider: 'openai' | 'deepseek' | 'ollama' | 'door_node' | 'fake';
  tier: ModelTier;
  privacyScope: ModelPrivacyScope;
  supportedTasks: SupportedTask[];
  contextWindow: number;
  costPer1k: number;
  latencyMs: number;
  healthy: boolean;
}

export interface ModelSelectionResult {
  selected: ModelDescriptor;
  rationale: string;
  candidatesConsidered: number;
  rejectedReasons: Record<string, string>;
}

export interface ModelPoolConfig {
  /** 已配置的云端模型名（来自应用配置；未配置则为 null） */
  cloudModelName: string | null;
  /** 本机模型入口（如 Ollama 可用性声明；未配置则为 null） */
  localModelName: string | null;
}

/**
 * P5: 模型池与资源调度服务
 * 规范：
 * 1. 隐私限制是硬条件：不可外发隐私数据时，云模型一票否决，绝不因成本/速度妥协；
 * 2. 匹配任务类型（提取 vs 复杂研究 vs 编码）；
 * 3. 产生可解释决策（选了谁、为何选、候选为何不选）；
 * 4. 故障回退必须在当前授权隐私约束内。
 * 真实接线（修复自查审核 69.2-1）：fromConfig 从应用配置构建池；
 * selectModel 每次决策写审计表（model.selected），可追溯。
 */
export class ModelPool {
  private models = new Map<string, ModelDescriptor>();

  constructor(private readonly db: CoreDatabase | null = null) {}

  /** 从应用配置构建池（真实接线入口）。 */
  static fromConfig(db: CoreDatabase | null, cfg: ModelPoolConfig): ModelPool {
    const pool = new ModelPool(db);
    if (cfg.cloudModelName) {
      pool.register({
        id: `cloud:${cfg.cloudModelName}`,
        name: `${cfg.cloudModelName}（云端）`,
        provider: cfg.cloudModelName.includes('deepseek') ? 'deepseek' : 'openai',
        tier: 'cloud',
        privacyScope: 'public',
        supportedTasks: ['extraction', 'research', 'coding', 'chat'],
        contextWindow: 64_000,
        costPer1k: 0.002,
        latencyMs: 800,
        healthy: true,
      });
    }
    if (cfg.localModelName) {
      pool.register({
        id: `local:${cfg.localModelName}`,
        name: `${cfg.localModelName}（本机）`,
        provider: 'ollama',
        tier: 'local',
        privacyScope: 'local_only',
        supportedTasks: ['extraction', 'chat'],
        contextWindow: 16_000,
        costPer1k: 0,
        latencyMs: 300,
        healthy: true,
      });
    }
    return pool;
  }

  register(model: ModelDescriptor): void {
    this.models.set(model.id, model);
  }

  get(id: string): ModelDescriptor {
    const m = this.models.get(id);
    if (!m) throw new IxaError(ErrorCodes.NOT_FOUND, `模型不存在: ${id}`);
    return m;
  }

  setHealth(id: string, healthy: boolean): void {
    const m = this.get(id);
    m.healthy = healthy;
  }

  list(): ModelDescriptor[] {
    return Array.from(this.models.values());
  }

  /**
   * 隐私、质量、成本多维统一决策
   */
  selectModel(request: {
    task: SupportedTask;
    allowCloud: boolean;
    preferredQuality?: 'fast' | 'high';
  }): ModelSelectionResult {
    const all = Array.from(this.models.values());
    const rejectedReasons: Record<string, string> = {};
    const candidates: ModelDescriptor[] = [];

    for (const m of all) {
      if (!m.healthy) {
        rejectedReasons[m.id] = '节点当前处于非健康/离线状态';
        continue;
      }
      // 1. 隐私硬约束拦截
      if (!request.allowCloud && m.tier === 'cloud') {
        rejectedReasons[m.id] = '隐私硬限制：本次资料未获准外发云端，一票否决云模型';
        continue;
      }
      // 2. 任务能力匹配
      if (!m.supportedTasks.includes(request.task)) {
        rejectedReasons[m.id] = `模型未声明支持此类任务: ${request.task}`;
        continue;
      }
      candidates.push(m);
    }

    if (candidates.length === 0) {
      throw new IxaError(
        ErrorCodes.NOT_FOUND,
        `无可用的合规模型。原因汇总: ${JSON.stringify(rejectedReasons)}`,
      );
    }

    // 3. 质量与成本评分
    candidates.sort((a, b) => {
      if (request.preferredQuality === 'fast') {
        return a.latencyMs - b.latencyMs;
      }
      // 默认优先选择上下文能力和综合能力更强的模型
      return b.contextWindow - a.contextWindow;
    });

    const chosen = candidates[0]!;
    const rationale = `已综合比较 ${all.length} 个候选资源：排除 ${Object.keys(rejectedReasons).length} 个不合规/不适用项；在 ${candidates.length} 个合规资源中，选中 ${chosen.name}（模式: ${chosen.tier}, 任务能力: ${request.task}, 延迟: ${chosen.latencyMs}ms）。`;

    // 审计落库（可追溯：选了谁、为何选、候选为何不选）
    if (this.db) {
      recordAudit(this.db, 'model.selected', {
        task: request.task,
        allowCloud: request.allowCloud,
        selected: chosen.id,
        rationale,
        rejectedReasons,
      });
    }

    return {
      selected: chosen,
      rationale,
      candidatesConsidered: all.length,
      rejectedReasons,
    };
  }

  /**
   * 授权内受控回退（Fallback）
   */
  fallback(
    failedModelId: string,
    request: { task: SupportedTask; allowCloud: boolean },
  ): ModelDescriptor {
    const _original = this.get(failedModelId);
    this.setHealth(failedModelId, false); // 标记故障
    const result = this.selectModel(request);

    // 验证：回退模型绝不能突破原请求的隐私限制
    if (!request.allowCloud && result.selected.tier === 'cloud') {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '回退选择违背隐私硬限制');
    }

    return result.selected;
  }
}
