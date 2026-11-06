import { useCallback, useEffect, useState } from 'react';
import type { RelayModelRole, RelayModels, RelayModelRow, RunningItem } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Card, ErrorBanner } from '../ui.js';

/** K10a（第二支）：驾驶舱「调度器与模型」。只显示 provider / model 名字与角色；
 * 改的是调度器配置 / 接力补丁，下一棒生效。MG2：整合方 / 审查 / 开发也能选 magpie 的模型和分组。 */
const LABEL: Record<RelayModelRole, string> = {
  developer: '开发（DSH）',
  integrator: '整合方（Claude）',
  reviewer: '审查（Codex）',
  reviewerSubstitute: '替补审查',
  integratorSubstitute: '替补整合方',
};
const DEFAULT_REVIEWER = '跟 Codex 自己的设置';
const RUN_LABEL: Record<string, string> = {
  developer: '开发',
  integrator: '整合方',
  reviewer: '审查',
  'integrator-substitute': '替补整合方',
};

/** 审查那行选「默认」时，值写 `默认`（服务端会同时清掉 codexModel 和 magpieModel）。 */
const reviewerValue = (current: string | null): string =>
  !current || current === DEFAULT_REVIEWER ? '默认' : current;

/** 「网关 / 模型」按网关分组；没有分隔符的整条当一组。 */
function groups(options: string[]): Array<[string, string[]]> {
  const map = new Map<string, string[]>();
  for (const o of options) {
    const at = o.indexOf(' / ');
    const key = at < 0 ? '' : o.slice(0, at);
    map.set(key, [...(map.get(key) ?? []), o]);
  }
  return [...map];
}

function runningLine(running: RunningItem[], models: RelayModels): string {
  const turn = running.find((r) => r.kind === 'turn');
  if (!turn) return '现在没有在跑的一棒。';
  const role = turn.role ? (RUN_LABEL[turn.role] ?? turn.role) : '—';
  const key =
    turn.role === 'developer'
      ? 'developer'
      : turn.role === 'integrator'
        ? 'integrator'
        : turn.role === 'integrator-substitute'
          ? 'integratorSubstitute'
          : null;
  const model = key ? models.roles.find((r) => r.role === key)?.current : null;
  const start = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
  const mins = Number.isNaN(start) ? null : Math.max(0, Math.floor((Date.now() - start) / 60_000));
  const n = /第\s*(\d+)\s*棒/.exec(turn.text)?.[1] ?? '—';
  return `现在在跑：第 ${n} 棒 · ${role} · 任务 ${turn.taskId ?? '—'} · ${mins === null ? '已跑 — 分钟' : `已跑 ${mins} 分钟`} · ${model ?? '模型 —'}`;
}

export function RelayModelsSection({ running }: { running: RunningItem[] }) {
  const [models, setModels] = useState<RelayModels | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // 旧的页面测试里没有这个通道；拿不到就不显示这张卡，其余照常。
    if (typeof api.getRelayModels !== 'function') return;
    try {
      const next = await api.getRelayModels();
      setModels(next);
      const reviewer = next.roles.find((r) => r.role === 'reviewer');
      setDraft(
        reviewer?.current &&
          reviewer.current !== DEFAULT_REVIEWER &&
          !reviewer.current.includes('/')
          ? reviewer.current
          : '',
      );
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!models) {
    return error ? (
      <Card title="调度器与模型" testId="cockpit-relay-models">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      </Card>
    ) : null;
  }

  const save = async (role: RelayModelRole, value: string | null) => {
    try {
      await api.setRelayModel({ role, value });
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const rowOf = (role: RelayModelRole): RelayModelRow | undefined =>
    models.roles.find((r) => r.role === role);
  const picker = (role: RelayModelRole, current: string | null, options: string[]) => (
    <select
      value={current ?? ''}
      onChange={(e) => void save(role, e.target.value)}
      data-testid={`relay-model-select-${role}`}
    >
      {groups(options).map(([gateway, list]) =>
        gateway ? (
          <optgroup key={gateway} label={gateway}>
            {list.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </optgroup>
        ) : (
          list.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))
        ),
      )}
    </select>
  );
  /** MG2：连不上 magpie 时在行旁边写一句（不挡原来的选项）。 */
  const note = (role: RelayModelRole) => {
    const text = rowOf(role)?.note;
    return text ? (
      <span className="muted" data-testid={`relay-model-note-${role}`}>
        {text}
      </span>
    ) : null;
  };
  const dsh = (role: RelayModelRole) => {
    const r = rowOf(role);
    return !r?.configured ? (
      <span className="muted" data-testid={`relay-model-current-${role}`}>
        {r?.note ?? '没配'}
      </span>
    ) : (
      <>
        <span data-testid={`relay-model-current-${role}`}>{r.current ?? '—'}</span>{' '}
        {picker(role, r.current, r.options)} {note(role)}
      </>
    );
  };
  const integrator = rowOf('integrator');
  const reviewer = rowOf('reviewer');

  return (
    <Card title="调度器与模型" testId="cockpit-relay-models">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <p className="muted" data-testid="relay-model-running" style={{ marginTop: 0 }}>
        {runningLine(running, models)}
      </p>
      <ul className="work-run-list" data-testid="relay-model-list">
        <li className="work-run" data-testid="relay-model-row-developer">
          <span className="badge">{LABEL.developer}</span> {dsh('developer')}{' '}
          <span className="muted">下一棒生效</span>
        </li>
        <li className="work-run" data-testid="relay-model-row-integrator">
          <span className="badge">{LABEL.integrator}</span>{' '}
          {integrator?.configured ? (
            <>
              <span data-testid="relay-model-current-integrator">
                {integrator.current ?? '默认'}
              </span>{' '}
              {picker('integrator', integrator.current, integrator.options)} {note('integrator')}
            </>
          ) : (
            <span className="muted" data-testid="relay-model-current-integrator">
              {integrator?.note ?? '没配'}
            </span>
          )}{' '}
          <span className="muted">下一棒生效</span>
        </li>
        <li className="work-run" data-testid="relay-model-row-reviewer">
          <span className="badge">{LABEL.reviewer}</span>{' '}
          <span data-testid="relay-model-current-reviewer">{reviewer?.current ?? '—'}</span>{' '}
          {reviewer && reviewer.options.length > 0
            ? picker('reviewer', reviewerValue(reviewer.current), reviewer.options)
            : null}{' '}
          {note('reviewer')}
          <input
            type="text"
            value={draft}
            placeholder="跟 Codex 自己的设置"
            aria-label="审查（Codex）用的模型"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save('reviewer', draft.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save('reviewer', draft.trim());
            }}
            data-testid="relay-model-reviewer-input"
          />{' '}
          <span className="muted">回车保存 · 下一棒生效</span>
        </li>
      </ul>
    </Card>
  );
}
