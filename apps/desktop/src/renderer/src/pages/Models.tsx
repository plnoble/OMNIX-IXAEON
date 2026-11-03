/**
 * MP2b：「模型」页（规格第 10 条 / 验收条件 11–15 的界面部分）。
 *
 * 三块：供应商卡片、用途三个下拉框、手动登记的额度（默认收起）。
 * 界面不碰 Key：只显示后四位或「已保存 / 未配置」，完整 Key 与密文永远不回到这里。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelProviderView } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Button, Card } from '../ui.js';
import { QuotaSettingsCard } from './QuotaSettings.js';

interface Uses {
  analysis?: { providerId: string; model: string };
  chat?: { providerId: string; model: string };
  coding?: { providerId: string; model: string };
}

/** 下拉选项的 value 编码：`providerId::model`；空串 = 没单独选（走旧字段 / 跟着后台分析）。 */
const sep = '::';
const encode = (providerId: string, model: string): string => `${providerId}${sep}${model}`;
function decode(value: string): { providerId: string; model: string } | null {
  const at = value.indexOf(sep);
  if (at <= 0) return null;
  return { providerId: value.slice(0, at), model: value.slice(at + sep.length) };
}

function keyText(view: ModelProviderView): string {
  if (!view.apiKeyPresent) return '未配置';
  if (view.apiKeyUnreadable) return 'Key 解不开，请重新填';
  if (view.apiKeyTail) return `已保存 ····${view.apiKeyTail}`;
  return '已保存';
}

interface Draft {
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  kind: 'openai' | 'magpie';
}
const EMPTY_DRAFT: Draft = { name: '', apiBaseUrl: '', apiKey: '', kind: 'openai' };

