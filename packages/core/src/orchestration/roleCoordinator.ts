import { ErrorCodes, IxaError } from '@ixaeon/contracts';

export type AgentRole = 'researcher' | 'coder' | 'auditor';

export interface AutonomousBudget {
  maxActions: number;
  remainingActions: number;
  budgetCapUsd: number;
  spentUsd: number;
  scope: string;
}

export interface RoleActionRequest {
  role: AgentRole;
  action: 'search' | 'write_code' | 'evaluate' | 'approve_upgrade' | 'deploy';
  costUsd?: number;
  target?: string;
}

/**
 * P6: 角色分工协作、受限自治与审计追踪服务
 * 规范：
 * 1. 严格职责隔离：coder 不能自批升级，researcher 不能写代码/调 shell；
 * 2. 自治有硬预算与硬上限：动作耗尽或预算用完自动暂停；
 * 3. 升级、部署、新外发等重大动作必须由用户或独立审计者确认。
 */
export class RoleCoordinator {
  private budget: AutonomousBudget;
  private actionLog: Array<{
    role: AgentRole;
    action: string;
    timestamp: string;
    costUsd: number;
  }> = [];

  constructor(initialBudget?: Partial<AutonomousBudget>) {
    this.budget = {
      maxActions: initialBudget?.maxActions ?? 10,
      remainingActions: initialBudget?.maxActions ?? 10,
      budgetCapUsd: initialBudget?.budgetCapUsd ?? 1.0,
      spentUsd: 0,
      scope: initialBudget?.scope ?? 'project_workspace',
    };
  }

  getBudget(): AutonomousBudget {
    return { ...this.budget };
  }

  getActionLog() {
    return [...this.actionLog];
  }

  /**
   * 执行前鉴权与职责边界检查
   */
  checkPermission(req: RoleActionRequest): void {
    // 1. 角色职责矩阵检查
    if (req.role === 'researcher') {
      if (
        req.action === 'write_code' ||
        req.action === 'approve_upgrade' ||
        req.action === 'deploy'
      ) {
        throw new IxaError(
          ErrorCodes.PERMISSION_DENIED,
          `研究角色（researcher）无权执行动作: ${req.action}`,
        );
      }
    }

    if (req.role === 'coder') {
      if (req.action === 'approve_upgrade' || req.action === 'deploy') {
        throw new IxaError(
          ErrorCodes.PERMISSION_DENIED,
          '开发执行角色（coder）坚决不能自批自审自己的升级或直接生产部署',
        );
      }
    }

    if (req.role === 'auditor') {
      if (req.action === 'write_code') {
        throw new IxaError(
          ErrorCodes.PERMISSION_DENIED,
          '独立审计角色（auditor）只能评测核验，无权篡改业务代码',
        );
      }
    }

    // 2. 自治动作预算消耗检查
    if (this.budget.remainingActions <= 0) {
      throw new IxaError(
        ErrorCodes.BUDGET_EXCEEDED,
        `已达到自治动作上限（${this.budget.maxActions} 步），自动暂停以避免失控`,
      );
    }

    const cost = req.costUsd ?? 0;
    if (this.budget.spentUsd + cost > this.budget.budgetCapUsd) {
      throw new IxaError(
        ErrorCodes.BUDGET_EXCEEDED,
        `超出自治预算限额（上限 $${this.budget.budgetCapUsd}，当前已用 $${this.budget.spentUsd}，请求 $${cost}），自动停止`,
      );
    }
  }

  /**
   * 记录动作并扣减配额
   */
  recordAction(req: RoleActionRequest): void {
    this.checkPermission(req);

    const cost = req.costUsd ?? 0;
    this.budget.remainingActions -= 1;
    this.budget.spentUsd += cost;

    this.actionLog.push({
      role: req.role,
      action: req.action,
      timestamp: new Date().toISOString(),
      costUsd: cost,
    });
  }
}
