/**
 * 模型调用失败时给用户看的说明：发生了什么、该怎么办。原始错误照样进账本，
 * 这里只负责把「API 错误 429: {...}」这类原文翻成人话（原文的关键部分附在括号里）。
 */
export function explainModelFailure(detail: string): string {
  const raw = detail.replace(/\s+/g, ' ').trim();
  const code = /\b(4\d\d|5\d\d)\b/.exec(raw)?.[1];
  const tail = `（原始错误：${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}）`;
  if (code === '429' || /concurrency|rate.?limit|too many requests/i.test(raw)) {
    return (
      '模型网关同时处理的请求数到上限了——常见原因是后台分析正占着同一个账号。' +
      '现在提问时后台分析会先让路，稍等几秒再问一次即可。' +
      tail
    );
  }
  if (/超时|timeout|无响应|timed out/i.test(raw)) {
    return (
      '模型太久没有回应。推理型模型（先「思考」再回答）会慢很多，可以在' +
      '「设置 → 模型接入 → 聊天模型」换一个快一点的。' +
      tail
    );
  }
  if (code === '401' || code === '403' || /unauthori[sz]ed|invalid.*(key|token)/i.test(raw)) {
    return '模型网关拒绝了请求：Key 无效，或这个 Key 没有该模型的权限。' + tail;
  }
  if (code && code.startsWith('5')) {
    return '模型网关或它的上游暂时出错，稍后再试。' + tail;
  }
  return raw.slice(0, 300);
}
