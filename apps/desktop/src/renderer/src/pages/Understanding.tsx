import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg, type Item, type ItemEvidenceView, type Project } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Field, Spinner } from '../ui.js';

const TYPE_LABELS: Record<string, string> = {
  project_summary: '项目概括',
  decision: '当前决定',
  rejected_option: '已否决',
  open_loop: '未完成',
  goal: '目标',
  constraint: '约束',
  preference: '偏好',
};

const ORIGIN_LABELS: Record<string, string> = {
  ai: 'AI 提取',
  user: '用户',
  work_result: '工作记录',
};

const TYPE_ORDER = [
  'project_summary',
  'decision',
  'rejected_option',
  'goal',
  'open_loop',
  'constraint',
  'preference',
] as const;

/** 理解页（项目卡）：当前结论按类型分组；依据可展开；纠正入口。 */
export function UnderstandingPage({ projects }: { projects: Project[] }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ItemEvidenceView[] | null>(null);
  const [correcting, setCorrecting] = useState<Item | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    try {
      // M2 冲突真的可见：不只取 current 再筛 —— disputed 一并取回由下方分组展示
      setItems(await api.listItems({ projectId: null, shelved: false }));
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 修复：纠正对话框渲染在列表之后（页面底部）——打开时滚到可见位置，
  // 否则用户在长列表里点「纠正」看起来像没有反应。
  useEffect(() => {
    if (correcting) {
      requestAnimationFrame(() => dialogRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  }, [correcting]);

  const showEvidence = async (itemId: string) => {
    if (expanded === itemId) {
      setExpanded(null);
      setEvidence(null);
      return;
    }
    try {
      setEvidence(await api.getItemEvidence(itemId));
      setExpanded(itemId);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const active =
    items?.filter(
      (i) =>
        !i.shelved_at &&
        !(
          i.origin === 'ai' &&
          i.type === 'project_summary' &&
          (i.rationale ?? '').startsWith('归档经验摘要')
        ),
    ) ?? [];
  const current = active.filter((i) => i.state === 'current');
  const disputed = active.filter((i) => i.state === 'disputed');

  return (
    <div data-testid="page-understanding">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card title="当前结论（项目卡）" testId="understanding-card">
        <p className="note">
          IXAEON 对项目的当前理解。每条可展开依据核验，可纠正；纠正后旧结论仍可追溯（见“历史”页）。
        </p>
        {items === null ? (
          <Spinner />
        ) : current.length === 0 ? (
          <Empty testId="understanding-empty">
            还没有提取结果。导入来源后任务会自动排队提取（需在设置中配置模型）。
          </Empty>
        ) : (
          TYPE_ORDER.map((type) => {
            const group = current.filter((i) => i.type === type);
            if (group.length === 0) return null;
            return (
              <div key={type} className="item-group" data-testid={`item-group-${type}`}>
                <h3>{TYPE_LABELS[type]}</h3>
                {group.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    projectName={
                      item.project_id ? (projectById.get(item.project_id)?.name ?? null) : null
                    }
                    expanded={expanded === item.id}
                    evidence={expanded === item.id ? evidence : null}
                    onToggleEvidence={() => void showEvidence(item.id)}
                    onCorrect={() => setCorrecting(item)}
                    onChanged={reload}
                  />
                ))}
              </div>
            );
          })
        )}
      </Card>

      {disputed.length > 0 && (
        <Card title={`存在冲突的结论（${disputed.length} 条）`} testId="disputed-card">
          <p className="note">不同来源得出了相似但矛盾的结论，IXAEON 不替你选边，请人工确认。</p>
          {disputed.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              projectName={
                item.project_id ? (projectById.get(item.project_id)?.name ?? null) : null
              }
              expanded={expanded === item.id}
              evidence={expanded === item.id ? evidence : null}
              onToggleEvidence={() => void showEvidence(item.id)}
              onCorrect={() => setCorrecting(item)}
              onChanged={reload}
              disputed
            />
          ))}
        </Card>
      )}

      {correcting && (
        <div ref={dialogRef}>
          <CorrectionDialog
            item={correcting}
            onClose={() => setCorrecting(null)}
            onDone={() => {
              setCorrecting(null);
              void reload();
            }}
          />
        </div>
      )}
    </div>
  );
}

function ItemRow({
  item,
  projectName,
  expanded,
  evidence,
  onToggleEvidence,
  onCorrect,
  onChanged,
  disputed = false,
}: {
  item: Item;
  projectName: string | null;
  expanded: boolean;
  evidence: ItemEvidenceView[] | null;
  onToggleEvidence: () => void;
  onCorrect: () => void;
  /** 确认/不采纳/搁置后的局部刷新（不整页 reload —— 修复确认后跳回总览） */
  onChanged: () => Promise<void>;
  disputed?: boolean;
}) {
  const [shelved, setShelved] = useState(item.shelved_at !== null);
  return (
    <article
      className={`item-row ${disputed ? 'item-disputed' : ''}`}
      data-testid={`item-${item.id}`}
    >
      <header>
        {disputed && <span className="badge badge-paused">冲突</span>}
        {item.origin === 'user' && <span className="badge badge-active">用户确认</span>}
        {item.confirmation === 'confirmed' && (
          <span className="badge badge-active" data-testid={`confirmed-${item.id}`}>
            用户已确认
          </span>
        )}
        {item.confirmation === 'rejected' && (
          <span className="badge badge-paused" data-testid={`rejected-${item.id}`}>
            已不采纳
          </span>
        )}
        <span className="muted">{ORIGIN_LABELS[item.origin] ?? item.origin}</span>
        {projectName && <span className="muted">· {projectName}</span>}
        <span className="muted">· 把握 {Math.round(item.confidence * 100)}%</span>
      </header>
      <p className="item-statement">{item.statement}</p>
      {item.rationale && <p className="item-rationale">{item.rationale}</p>}
      <div className="item-actions">
        {item.origin === 'ai' && item.state === 'current' && item.confirmation === 'none' && (
          <>
            <Button
              onClick={async () => {
                await api.confirmItem(item.id);
                await onChanged(); // 局部刷新，停留在理解页继续工作
              }}
              testId={`confirm-${item.id}`}
            >
              确认正确
            </Button>
            <Button
              kind="ghost"
              onClick={async () => {
                await api.rejectItem(item.id);
                await onChanged();
              }}
              testId={`reject-${item.id}`}
            >
              不采纳
            </Button>
          </>
        )}
        <Button kind="ghost" onClick={onToggleEvidence}>
          {expanded ? '收起依据' : '查看依据'}
        </Button>
        <Button kind="ghost" onClick={onCorrect} testId={`correct-${item.id}`}>
          纠正
        </Button>
        <Button
          kind="ghost"
          onClick={async () => {
            await api.shelveItem({ itemId: item.id, shelved: !shelved });
            setShelved(!shelved);
            await onChanged(); // 搁置后条目应从列表消失（shelved 过滤）
          }}
        >
          {shelved ? '取消搁置' : '搁置'}
        </Button>
        {item.updated_at && (
          <span className="muted">{item.updated_at.slice(0, 19).replace('T', ' ')}</span>
        )}
      </div>
      {expanded && (
        <div className="evidence-panel" data-testid={`evidence-${item.id}`}>
          {evidence === null ? (
            <Spinner label="加载依据…" />
          ) : evidence.length === 0 ? (
            <p className="empty">该条目没有原文依据（手工或用户纠正条目）。</p>
          ) : (
            evidence.map((e) => (
              <div key={e.segment_id} className="evidence-entry">
                <header>
                  <strong>{e.sourceTitle}</strong>
                  <span className="muted">片段 #{e.segment.sequence + 1}</span>
                </header>
                <pre className="segment-text segment-focus">{e.segment.text}</pre>
              </div>
            ))
          )}
        </div>
      )}
    </article>
  );
}

/** 纠正对话框：预览变化 → 确认（计划 5.5）。 */
function CorrectionDialog({
  item,
  onClose,
  onDone,
}: {
  item: Item;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ oldStatement: string; newStatement: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doPreview = async () => {
    if (text.trim().length === 0) {
      setError('请输入纠正后的结论');
      return;
    }
    setBusy(true);
    try {
      setPreview(await api.previewCorrection({ itemId: item.id, userText: text.trim() }));
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    setBusy(true);
    try {
      await api.correctItem({ itemId: item.id, userText: text.trim() });
      onDone();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Card title="纠正这条结论" testId="correction-dialog">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <p className="note">
        旧结论：<span className="old-statement">{item.statement}</span>
      </p>
      <Field label="你的新结论" hint="原始资料不会被修改；旧结论将标记为“已被替代”并保留在历史中。">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="correction-input"
        />
      </Field>
      {!preview ? (
        <div className="wizard-nav">
          <Button onClick={onClose}>取消</Button>
          <Button disabled={busy} onClick={doPreview} testId="correction-preview">
            预览变化
          </Button>
        </div>
      ) : (
        <div className="correction-preview" data-testid="correction-preview-panel">
          <p>
            <span className="badge badge-muted">旧</span> {preview.oldStatement}
          </p>
          <p>↓ 纠正为</p>
          <p>
            <span className="badge badge-active">新</span> {preview.newStatement}
          </p>
          <div className="wizard-nav">
            <Button onClick={() => setPreview(null)}>返回修改</Button>
            <Button kind="primary" disabled={busy} onClick={doConfirm} testId="correction-confirm">
              确认纠正
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
