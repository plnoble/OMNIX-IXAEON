/**
 * CF0：认出「网关里这个模型现在没有可用渠道 / 模型不存在」这一类失败。
 *
 * 这一类重试没用，要说清是哪个模型、该怎么办；聊天页也靠它决定要不要给
 * 「换个已保存的模型重问」。判定只认网关原文，不猜别的 5xx：
 * `No available channel for model <名字>`（new-api / one-api 的说法）、
 * `The model \`<名字>\` does not exist`、`model <名字> not found`、`model_not_found`。
 * 三条带名字的规则先跑，最后才认 `model_not_found`：网关常见两种说法同时出现
 * （`{"message":"The model \`x\` does not exist","code":"model_not_found"}`），
 * 名字明明取得到时不能因为 code 退成 null。
 *
 * 放在 contracts 里是为了主进程和界面共用同一份判定：界面进程不能引 `@ixaeon/core`
 * （那会把 better-sqlite3 等主进程依赖打进渲染包）。
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
/** 认本任务自己的说明句：失败说明的「原始错误」被截短时，靠它仍能认出模型。 */
const EXPLAINED = /网关里「([^」]+)」现在没有可用渠道/;
/** 句子里的虚词不是模型名（`The requested model was not found`）。 */
const NOT_A_NAME =
  /^(?:was|is|are|be|been|being|not|cannot|could|would|should|may|might|must|has|have|had|does|did|will|can)$/i;

/** 取到的名字是虚词 / 空 → 当没取到（返回 null，说明写「这个模型」）。 */
function nameOrNull(match: RegExpExecArray | null): string | null {
  const name = match?.[1];
  if (name === undefined || name.length === 0) return null;
  return NOT_A_NAME.test(name) ? null : name;
}

/** 是上面那几种就返回 `{ model }`（取不到名字为 null），否则 null。 */
export function isModelUnavailable(detail: string): ModelUnavailableDetail | null {
  const raw = detail.replace(/\s+/g, ' ').trim();
  if (raw.length === 0) return null;
  const channel = CHANNEL.exec(raw);
  if (channel) return { model: nameOrNull(channel) };
  const missing = DOES_NOT_EXIST.exec(raw);
  if (missing) return { model: nameOrNull(missing) };
  const notFound = NOT_FOUND.exec(raw);
  if (notFound) return { model: nameOrNull(notFound) };
  const explained = EXPLAINED.exec(raw);
  if (explained) return { model: explained[1] === '这个模型' ? null : (explained[1] ?? null) };
  if (/model_not_found/i.test(raw)) return { model: null };
  return null;
}
