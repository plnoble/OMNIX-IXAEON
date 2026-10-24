/**
 * L19 契约第 2 条：Claude 的周额度在北京时间每周四 04:00 刷新（用户 2026-10-20 说的）。
 *
 * 北京时间是 UTC+8，不考虑夏令时；北京时间周四 04:00 就是 UTC 周三 20:00。
 * 只做时间算术：输入 `now`，回严格晚于它的最近一个刷新点。
 */
const DAY = 86_400_000;
/** UTC 周三 20:00 是一天里的第 20 个小时。 */
const RESET_HOUR = 20;

export function nextWeeklyReset(now: Date): Date {
  const t = now.getTime();
  // `day` 是 UTC 的日历日序号；1970-01-01（第 0 天）是周四，所以星期几 = (day + 4) % 7（0 是周日）。
  const day = Math.floor(t / DAY);
  const weekday = (((day + 4) % 7) + 7) % 7;
  const toWednesday = (3 - weekday + 7) % 7;
  let until = (day + toWednesday) * DAY + RESET_HOUR * 3_600_000;
  // 严格晚于 now：正好卡在 04:00:00.000 也算「已经刷新过」，要等下一周。
  if (until <= t) until += 7 * DAY;
  return new Date(until);
}
