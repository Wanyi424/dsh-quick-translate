import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, Gauge, Info, Languages, LoaderCircle, Lock, PenLine, RefreshCw, Square, X } from 'lucide-react';
import type { Controller } from './controller';
import { MAX_SOURCE, type Model, type Translation } from './contracts';
import { PHASE, STATUS, count, duration, inputOf } from './format';
import { Menu, anchorFrom, copyText, usePresence, type MenuAnchor, type MenuEntry } from './ui';

const act = (c: Controller, fn: () => Promise<unknown>) => { void c.perform(fn).catch(() => {}); };

function ModelPicker({ c, models, provider, model, warnings, refreshing, disabled }: {
  c: Controller; models: Model[]; provider: string; model: string; warnings: string[]; refreshing: boolean; disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null), shown = usePresence(anchor);
  const close = useCallback(() => setAnchor(null), []);
  const selected = models.find(m => m.provider === provider && m.id === model);
  const label = selected?.name ?? (model ? `${model}（不可用）` : '选择模型');
  const entries: MenuEntry[] = [];
  models.forEach((m, i) => {
    if (m.providerName !== models[i - 1]?.providerName) entries.push({ group: m.providerName });
    entries.push({ label: m.name, checked: m === selected, onSelect: () => act(c, () => c.saveSettings({ provider: m.provider, model: m.id })) });
  });
  return <>
    <button type="button" className="dqt-model" data-state={selected ? 'ready' : 'missing'} aria-haspopup="menu" aria-expanded={!!anchor}
      aria-label={`翻译模型：${label}`} title={selected ? `${selected.name} · ${selected.providerName}` : '选择 DSH 中已配置的模型'} disabled={disabled}
      onClick={event => setAnchor(anchor ? null : anchorFrom(event.currentTarget, 'start'))}><i className="dqt-dot" /><span>{label}</span><ChevronDown /></button>
    {shown.value && <Menu anchor={shown.value} label="选择翻译模型" entries={entries} onClose={close} leaving={shown.leaving} onExited={shown.settle} className="dqt-model-menu" footer={<div className="dqt-menu-foot">
      {!models.length && <p>还没有可用的模型。请先在 DSH 设置中配置，再回来刷新。</p>}
      {warnings.map(warning => <p key={warning} data-tone="warn">{warning}</p>)}
      <button type="button" role="menuitem" disabled={refreshing} onClick={() => void c.refreshModels().catch(c.report)}>
        {refreshing ? <LoaderCircle className="dqt-spin" /> : <RefreshCw />}<span>{refreshing ? '正在刷新…' : '刷新模型列表'}</span></button>
    </div>} />}
  </>;
}

export const SourcePane = memo(function SourcePane({ c, text, viewing, running, busy, canStart, startLabel, models, provider, model, modelWarnings, refreshingModels }: {
  c: Controller; text: string; viewing: Translation | null; running: boolean; busy: boolean; canStart: boolean; startLabel: string;
  models: Model[]; provider: string; model: string; modelWarnings: string[]; refreshingModels: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const start = () => { if (canStart) act(c, () => c.start()); };
  const near = text.length > MAX_SOURCE * .9;
  return <section className="dqt-pane dqt-source" aria-label="原文">
    <div className="dqt-pane-head"><h2>原文</h2>
      {viewing ? <span className="dqt-tag"><Lock />只读</span> : text && <button type="button" className="dqt-icon-button dqt-clear" aria-label="清空原文" title="清空，开始新的翻译"
        disabled={running || busy} onClick={() => { c.newTranslation(); area.current?.focus(); }}><X /></button>}
    </div>
    <textarea ref={area} aria-label="待翻译原文" spellCheck={false} maxLength={MAX_SOURCE} readOnly={!!viewing || running || busy} value={text}
      placeholder="输入或粘贴要翻译的内容" onChange={event => c.setDraft(event.target.value)}
      onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); start(); } }} />
    <footer className="dqt-pane-foot">
      {viewing ? <>
        <span className="dqt-foot-note">{viewing.source.length.toLocaleString()} 字符</span>
        <button type="button" className="dqt-button dqt-button-secondary" disabled={running || busy} title={running ? '请等待当前翻译完成' : '把这段原文放回工作区，修改后重新翻译'}
          onClick={() => c.newTranslation(viewing.source)}><PenLine />用此原文重译</button>
      </> : <>
        <ModelPicker c={c} models={models} provider={provider} model={model} warnings={modelWarnings} refreshing={refreshingModels} disabled={running || busy} />
        <span className="dqt-foot-note" data-tone={near ? 'warn' : undefined}>{text.length ? `${text.length.toLocaleString()}${near ? ` / ${MAX_SOURCE.toLocaleString()}` : ''} 字符` : ''}</span>
        {running ? <button type="button" className="dqt-button dqt-button-secondary dqt-stop" disabled={busy} onClick={() => act(c, () => c.stop())}><Square />停止</button>
          : <button type="button" className="dqt-button dqt-button-primary dqt-translate" disabled={!canStart} onClick={start}>
            {busy ? <LoaderCircle className="dqt-spin" /> : <Languages />}<span>{startLabel}</span><kbd aria-hidden>Ctrl ↵</kbd></button>}
      </>}
    </footer>
  </section>;
});

