/**
 * 一次性/当场要求不得升成长期目标或约束。
 * 判定只看陈述本身，不依赖模型分数。
 */
const EPHEMERAL =
  /这次会议|这次演示|今天先|今晚|明天演示|一次性|先这样|暂时用|本周演示|这次只|仅本次|仅这一次/;

export function isEphemeralStatement(text: string): boolean {
  return EPHEMERAL.test(text);
}

export function demoteEphemeralType<T extends string>(type: T, statement: string): T | 'open_loop' {
  if (!isEphemeralStatement(statement)) return type;
  if (type === 'goal' || type === 'constraint' || type === 'preference') return 'open_loop';
  return type;
}

export function questionLooksEventSpecific(question: string): boolean {
  return /这次|今天|今晚|会议|演示|当场/.test(question);
}
