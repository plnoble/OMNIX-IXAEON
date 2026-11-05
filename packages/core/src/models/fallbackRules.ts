/**
 * MP3：模型替补的判定与原因（MP3d 起从桌面挪到 core，行为不变）。
 */
import { ModelError } from '../extraction/model/provider.js';

export function acceptableFallback(err: unknown): boolean {
  if (!(err instanceof ModelError)) return false;
  const status = err.status;
  if (status === undefined) return err.retriable === true;
  return status === 401 || status === 403 || status === 402 || status === 429 || status >= 500;
}

export function reasonText(err: unknown): string {
  const status = err instanceof ModelError ? err.status : undefined;
  if (status === undefined) return '连不上或超时';
  if (status === 401 || status === 403) return 'Key 不对或没权限';
  if (status === 402 || status === 429) return '额度用完';
  if (status >= 500) return '服务出错';
  return '连不上或超时';
}
