import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { planSmartWrap, DEFAULT_MAX_WIDTH } from '../lib/wrap';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 当前字幕（已按 start 排序）；仅未锁定片段参与分行 */
  cues: Cue[];
  /** 确认应用：仅替换可行片段的文本（增删换行），时间/标识符/设置/锁定状态原样保留 */
  onApply: (entries: { id: string; text: string }[]) => void;
  onJump: (id: string) => void;
}

/**
 * 智能分行面板：
 * 按可见字素宽度（中文/全角计 2、其他计 1，内联标签与时间戳标签不计宽且不可拆开）
 * 为全部未锁定片段批量生成不超过两行的换行建议。断点选在空格、标点或字素边界，
 * 优先减少两行宽差；闭合标点不出现在行首、开放标点不出现在行尾。
 * 逐条预览原文、建议文本与无解原因；确认后仅增删可行字幕的换行。
 */
export default function SmartWrapPanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [maxWidth, setMaxWidth] = useState<number>(DEFAULT_MAX_WIDTH);

  const valid = Number.isInteger(maxWidth) && maxWidth >= 1;
  const plan = useMemo(
    () => (valid ? planSmartWrap(cues, maxWidth) : null),
    [cues, maxWidth, valid],
  );
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const indexById = useMemo(() => new Map(cues.map((c, i) => [c.id, i + 1])), [cues]);

  // 预览列表只展示需要处理的项目：建议 + 无解；已符合的计入汇总
  const listed = plan ? plan.items.filter((it) => it.result.kind !== 'ok') : [];

  function confirm() {
    if (!plan || plan.suggestCount === 0) return;
    const entries: { id: string; text: string }[] = [];
    for (const it of plan.items) {
      if (it.result.kind === 'suggest') entries.push({ id: it.id, text: it.result.text });
    }
    onApply(entries);
    setOpen(false);
  }

  if (!open) {
    return (
      <section className="panel wrap-panel">
        <h2>
          智能分行
          <span className="muted small ml">未锁定片段 · 不超过两行</span>
        </h2>
        <p className="muted small">
          按可见字素宽度（中文/全角计 2、其他计 1，标签不计宽）为未锁定字幕批量生成不超过两行的换行建议；确认后仅增删换行，其余字符、标签与时间码原样保留。
        </p>
        <button className="btn primary" disabled={cues.length === 0} onClick={() => setOpen(true)}>
          设置行宽并生成建议
        </button>
      </section>
    );
  }

  return (
    <section className="panel wrap-panel">
      <h2>
        智能分行
        <span className="muted small ml">每行 ≤ {valid ? maxWidth : '—'} 字素宽</span>
      </h2>
      <p className="muted small">
        断点选在空格、标点或字素边界，优先减少两行宽差；闭合标点不出现在行首、开放标点不出现在行尾；内联标签与时间戳标签不计宽且不会被拆开。
      </p>

      <label className="settings-field">
        <span>每行最大宽度</span>
        <input
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(maxWidth) ? maxWidth : ''}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setMaxWidth(Number.isFinite(v) ? v : NaN);
          }}
        />
        <span className="muted">字素宽</span>
      </label>

      {!valid && <div className="import-error">请输入不小于 1 的整数行宽。</div>}

      {plan && (
        <>
          <div className="merge-summary">
            未锁定 {plan.items.length} 条：建议调整 <strong>{plan.suggestCount}</strong> · 已符合{' '}
            {plan.okCount} · 无解 {plan.unsolvableCount}
            {plan.lockedCount > 0 && <>（另跳过锁定 {plan.lockedCount} 条）</>}
          </div>

          {listed.length === 0 ? (
            <div className="muted small merge-empty">
              {plan.items.length === 0
                ? '没有未锁定的片段。'
                : '全部未锁定片段已符合行宽要求，无需调整。'}
            </div>
          ) : (
            <ul className="merge-list wrap-list">
              {listed.map((it) => {
                const cue = cueById.get(it.id)!;
                const res = it.result;
                return (
                  <li
                    key={it.id}
                    className={`merge-row ${res.kind === 'suggest' ? 'paired' : 'unsolvable'}`}
                    onClick={() => onJump(it.id)}
                    title="点击定位到该片段"
                  >
                    <div className="merge-head mono">
                      <span className="merge-idx">#{indexById.get(it.id)}</span>
                      <span>
                        {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                      </span>
                    </div>
                    <div className="wrap-label">原文（行宽 {res.currentWidths.join(' / ')}）</div>
                    <div className="merge-text main">{cue.text}</div>
                    {res.kind === 'suggest' && (
                      <>
                        <div className="wrap-label sugg">建议（行宽 {res.lineWidths.join(' / ')}）</div>
                        <div className="merge-text wrap-sugg">{res.text}</div>
                      </>
                    )}
                    {res.kind === 'unsolvable' && (
                      <div className="wrap-reason">⛔ 无解：{res.reason}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="merge-actions end">
            <button className="btn" onClick={() => setOpen(false)}>取消</button>
            <button className="btn primary" disabled={plan.suggestCount === 0} onClick={confirm}>
              确认应用换行（{plan.suggestCount} 条）
            </button>
          </div>
        </>
      )}
    </section>
  );
}
