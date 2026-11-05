/**
 * MP2b：「模型」页（规格第 10 条 / 验收条件 11–15 的界面部分）。
 *
 * 三块：供应商卡片、用途三个下拉框、手动登记的额度（默认收起）。
 * 界面不碰 Key：只显示后四位或「已保存 / 未配置」，完整 Key 与密文永远不回到这里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const encode = (providerId: string, model: string): string =>
  providerId === 'default' ? model : `${providerId}${sep}${model}`;
function decode(value: string): { providerId: string; model: string } | null {
  if (!value) return null;
  const at = value.indexOf(sep);
  if (at <= 0) return { providerId: 'default', model: value };
  return { providerId: value.slice(0, at), model: value.slice(at + sep.length) };
}

/** 从地址里取主机:端口，给「没连上 magpie」那句话用。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
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
const USE_NAMES = { analysis: '后台分析', chat: '聊天', coding: '编码任务' } as const;
const EMPTY_DRAFT: Draft = { name: '', apiBaseUrl: '', apiKey: '', kind: 'openai' };

/** MP3b：一个用途的替补列表（添加 / 上移 / 下移 / 删掉）。 */
function FallbackEditor({
  use,
  list,
  labelOf,
  options,
  onChange,
}: {
  use: 'analysis' | 'chat';
  list: Array<{ providerId: string; model: string }>;
  labelOf: (providerId: string, model: string) => string;
  options: Array<{ value: string; label: string }>;
  onChange: (list: Array<{ providerId: string; model: string }>) => void;
}) {
  const [pick, setPick] = useState('');
  const chosen = options.some((o) => o.value === pick) ? pick : (options[0]?.value ?? '');
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  const decoded = decode(chosen);
  const canAdd = list.length < 4 && decoded !== null;
  return (
    <div className="fallback-editor">
      <div className="muted">替补（这一个不行按顺序换下一个）</div>
      <ul data-testid={`fallback-list-${use}`} style={{ listStyle: 'none', paddingLeft: 0 }}>
        {list.map((item) => (
          <li key={`${use}-${item.providerId}-${item.model}`}>
            {labelOf(item.providerId, item.model)}
          </li>
        ))}
        <div className="row">
          {list.map((item, i) => (
            <span key={`act-${use}-${item.providerId}-${item.model}`}>
              <Button onClick={() => move(i, i - 1)}>上移</Button>
              <Button onClick={() => move(i, i + 1)}>下移</Button>
              <Button onClick={() => onChange(list.filter((_, j) => j !== i))}>删掉</Button>
            </span>
          ))}
        </div>
      </ul>
      <div data-testid={`fallback-add-${use}`}>
        <select value={chosen} onChange={(e) => setPick(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>{' '}
        <Button
          disabled={!canAdd}
          onClick={() => {
            if (!decoded) return;
            onChange([...list, decoded]);
            setPick('');
          }}
        >
          添加
        </Button>
      </div>
    </div>
  );
}

export function ModelsPage() {
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [uses, setUses] = useState<Uses>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [upstream, setUpstream] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState('');
  const [fallbacks, setFallbacks] = useState<{
    analysis: Array<{ providerId: string; model: string }>;
    chat: Array<{ providerId: string; model: string }>;
  }>({ analysis: [], chat: [] });
  const [keyCleared, setKeyCleared] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, { base: string; key: string }>>({});
  // 每次检测一个序号：保存会让在途检测作废，迟到的旧清单不许盖上来
  const reqSeq = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      const [list, view] = await Promise.all([api.listModelProviders(), api.getSettings()]);
      setProviders(list);
      // uses 里没有的，按旧字段回显（default 那家选择会写回 modelName / chatModelName）
      const cfgUses = (view.config.uses ?? {}) as Uses;
      setUses({
        analysis:
          cfgUses.analysis ??
          (view.config.modelName
            ? { providerId: 'default', model: view.config.modelName }
            : undefined),
        chat:
          cfgUses.chat ??
          (view.config.chatModelName
            ? { providerId: 'default', model: view.config.chatModelName }
            : undefined),
        coding: cfgUses.coding,
      });
      setCurrentModel(view.config.modelName ?? '');
      const cfgFallbacks = (view.config.fallbacks ?? {}) as {
        analysis?: Array<{ providerId: string; model: string }>;
        chat?: Array<{ providerId: string; model: string }>;
      };
      setFallbacks({ analysis: cfgFallbacks.analysis ?? [], chat: cfgFallbacks.chat ?? [] });
      setEdits((cur) => {
        const next = { ...cur };
        for (const p of list) if (!next[p.id]) next[p.id] = { base: p.apiBaseUrl, key: '' };
        return next;
      });
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

  const labelOf = (providerId: string, model: string): string => {
    if (providerId === 'default') return '默认 · ' + model;
    const p = providers.find((x) => x.id === providerId);
    return (p?.name ?? providerId) + ' · ' + model;
  };

  const primaryOf = (use: 'analysis' | 'chat'): { providerId: string; model: string } | null => {
    const chosen = uses[use];
    if (chosen) return { providerId: chosen.providerId, model: chosen.model };
    if (use === 'chat') return uses.analysis ?? null;
    if (!uses.analysis && currentModel.trim())
      return { providerId: 'default', model: currentModel };
    return null;
  };

  const chatFollows = !uses.chat;

  const optionsFor = (use: 'analysis' | 'chat'): Array<{ value: string; label: string }> => {
    const primary = primaryOf(use);
    const taken = new Set<string>((fallbacks[use] ?? []).map((f) => encode(f.providerId, f.model)));
    if (primary) taken.add(encode(primary.providerId, primary.model));
    return choices.filter((c) => !taken.has(c.value));
  };

  // 分析下拉要把「在用的模型」也列出来（不在已保存清单时标注）
  const analysisOptions = useMemo(() => {
    const list = [...choices];
    const inUseModel = uses.analysis?.model ?? currentModel;
    const inUseProvider = uses.analysis?.providerId ?? 'default';
    const has = list.some((c) => c.value === encode(inUseProvider, inUseModel));
    if (inUseModel && !has) {
      list.unshift({
        value: encode(inUseProvider, inUseModel),
        label: `${inUseModel}（不在已保存清单）`,
      });
    }
    return list;
  }, [choices, uses.analysis, currentModel]);

  const save = async (id: string): Promise<void> => {
    const row = providers.find((p) => p.id === id);
    if (!row) return;
    // 保存使在途检测作废（旧凭据下的清单不许回填）
    reqSeq.current[id] = (reqSeq.current[id] ?? 0) + 1;
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveModelProvider({
        id,
        name: row.name,
        kind: row.kind,
        apiBaseUrl: edits[id]?.base ?? row.apiBaseUrl,
        ...(edits[id]?.key ? { apiKey: edits[id]!.key } : {}),
        savedModels: checked[id] ?? [],
      });
      setKeyCleared((cur) => ({ ...cur, [id]: Boolean(res.keyCleared) }));
      // 填过的 Key 不留在界面上
      setEdits((cur) => ({ ...cur, [id]: { base: cur[id]?.base ?? row.apiBaseUrl, key: '' } }));
      setNotice('已保存勾选');
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async (id: string): Promise<void> => {
    const row = providers.find((p) => p.id === id);
    const seq = (reqSeq.current[id] ?? 0) + 1;
    reqSeq.current[id] = seq;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 卡片上改了地址或填了 Key 还没保存：用填的去检测（整合方并入时修）
      const typed = edits[id];
      const input = {
        ...(typed && typed.base.trim() && typed.base !== row?.apiBaseUrl
          ? { apiBaseUrl: typed.base }
          : {}),
        ...(typed?.key.trim() ? { apiKey: typed.key } : {}),
      };
      const result = await api.fetchProviderModels(id, input);
      if (reqSeq.current[id] !== seq) return; // 迟到的旧清单：丢掉
      if (result.error) {
        // 检测失败：如实报错，清单和勾选都不动
        // magpie 没起的时候说人话（跟旧设置页同一句）
        const magpieDown =
          row?.kind === 'magpie' && /fetch failed|ECONNREFUSED|abort|network/i.test(result.error);
        setError(
          magpieDown
            ? `没连上本机 magpie（${hostOf(row!.apiBaseUrl)}），先把 magpie 打开`
            : result.error,
        );
        return;
      }
      setUpstream((cur) => ({ ...cur, [id]: result.models }));
      const up = new Set(result.models);
      const stillSaved = row?.savedModels ?? [];
      // 勾了没保存、上游已没有 → 清掉；上游仍有的（含已保存的）保留
      setChecked((cur) => ({
        ...cur,
        [id]: (cur[id] ?? []).filter((m) => up.has(m) || stillSaved.includes(m)),
      }));
      setNotice(`获取到 ${String(result.models.length)} 个模型`);
    } catch (err) {
      if (reqSeq.current[id] !== seq) return;
      setError(errMsg(err));
    } finally {
      if (reqSeq.current[id] === seq) setBusy(false);
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
      await api.saveModelFallbacks({ analysis: fallbacks.analysis, chat: fallbacks.chat });
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
        <p className="ok-banner" data-testid="models-notice">
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
                onClick={() => void save(view.id)}
              >
                保存勾选
              </Button>
              {view.id === 'default' ? null : (
                <Button
                  kind="default"
                  testId={`provider-delete-${view.id}`}
                  onClick={() => void remove(view.id)}
                >
                  删除
                </Button>
              )}
              {view.usedBy.length > 0 ? (
                <span className="muted" data-testid={`provider-usedby-${view.id}`}>
                  {view.usedBy.map((u) => USE_NAMES[u]).join('、')}在用它
                </span>
              ) : null}
            </div>
            <div className="row">
              <input
                className="input"
                data-testid={`provider-base-input-${view.id}`}
                value={edits[view.id]?.base ?? view.apiBaseUrl}
                onChange={(e) => {
                  const base = e.currentTarget.value;
                  setEdits((cur) => ({
                    ...cur,
                    [view.id]: { base, key: cur[view.id]?.key ?? '' },
                  }));
                }}
              />
              <input
                className="input"
                type="password"
                placeholder="Key（留空 = 不改）"
                data-testid={`provider-key-input-${view.id}`}
                value={edits[view.id]?.key ?? ''}
                onChange={(e) => {
                  const key = e.currentTarget.value;
                  setEdits((cur) => ({
                    ...cur,
                    [view.id]: { base: cur[view.id]?.base ?? view.apiBaseUrl, key },
                  }));
                }}
              />
            </div>
            {keyCleared[view.id] ? (
              <p className="warn" data-testid={`provider-key-cleared-${view.id}`}>
                地址变了，原来的 Key 没有带到新地址，请在下面重新填。
              </p>
            ) : null}
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
                  <li key={model} data-testid={`model-row-${model}`} data-model-id={model}>
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
                    {isNew ? (
                      <span className="tag" data-testid={`model-badge-${model}`}>
                        新
                      </span>
                    ) : null}
                    {gone ? (
                      <span className="tag" data-testid={`model-badge-${model}`}>
                        上游已没有
                      </span>
                    ) : null}
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
            type="password"
            placeholder="Key"
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
            value={
              uses.analysis
                ? encode(uses.analysis.providerId, uses.analysis.model)
                : (analysisOptions[0]?.value ?? '')
            }
            onChange={(e) => setUses({ ...uses, analysis: decode(e.target.value) ?? undefined })}
          >
            {analysisOptions.map((c) => (
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
        <FallbackEditor
          use="analysis"
          list={fallbacks.analysis}
          labelOf={labelOf}
          options={optionsFor('analysis')}
          onChange={(list) => setFallbacks({ ...fallbacks, analysis: list })}
        />
        {chatFollows ? (
          <>
            <div className="muted" data-testid="fallback-follow-note">
              跟着后台分析，替补也用后台分析的
            </div>
            <ul data-testid="fallback-list-chat" style={{ listStyle: 'none', paddingLeft: 0 }} />
          </>
        ) : (
          <FallbackEditor
            use="chat"
            list={fallbacks.chat}
            labelOf={labelOf}
            options={optionsFor('chat')}
            onChange={(list) => setFallbacks({ ...fallbacks, chat: list })}
          />
        )}
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
