import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * 顶层错误边界。
 *
 * 没有它时，任何一次渲染异常都会让 React 卸载整棵组件树，窗口只剩深色背景——
 * 2026-09-17 用户实际遇到「全屏黑了」，界面上和日志里都没有任何线索。
 * 这里把出错原因直接显示在屏幕上（只在本机，由用户决定是否转给开发者），
 * 并给出重新加载的出口。React 会同时把错误打到控制台，主进程据此写入去内容的日志。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const where = (componentStack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join('\n');
    return (
      <div className="app-crash" role="alert" data-testid="app-crash">
        <h2>界面出错了</h2>
        <p>
          已经保存的对话和资料不受影响，重新加载即可继续（输入框里还没发出的文字会丢）。
          如果反复出现，请把下面这段文字发给开发者。
        </p>
        <pre data-testid="app-crash-detail">
          {`${error.name}: ${error.message}`}
          {where ? `\n\n${where}` : ''}
        </pre>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="app-crash-reload"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }
}
