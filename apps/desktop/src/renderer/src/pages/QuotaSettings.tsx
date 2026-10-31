/**
 * K4：设置页的额度来源。QuotaHub 地址（空串 = 关闭）与手动登记（每项一个窗口）。
 * 只写 `cockpit.quotahub_url` / `cockpit.manual_quotas`；校验和快照里的 status 在核心层。
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import type { ManualQuota, SettingsView } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Button, Card } from '../ui.js';

const WINDOWS = ['5 小时', '每周', '其他'];
const BLANK = { account: '', window: '5 小时', other: '', resetAt: '', expiresAt: '', note: '' };
const iso = (v: string): string | null => (v ? new Date(v).toISOString() : null);
const fmt = (v?: string | null): string => (v ? v.slice(0, 16).replace('T', ' ') : '—');

export function QuotaSettingsCard() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [url, setUrl] = useState('');
  const [form, setForm] = useState(BLANK);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const v = await api.getSettings();
      setView(v);
      setUrl(v.cockpit?.quotahubUrl ?? '');
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (input: { quotahubUrl?: string; manualQuotas?: ManualQuota[] }) => {
    try {
      await api.saveCockpitSettings(input);
      await load();
      setMsg({ ok: true, text: '已保存。' });
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    }
  };
  const entries = view?.cockpit?.manualQuotas ?? [];
  const field = (k: keyof typeof BLANK) => ({
    value: form[k],
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value })),
  });
  const add = () => {
    const window = form.window === '其他' ? form.other.trim() : form.window;
    if (!form.account.trim() || !window) {
      setMsg({ ok: false, text: '账号显示名和窗口名都要填。' });
      return;
    }
    const entry: ManualQuota = {
      account: form.account.trim(),
      window,
      resetAt: iso(form.resetAt),
      expiresAt: iso(form.expiresAt),
      registeredAt: new Date().toISOString(),
      note: form.note.trim() || undefined,
    };
    void save({ manualQuotas: [...entries, entry] });
    setForm({ ...BLANK, window: form.window });
  };
  const area = { display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'end' as const };

  return (
    <Card title="额度来源" testId="settings-quotas">
      {msg && (
        <p className={msg.ok ? 'muted' : 'warn'} data-testid="settings-quotas-error">
          {msg.text}
        </p>
      )}
      <label className="field">
        <span className="field-label">QuotaHub 地址</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:8787"
          data-testid="settings-quotahub-url"
        />
        <span className="field-hint">
          只填 http://127.0.0.1:端口 或 http://localhost:端口；留空 = 关闭
        </span>
      </label>
      <Button
        kind="primary"
        onClick={() => void save({ quotahubUrl: url.trim() })}
        testId="settings-quotahub-save"
      >
        保存地址
      </Button>
      <h3>手动额度</h3>
      <p className="muted">QuotaHub 还不支持的（比如 Claude）先手动登记；每项一个窗口。</p>
      <ul className="work-run-list">
        {entries.map((e, i) => (
          <li key={i} className="work-run" data-testid="settings-manual-quota">
            <strong>{e.account}</strong>
            <span className="muted">{e.window}</span>
            <span className="muted">重置 {fmt(e.resetAt)}</span>
            <Button
              kind="ghost"
              onClick={() => void save({ manualQuotas: entries.filter((_, j) => j !== i) })}
              testId={`settings-manual-remove-${i}`}
            >
              删掉
            </Button>
          </li>
        ))}
      </ul>
      <div style={area}>
        <label className="field">
          <span className="field-label">账号显示名</span>
          <input
            {...field('account')}
            placeholder="Claude 订阅"
            data-testid="settings-manual-account"
          />
        </label>
        <label className="field">
          <span className="field-label">窗口</span>
          <select {...field('window')} data-testid="settings-manual-window">
            {WINDOWS.map((w) => (
              <option key={w}>{w}</option>
            ))}
          </select>
        </label>
        {form.window === '其他' && (
          <label className="field">
            <span className="field-label">窗口名</span>
            <input {...field('other')} data-testid="settings-manual-window-other" />
          </label>
        )}
        <label className="field">
          <span className="field-label">下次重置</span>
          <input type="datetime-local" {...field('resetAt')} data-testid="settings-manual-reset" />
        </label>
        <label className="field">
          <span className="field-label">订阅到期</span>
          <input type="date" {...field('expiresAt')} data-testid="settings-manual-expires" />
        </label>
        <label className="field">
          <span className="field-label">备注（可选）</span>
          <input {...field('note')} data-testid="settings-manual-note" />
        </label>
        <Button kind="primary" onClick={add} testId="settings-manual-add">
          登记
        </Button>
      </div>
    </Card>
  );
}
