/** K10a：调度器里每个角色用的模型（只含 provider / model 名字，不含密钥、网关地址）。 */
export type RelayModelRole =
  'developer' | 'integrator' | 'reviewer' | 'reviewerSubstitute' | 'integratorSubstitute';

export type RelayModelAgent = 'dsh' | 'claude' | 'codex' | 'other';

export type RelayModelRow = {
  role: RelayModelRole;
  agent: RelayModelAgent;
  /** 当前值：DSH 是「网关 / 模型」，整合方是 --model 的值或「默认」，审查是 codexModel。 */
  current: string | null;
  /** 能选的值；DSH 是「网关 / 模型」对，整合方是 默认 / opus / sonnet / haiku。 */
  options: string[];
  configured: boolean;
  /** 读不懂、没配时的说明（不含配置原文）。 */
  note: string | null;
};

export type RelayModels = { roles: RelayModelRow[] };

export type SetRelayModelInput = { role: RelayModelRole; value: string | null };
