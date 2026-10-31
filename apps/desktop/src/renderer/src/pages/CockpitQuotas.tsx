/**
 * K4：驾驶舱的额度区。数据来自 K2 快照的 `quotas`（可选：K3 的模拟快照没有）。
 * 每个账号一张卡；手动登记同一账号的多条窗口合成一张。倒计时按 `resetAt` 现算。
 */
import type { QuotaCard, SourceHealth } from '@ixaeon/contracts';
import { Card, Empty } from '../ui.js';

const STATUS_ZH: Record<string, string> = {
  ok: '正常',
  cookie_expired: '需要重新登录',
  error: '出错',
  unknown: '状态不明',
  manual: '手动',
};

function ago(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return '—';
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 1_440) return `${Math.floor(mins / 60)} 小时前`;
  return `${Math.floor(mins / 1_440)} 天前`;
}

/** 还有多久重置；已经过了给 null（手动那类改提示「可能已重置」）。 */
function until(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t) || t <= now) return null;
  const mins = Math.ceil((t - now) / 60_000);
  if (mins < 60) return `还有 ${mins} 分钟重置`;
  if (mins < 1_440) return `还有 ${Math.ceil(mins / 60)} 小时重置`;
  return `还有 ${Math.ceil(mins / 1_440)} 天重置`;
}

/** 手动登记一项一个窗口，同一账号登记了多个窗口时页面合成一张卡。 */
function mergeCards(cards: QuotaCard[]): QuotaCard[] {
  const byKey = new Map<string, QuotaCard>();
  for (const c of cards) {
    const key = `${c.source}:${c.account}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...c, windows: [...c.windows] });
      continue;
    }
    prev.windows.push(...c.windows);
    prev.plan ??= c.plan;
    prev.expiresAt ??= c.expiresAt;
    if (Date.parse(c.collectedAt) < Date.parse(prev.collectedAt)) prev.collectedAt = c.collectedAt;
  }
  return [...byKey.values()];
}

export function QuotaSection({ cards, health }: { cards: QuotaCard[]; health?: SourceHealth }) {
  const now = Date.now();
  const list = mergeCards(cards);
  return (
    <Card title="额度" testId="cockpit-quotas">
      {health && health.status !== 'ok' && (
        <p
          className={health.status === 'error' ? 'warn' : 'muted'}
          data-testid="cockpit-quota-note"
        >
          {health.note ?? (health.status === 'missing' ? '未连接 QuotaHub' : '额度来源不正常')}
        </p>
      )}
      {list.length === 0 ? (
        <Empty testId="cockpit-quotas-empty">还没有额度数据。</Empty>
      ) : (
        <ul className="work-run-list">
          {list.map((q) => {
            const stale = q.source === 'quotahub' && now - Date.parse(q.collectedAt) > 15 * 60_000;
            const resetPassed =
              q.source === 'manual' &&
              q.windows.some((w) => w.resetAt !== null && Date.parse(w.resetAt) <= now);
            return (
              <li
                key={`${q.source}-${q.account}`}
                className="work-run"
                data-testid="cockpit-quota-card"
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
              >
                <strong>{q.account}</strong>
                <span className="badge">{STATUS_ZH[q.status] ?? q.status}</span>
                {q.source !== 'manual' && <span className="muted">{q.provider}</span>}
                {q.plan && <span className="muted">{q.plan}</span>}
                {q.expiresAt && <span className="muted">订阅到期 {q.expiresAt.slice(0, 10)}</span>}
                {q.source === 'manual' && (
                  <span className="muted" data-testid="cockpit-quota-manual">
                    手动 · 登记于 {ago(q.collectedAt, now)}
                  </span>
                )}
                {stale && <span className="warn">数据旧了</span>}
                {resetPassed && <span className="warn">可能已重置，请更新</span>}
                <ul style={{ width: '100%', margin: '4px 0 0', paddingLeft: 18 }}>
                  {q.windows.map((w, i) => (
                    <li key={`${w.name}-${i}`} data-testid="cockpit-quota-window">
                      <span>{w.name}</span>{' '}
                      <span className="muted">
                        {w.usedPercent === null ? '用量未知' : `已用 ${w.usedPercent}%`}
                      </span>{' '}
                      {w.usedPercent !== null && (
                        <span
                          className="update-progress-track"
                          style={{ display: 'inline-block', width: 90, verticalAlign: 'middle' }}
                        >
                          <span
                            className="update-progress-bar"
                            style={{
                              display: 'block',
                              width: `${Math.min(100, Math.max(0, w.usedPercent))}%`,
                            }}
                          />
                        </span>
                      )}{' '}
                      {w.resetAt && (
                        <span className="muted">{until(w.resetAt, now) ?? '已到重置时间'}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
