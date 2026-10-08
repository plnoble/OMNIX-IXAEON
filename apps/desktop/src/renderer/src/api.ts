import type {
  AppState,
  AskAnswer,
  AuditEvent,
  Correction,
  ExportResult,
  IxaIpcApi,
  Item,
  ItemEvidenceView,
  Job,
  Permission,
  Project,
  RestorePreview,
  SearchInput,
  Segment,
  SegmentHit,
  SettingsView,
  Source,
  SourceListItem,
  UpdateStatusView,
  WorkRun,
} from '@ixaeon/contracts';

/** window.ixaeon 的类型安全访问（preload 保证存在；测试环境可能缺省）。 */
export const api: IxaIpcApi = (window.ixaeon ?? ({} as IxaIpcApi)) as IxaIpcApi;

/**
 * 把 IPC 错误转成用户可读消息（U6）。Electron 把主进程拒绝转给界面时会在前面加
 * `Error invoking remote method '<接口>': Error: `；先去掉这两段（只认开头、各去一次），
 * 剩下的照旧规则：以错误码（IXA + 四位数字 + 空白）开头 → `<错误码>：<消息>`（消息里的换行照留），
 * 不是错误码 → 原样返回（别的错误类名如 TypeError 有用，不去）。
 */
export function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let text = raw.replace(/^Error invoking remote method '[^']*': /, '');
  text = text.replace(/^Error: /, '');
  const m = /^(IXA\d{4})\s+([\s\S]*)$/.exec(text);
  return m ? `${m[1]}：${m[2]}` : text;
}

export type {
  AppState,
  AskAnswer,
  AuditEvent,
  Correction,
  ExportResult,
  Item,
  ItemEvidenceView,
  Job,
  Permission,
  Project,
  RestorePreview,
  SearchInput,
  Segment,
  SegmentHit,
  SettingsView,
  Source,
  SourceListItem,
  UpdateStatusView,
  WorkRun,
};