/** Live phase and elapsed time; the ticking seconds stay out of the live region. */
function StatusPill({ record }: { record: Translation | null }) {
  const live = record?.status === 'running';
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!live) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [live]);
  if (!record) return null;
  const elapsed = live ? Math.floor((now - Date.parse(record.createdAt)) / 1000) : 0;
  return <span className="dqt-status" data-status={record.status}><i className="dqt-dot" />
    <span role="status">{live ? PHASE[record.phase ?? 'connecting'] : STATUS[record.status]}</span>
    {live ? elapsed > 0 && <small aria-hidden>{elapsed} 秒</small> : record.status === 'completed' && <small>{duration(record)}</small>}
  </span>;
}

/** Only the newest increment is a separate node, so streamed text fades in at constant DOM cost. */
function StreamingText({ text, live }: { text: string; live: boolean }) {
  const shown = useRef('');
  const previous = shown.current;
  const fresh = live && text.length > previous.length && text.startsWith(previous) ? text.slice(previous.length) : '';
  useLayoutEffect(() => { shown.current = text; });
  return <div className="dqt-text" data-live={live || undefined}>{fresh ? previous : text}{fresh && <span className="dqt-fresh" key={text.length}>{fresh}</span>}</div>;
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle'), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await copyText(text); setState('done'); } catch { setState('failed'); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 1800);
  };
  return <button type="button" className="dqt-button dqt-button-secondary dqt-copy" data-state={state} disabled={!text}
    aria-label={state === 'done' ? '已复制' : '复制译文'} onClick={() => void copy()}>
    {state === 'done' ? <Check key="done" /> : <Copy key="copy" />}<span>{state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}</span>
  </button>;
}

/** Token usage of a finished run, the way into its full details; the history link appears while the list is hidden. */
function RunMeta({ record, historic, onDetails, onShowHistory }: { record: Translation; historic: boolean; onDetails(record: Translation): void; onShowHistory?(): void }) {
  const u = record.usage;
  return <div className="dqt-foot-meta">
    <button type="button" className="dqt-meta" title="查看 token 用量、耗时与提示词" onClick={() => onDetails(record)}>
      <Gauge /><span>{u ? `输入 ${count(inputOf(u))} · 输出 ${count(u.outputTokens)} tokens` : '无用量数据'}</span>
    </button>
    {onShowHistory && !historic && !record.saveError && <button type="button" className="dqt-link dqt-saved" title="打开历史记录" onClick={onShowHistory}>已保存到历史<ChevronRight /></button>}
  </div>;
}

export const ResultPane = memo(function ResultPane({ c, record, historic, modified, busy, onDetails, onShowHistory }: {
  c: Controller; record: Translation | null; historic: boolean; modified: boolean; busy: boolean; onDetails(record: Translation): void; onShowHistory?(): void;
}) {
  const output = useRef<HTMLDivElement>(null), sticky = useRef(true);
  const live = record?.status === 'running';
  useEffect(() => { sticky.current = true; output.current?.scrollTo({ top: 0 }); }, [record?.id]);
  useEffect(() => { const el = output.current; if (live && sticky.current && el) el.scrollTop = el.scrollHeight; }, [record?.result, live]);
  return <section className="dqt-pane dqt-result" aria-label="译文" data-stale={modified || undefined}>
    <div className="dqt-pane-head"><h2>译文</h2><StatusPill record={record} /></div>
    {record?.saveError && <div className="dqt-inline" data-tone="danger" role="alert"><CircleAlert /><span>{record.saveError}</span>
      <button type="button" className="dqt-link" disabled={busy} onClick={() => act(c, () => c.retrySave())}>重试保存</button></div>}
    {record?.error && !live && <div className="dqt-inline" data-tone={record.status === 'failed' ? 'danger' : 'warn'}><Info /><span>{record.error}</span></div>}
    {modified && <div className="dqt-inline" data-tone="accent"><Info /><span>原文已修改，下方仍是上一次的译文。按 Ctrl + Enter 重新翻译。</span></div>}
    <div ref={output} className="dqt-output" tabIndex={0} aria-label="译文内容" aria-busy={live}
      onScroll={event => { const el = event.currentTarget; sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72; }}>
      {record?.result ? <StreamingText text={record.result} live={live && record.phase === 'translating'} />
        : live ? <div className="dqt-pending" data-phase={record.phase ?? 'connecting'} aria-hidden><i /><i /><i /><i /></div>
        : record ? <div className="dqt-empty"><p>这次翻译没有产生译文</p><span>可以修改原文后重新翻译。</span></div>
        : <div className="dqt-empty"><Languages /><p>译文会在这里逐段出现</p><span>按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 开始翻译</span></div>}
    </div>
    <footer className="dqt-pane-foot">
      {record && !live ? <RunMeta record={record} historic={historic} onDetails={onDetails} onShowHistory={onShowHistory} />
        : <span className="dqt-foot-note">{live ? '切换页面不会中断翻译' : ''}</span>}
      <CopyButton text={record?.result ?? ''} />
    </footer>
  </section>;
});
