/**
 * MP2：按用途取模型（规格第 5 条「按用途取模型，规则只写在一处」）。
 *
 * 纯函数、**不解密**：只决定「用哪一家、哪个模型、哪个地址、哪份密文」，
 * Key 解不解得开由调用方（主进程）判断——解不开就当没配。
 *
 * 规则：
 * - `uses` 里有这一项 → 用那一家；那家没了/没 Key → null（不掉回 default 借别家的 Key）。
 * - 没有 → 照旧走 default 与旧字段：
 *   - `analysis` 用 `model.modelName`；
 *   - `chat` 用 `model.chatModelName`，空着就**跟着后台分析走**（含跟着换供应商）；
 *   - `coding` 用 `coding.modelName`，空着退回 `model.modelName`。
 * - `id = default` 的那一家，内容仍然取 `config.model`（不搬家、不迁移）。
 */
import type { AppConfig } from '@ixaeon/contracts';

export type ModelUse = 'analysis' | 'chat' | 'coding';

export interface ResolvedModelUse {
  providerId: string;
  providerName: string;
  apiBaseUrl: string;
  apiKeyEncrypted: string | null;
  model: string;
}

function defaultProviderName(config: AppConfig): string {
  return config.model.providerName?.trim() || '默认';
}

function fromDefault(config: AppConfig, model: string): ResolvedModelUse | null {
  const m = config.model;
  const name = model.trim();
  if (!name) return null;
  // 注意：default 这一家**不要求有 Key**——地址为空/没 Key 时 Hermes 照旧只传模型名
  //（SUB1 的行为），要不要 Key 由调用方（getProvider / 直连）自己判断。
  return {
    providerId: 'default',
    providerName: defaultProviderName(config),
    apiBaseUrl: m.apiBaseUrl ?? '',
    apiKeyEncrypted: m.apiKeyEncrypted,
    model: name,
  };
}

export function resolveModelUse(config: AppConfig, use: ModelUse): ResolvedModelUse | null {
  const choice = config.uses?.[use];
  if (choice) {
    const provider = (config.providers ?? []).find((p) => p.id === choice.providerId);
    // 那一家没了、没 Key、解不开：null——不会掉回 default 借别家的 Key
    if (!provider || !provider.apiKeyPresent || !provider.apiKeyEncrypted) return null;
    return {
      providerId: provider.id,
      providerName: provider.name,
      apiBaseUrl: provider.apiBaseUrl,
      apiKeyEncrypted: provider.apiKeyEncrypted,
      model: choice.model,
    };
  }
  if (use === 'analysis') return fromDefault(config, config.model.modelName ?? '');
  if (use === 'chat') {
    const explicit = config.model.chatModelName?.trim();
    // 聊天没单独选 → 跟着后台分析（包括跟着它用同一家供应商）
    if (!explicit) return resolveModelUse(config, 'analysis');
    return fromDefault(config, explicit);
  }
  const codingModel = config.coding?.modelName?.trim();
  return fromDefault(config, codingModel || (config.model.modelName ?? ''));
}
