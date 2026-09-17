import type { BrowserWindow } from 'electron';

interface DiagnosticsLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 渲染层报错的技术特征：去掉可能承载用户资料的部分，只留能定位 bug 的形态。
 *
 * 日志对 error / message 等字段整体只留长度与哈希（防止对话正文进日志），
 * 这是对的，但也让界面报错在日志里完全无法排查（2026-09-17 用户遇到黑屏，
 * 日志里查不到任何线索）。这里不绕开那条规则，而是先把内容部分去掉：
 * - 中文与全角字符整段替换为「…」——本应用的用户资料绝大多数是中文；
 * - 超过 40 个字符的引号内文本替换为「…」——保留 'join' 这类短标识符；
 * 例：「Cannot read properties of undefined (reading 'join')」原样保留，
 * 「IXA0010 模型未配置：请在设置中填写…」只留「IXA0010 …」。
 */
export function errorSignature(message: string): string {
  return message
    .replace(/[　-〿㐀-鿿豈-﫿＀-￯]+/g, '…')
    .replace(/(["'`])[^"'`]{41,}\1/g, '$1…$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 从 "Uncaught TypeError: x" 这类控制台文本里取错误类型。 */
function errorName(message: string): string {
  const m = /^(?:Uncaught(?: \(in promise\))? )?([A-Z][A-Za-z]*Error)\b/.exec(message);
  return m?.[1] ?? 'unknown';
}

/** 同一窗口两次崩溃间隔小于该值时不再自动重载，避免反复崩溃→重载的死循环。 */
const RELOAD_GUARD_MS = 10_000;

/**
 * 监听渲染层崩溃与报错并写入日志。
 * 此前应用没有任何崩溃兜底：渲染进程挂掉或界面报错时，窗口只剩深色背景，
 * 日志里也没有记录。
 */
export function watchRendererHealth(
  win: BrowserWindow,
  getLogger: () => DiagnosticsLogger | null,
): void {
  let lastGoneAt = 0;

  win.webContents.on('render-process-gone', (_event, details) => {
    const now = Date.now();
    const willReload = now - lastGoneAt > RELOAD_GUARD_MS && details.reason !== 'clean-exit';
    lastGoneAt = now;
    // 注意字段名：reason 属于日志的正文键会被哈希，这里的值是 crashed / oom 等枚举，
    // 不含用户内容，所以换用 goneReason 保留原值。
    const fields = { goneReason: details.reason, exitCode: details.exitCode, willReload };
    const logger = getLogger();
    if (logger) logger.error('界面进程退出', fields);
    else process.stderr.write(`[ixaeon] 界面进程退出 ${JSON.stringify(fields)}\n`);
    if (willReload && !win.isDestroyed()) win.webContents.reload();
  });

  win.webContents.on('console-message', (details) => {
    if (details.level !== 'error') return;
    const fields = {
      errorName: errorName(details.message),
      signature: errorSignature(details.message),
      location: `${details.sourceId}:${details.lineNumber}`,
    };
    const logger = getLogger();
    if (logger) logger.warn('界面报错', fields);
    else process.stderr.write(`[ixaeon] 界面报错 ${JSON.stringify(fields)}\n`);
  });
}
