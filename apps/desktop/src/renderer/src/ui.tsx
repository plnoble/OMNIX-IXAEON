import type { ReactNode } from 'react';

export function Card({
  title,
  testId,
  children,
  actions,
}: {
  title?: ReactNode;
  testId?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card" data-testid={testId}>
      {title !== undefined && (
        <header className="card-header">
          <h2>{title}</h2>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  testId,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  testId?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn-${kind}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={title}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="empty" data-testid={testId}>
      {children}
    </p>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="error-banner" data-testid="error-banner" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          关闭
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <p className="empty" data-testid="loading">
      {label}
    </p>
  );
}

/** 来源类型与提供者的中文短标签。 */
export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case 'conversation':
      return '对话';
    case 'document':
      return '文档';
    case 'project_snapshot':
      return '项目登记';
    case 'work_result':
      return '工作结果';
    default:
      return kind;
  }
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'chatgpt_export':
      return 'ChatGPT 导出';
    case 'chatgpt_web':
      return 'ChatGPT 网页';
    case 'local_file':
      return '本地文件';
    case 'project':
      return '项目目录';
    case 'coding_agent':
      return '编码 AI';
    default:
      return provider;
  }
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return '用户';
    case 'assistant':
      return 'AI';
    case 'system':
      return '系统';
    case 'document':
      return '文档';
    default:
      return role;
  }
}

export function projectStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return '进行中';
    case 'paused':
      return '暂停';
    case 'archived':
      return '归档';
    default:
      return status;
  }
}
