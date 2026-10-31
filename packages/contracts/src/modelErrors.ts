/**
 * CF0：认出「网关里这个模型现在没有可用渠道 / 模型不存在」这一类失败。
 *
 * 这一类重试没用，要说清是哪个模型、该怎么办；聊天页也靠它决定要不要给
 * 「换个已保存的模型重问」。判定只认网关原文，不猜别的 5xx：
 * - `No available channel for model <名字>`（new-api / one-api 的说法，不分大小写）
 * - `model_not_found`
 * - `The model \`<名字>\` does not exist`
 * - `model <名字> not found`
 *
 * 放在 contracts 里是为了主进程的核心说明和界面共用同一份判定：界面进程不能引
 * `@ixaeon/core`（那会把 better-sqlite3 等主进程依赖打进渲染包）。
 */

export interface ModelUnavailableDetail {
  /** 取到的模型名；原文没给名字时为 null（说明里写「这个模型」）。 */
  model: string | null;
}

/** 模型名到空白、逗号、分号、括号、引号为止。 */
const NAME = '([^\\s,;()"\'`]+)';

const CHANNEL = new RegExp(`no available channel for model\\s+${NAME}`, 'i');
const DOES_NOT_EXIST = new RegExp(`the model\\s+\`?${NAME}\`?\\s+does not exist`, 'i');
const NOT_FOUND = new RegExp(`\\bmodel\\s+\`?${NAME}\`?\\s+not found`, 'i');

/** 是上面那几种就返回 `{ model }`（取不到名字为 null），否则 null。 */
export function isModelUnavailable(detail: string): ModelUnavailableDetail | null {
  const raw = detail.replace(/\s+/g, ' ').trim();
  if (raw.length === 0) return null;
  const channel = CHANNEL.exec(raw);
  if (channel) return { model: channel[1] ?? null };
  if (/model_not_found/i.test(raw)) return { model: null };
  const missing = DOES_NOT_EXIST.exec(raw);
  if (missing) return { model: missing[1] ?? null };
  const notFound = NOT_FOUND.exec(raw);
  if (notFound) return { model: notFound[1] ?? null };
  return null;
}
