/**
 * 记忆内容里提到的日期（三周任务单 E1：已结束的事自动退场）。
 *
 * 2026-09-18 真机反馈：7 月已经结束的一次出差筹备被当成「当前核心主线」答出来。条目的
 * 时间戳是**导入分析的日期**（全在 9-10～9-13），不是事情发生的日期——判断一件事
 * 过没过去，只能看内容里写的日期。
 *
 * 只认有月有日的绝对日期（宁可少认，不能认错：认错会让真实的当前目标被当成过去的事）：
 * - 「7月26日」「7月26号」「2026年7月20日」「2026-07-26」「2026/7/26」
 * - 区间「7月20日至26日」「7月20日到8月2日」：取结束那天
 * - 只写日的「26日」：沿用同一句里前面最近提到的月份（如「7月25日到达，26日上午参观」）；
 *   只写「26号」且前面不是区间连接词的不认（「3号楼」「36号」）
 * 不认：只写月份（「7月」「7月下旬」）、相对说法（「下周三」「明天」「月底」）。
 */

const DATE_TOKEN =
  /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?|([至到\-—~～]\s*)?(\d{1,2})\s*([日号])/g;

/** 本地日历日 YYYY-MM-DD；日期不存在（如 2 月 30 日）时返回 null。 */
function dayOf(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}`;
}

/** 没写年份时，取离「记下这条」最近的那一年（前后各看一年）。 */
function inferYear(month: number, day: number, recordedAt: Date): number {
  const base = recordedAt.getFullYear();
  let best = base;
  let bestGap = Infinity;
  for (const y of [base - 1, base, base + 1]) {
    const gap = Math.abs(new Date(y, month - 1, day).getTime() - recordedAt.getTime());
    if (gap < bestGap) {
      best = y;
      bestGap = gap;
    }
  }
  return best;
}

/** 内容里提到的日期（按出现顺序，去重）。recordedAt 用来推断没写的年份。 */
export function mentionedDays(text: string, recordedAt: string | Date): string[] {
  const rec = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);
  const anchor = Number.isNaN(rec.getTime()) ? new Date() : rec;
  const days: string[] = [];
  let month: number | null = null;
  let year: number | null = null;
  for (const m of text.matchAll(DATE_TOKEN)) {
    let found: string | null = null;
    if (m[1]) {
      year = Number(m[1]);
      month = Number(m[2]);
      found = dayOf(year, month, Number(m[3]));
    } else if (m[5]) {
      month = Number(m[5]);
      if (m[4]) year = Number(m[4]);
      const d = Number(m[6]);
      found = dayOf(year ?? inferYear(month, d, anchor), month, d);
    } else if (m[8] && month !== null) {
      const connector = Boolean(m[7]);
      // 「26号」只在区间里认（「至26号」）；单独的「3号」多半是门牌、尺码
      if (m[9] === '日' || connector) {
        const d = Number(m[8]);
        found = dayOf(year ?? inferYear(month, d, anchor), month, d);
      }
    }
    if (found && !days.includes(found)) days.push(found);
  }
  return days;
}

/**
 * 内容里提到的最晚那天若已经过去（早于 today 当天），返回那一天；否则 null。
 * 用「最晚那天」：「原定7月26日开业，推迟到10月8日」看的是 10 月 8 日。
 */
export function pastEventDay(
  text: string,
  recordedAt: string | Date,
  today: Date = new Date(),
): string | null {
  const days = mentionedDays(text, recordedAt);
  if (days.length === 0) return null;
  const latest = days.reduce((a, b) => (a > b ? a : b));
  const p = (n: number) => String(n).padStart(2, '0');
  const todayDay = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  return latest < todayDay ? latest : null;
}