export function ModelsPage() {
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [uses, setUses] = useState<Uses>({});
  const [savedModels, setSavedModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [upstream, setUpstream] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, view] = await Promise.all([api.listModelProviders(), api.getSettings()]);
      setProviders(list);
      setUses((view.config.uses ?? {}) as Uses);
      setSavedModels(view.config.savedModels ?? []);
      setChecked(Object.fromEntries(list.map((p) => [p.id, [...p.savedModels]])));
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasMagpie = providers.some((p) => p.kind === 'magpie');

  /** 三个用途的候选：所有供应商勾选过的模型，显示成「供应商名 · 模型」。 */
  const choices = useMemo(
    () =>
      providers.flatMap((p) =>
        p.savedModels.map((m) => ({ value: encode(p.id, m), label: `${p.name} · ${m}` })),
      ),
    [providers],
  );

  const save = async (id: string): Promise<void> => {
    const row = providers.find((p) => p.id === id);
    if (!row) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveModelProvider({
        id,
        name: row.name,
        kind: row.kind,
        apiBaseUrl: row.apiBaseUrl,
        savedModels: checked[id] ?? [],
      });
      setNotice('已保存勾选');
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.fetchProviderModels(id);
      if (result.error) setError(result.error);
      else {
        setUpstream((cur) => ({ ...cur, [id]: result.models }));
        setNotice(`获取到 ${String(result.models.length)} 个模型`);
      }
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await api.deleteModelProvider(id);
      await load();
    } catch (err) {
      // 被用途用着：把拒绝原因显示出来，卡片不动
      setError(errMsg(err));
    }
  };

  const addProvider = async (): Promise<void> => {
    setError(null);
    try {
      await api.saveModelProvider({
        name: draft.name.trim(),
        kind: draft.kind,
        apiBaseUrl: draft.apiBaseUrl.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      });
      setDraft(EMPTY_DRAFT);
      setNotice('已添加');
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const saveUses = async (): Promise<void> => {
    setError(null);
    try {
      await api.saveModelUses({
        analysis: uses.analysis ?? null,
        chat: uses.chat ?? null,
        coding: uses.coding ?? null,
      });
      setNotice('用途已保存');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const rowsFor = (view: ModelProviderView): string[] => {
    const up = upstream[view.id];
    const own = checked[view.id] ?? [];
    const all = new Set<string>([...(up ?? []), ...own]);
    return [...all].sort();
  };

  return (
    <div className="page" data-testid="models-page">
      <h1>模型</h1>
      {error ? (
        <p className="warn" data-testid="models-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="muted" data-testid="models-notice">
          {notice}
        </p>
      ) : null}

      <Card title="供应商" testId="models-providers">
        <p className="muted">
          接几家的模型都行：填地址和
          Key、获取可用模型、勾选保存。聊天和分析用哪家由下面的「用途」决定。
        </p>
        {providers.map((view) => (
          <div className="card" data-testid={`provider-card-${view.id}`} key={view.id}>
            <div className="row">
              <strong data-testid={`provider-name-${view.id}`}>{view.name}</strong>
              {view.kind === 'magpie' ? <span className="tag">magpie</span> : null}
              <span className="muted" data-testid={`provider-base-${view.id}`}>
                {view.apiBaseUrl || '没填地址'}
              </span>
              <span className="muted" data-testid={`provider-key-${view.id}`}>
                {keyText(view)}
              </span>
            </div>
            <div className="row">
              <Button
                testId={`provider-models-${view.id}`}
                onClick={() => void fetchModels(view.id)}
              >
                获取模型
              </Button>
              <Button
                kind="primary"
                testId={`provider-save-${view.id}`}
                disabled={busy}
                onClick={() => void save(view.id)}
              >
                保存勾选
              </Button>
              <Button
                kind="default"
                testId={`provider-delete-${view.id}`}
                onClick={() => void remove(view.id)}
              >
                删除
              </Button>
              {view.usedBy.length > 0 ? (
                <span className="muted" data-testid={`provider-usedby-${view.id}`}>
                  {view.usedBy.join('、')}在用它
                </span>
              ) : null}
            </div>
            <input
              className="input"
              placeholder="筛选模型"
              data-testid={`model-filter-${view.id}`}
              value={filter[view.id] ?? ''}
              onInput={(e) => {
                // 先取值：事件对象在 setState 的更新函数里已经失效
                const value = e.currentTarget.value;
                setFilter((cur) => ({ ...cur, [view.id]: value }));
              }}
            />
            <ul className="list" data-testid={`provider-checklist-${view.id}`}>
              {rowsFor(view).map((model) => {
                const keyword = (filter[view.id] ?? '').trim().toLowerCase();
                if (keyword && !model.toLowerCase().includes(keyword)) return null;
                const isNew = upstream[view.id] !== undefined && !view.savedModels.includes(model);
                const gone = upstream[view.id] !== undefined && !upstream[view.id]!.includes(model);
                return (
                  <li key={model} data-testid={`model-row-${model}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={(checked[view.id] ?? []).includes(model)}
                        onChange={(e) =>
                          setChecked((cur) => {
                            const own = new Set(cur[view.id] ?? []);
                            if (e.target.checked) own.add(model);
                            else own.delete(model);
                            return { ...cur, [view.id]: [...own] };
                          })
                        }
                      />
                      {model}
                    </label>
                    {isNew ? <span className="tag">新</span> : null}
                    {gone ? <span className="tag">上游已没有</span> : null}
                  </li>
                );
              })}
            </ul>
            {view.kind === 'magpie' ? (
              <div data-testid={`provider-quota-${view.id}`}>
                <QuotaSettingsCard />
              </div>
            ) : null}
          </div>
        ))}

        <div className="card" data-testid="provider-add">
          <strong>添加供应商</strong>
          <input
            className="input"
            placeholder="名字"
            data-testid="provider-add-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className="input"
            placeholder="地址（例如 http://127.0.0.1:3425/v1）"
            data-testid="provider-add-base"
            value={draft.apiBaseUrl}
            onChange={(e) => setDraft({ ...draft, apiBaseUrl: e.target.value })}
          />
          <input
            className="input"
            placeholder="Key（留空 = 不改已保存的）"
            data-testid="provider-add-key"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          />
          <div className="row">
            <Button kind="primary" testId="provider-add-save" onClick={() => void addProvider()}>
              添加
            </Button>
            <Button
              kind="default"
              testId="provider-magpie-preset"
              disabled={hasMagpie}
              onClick={() =>
                setDraft({
                  name: '本机 magpie',
                  apiBaseUrl: 'http://127.0.0.1:3425/v1',
                  apiKey: 'magpie',
                  kind: 'magpie',
                })
              }
            >
              用本机 magpie
            </Button>
            {hasMagpie ? <span className="muted">已经有一家 magpie 了</span> : null}
          </div>
        </div>
      </Card>

      <Card title="用途" testId="models-uses">
        <p className="muted">三个用途各自用哪家的哪个模型。聊天不选就跟着后台分析走。</p>
        <label>
          后台分析
          <select
            data-testid="uses-analysis"
            value={uses.analysis ? encode(uses.analysis.providerId, uses.analysis.model) : ''}
            onChange={(e) => setUses({ ...uses, analysis: decode(e.target.value) ?? undefined })}
          >
            <option value="">默认 · {savedModels.join(' / ') || '（没配）'}</option>
            {choices.map((c) => (
              <option key={`a-${c.value}`} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          聊天
          <select
            data-testid="uses-chat"
            value={uses.chat ? encode(uses.chat.providerId, uses.chat.model) : ''}
            onChange={(e) => setUses({ ...uses, chat: decode(e.target.value) ?? undefined })}
          >
            <option value="">跟着后台分析</option>
            {choices.map((c) => (
              <option key={`c-${c.value}`} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          编码任务「我的模型」
          <select
            data-testid="uses-coding"
            value={uses.coding ? encode(uses.coding.providerId, uses.coding.model) : ''}
            onChange={(e) => setUses({ ...uses, coding: decode(e.target.value) ?? undefined })}
          >
            <option value="">默认</option>
            {choices.map((c) => (
              <option key={`g-${c.value}`} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <Button kind="primary" testId="uses-save" onClick={() => void saveUses()}>
          保存
        </Button>
      </Card>

      <Card title="手动登记的额度" testId="models-manual-quota">
        <details>
          <summary className="muted">展开</summary>
          <QuotaSettingsCard />
        </details>
      </Card>
    </div>
  );
}
