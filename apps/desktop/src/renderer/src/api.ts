import type {
  AppState,
  AuditEvent,
  Correction,
  IxaIpcApi,
  Item,
  ItemEvidence,
  Job,
  Permission,
  Project,
  SearchInput,
  Segment,
  SegmentHit,
  SettingsView,
  Source,
  SourceListItem,
} from '@ixaeon/contracts';

/** window.ixaeon 的类型安全访问（preload 保证存在；测试环境可能缺省）。 */
export const api: IxaIpcApi = (window.ixaeon ?? ({} as IxaIpcApi)) as IxaIpcApi;

/** 把 IPC 错误（"IXA0001 消息" 字符串）转为用户可读消息。 */
export function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^(IXA\d{4})\s+(.*)$/.exec(raw);
  return m ? `${m[1]}：${m[2]}` : raw;
}

export type {
  AppState,
  AuditEvent,
  Correction,
  Item,
  ItemEvidence,
  Job,
  Permission,
  Project,
  SearchInput,
  Segment,
  SegmentHit,
  SettingsView,
  Source,
  SourceListItem,
};
