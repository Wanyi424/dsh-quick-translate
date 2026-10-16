import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, CircleAlert, Copy, Gauge, History, LoaderCircle, MoreHorizontal, PanelLeftClose, PenLine, Settings2, Trash2, X } from 'lucide-react';
import type { Controller } from './controller';
import type { HistoryPage, Status, Summary, Translation } from './contracts';
import { STATUS, count, fullTime, groupOf, startOfDay, timeOf } from './format';
import { LayerContext, Menu, Toast, anchorAt, anchorFrom, copyText, usePresence, type MenuAnchor, type MenuEntry } from './ui';
import { ResultPane, SourcePane } from './workspace';
import { ConfirmDialog, MigrateDialog, SettingsSheet } from './settings';
import { DetailsDialog } from './details';
import css from './styles.css';

type Layout = 'wide' | 'medium' | 'narrow';
type Modal = { kind: 'migrate' } | { kind: 'clear' } | { kind: 'delete'; id: string } | { kind: 'details'; record: Translation } | null;
const RAIL_KEY = 'dsh-quick-translate:history-rail';
function readRail() { try { return localStorage.getItem(RAIL_KEY) !== 'hidden'; } catch { return true; } }
function saveRail(shown: boolean) { try { localStorage.setItem(RAIL_KEY, shown ? 'shown' : 'hidden'); } catch { /* Preference only. */ } }

/**
 * Plugin width, not window width: the host sidebar and window size both change the space available. Unknown (null) until
 * the first measurement, which happens before the first paint; nothing layout-dependent, such as the rail, renders from a guess.
 */
function useLayout(element: HTMLElement | null): Layout | null {
  const [layout, setLayout] = useState<Layout | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = (width: number) => setLayout(width >= 1040 ? 'wide' : width >= 720 ? 'medium' : 'narrow');
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element); return () => observer.disconnect();
  }, [element]);
  return layout;
}

const HistoryRail = memo(function HistoryRail({ c, history, loaded, loadingMore, viewingId, currentId, currentStatus, running, busy, overlay, leaving, onExited, onPick, onCollapse, onDelete, onDetails }: {
  c: Controller; history: HistoryPage; loaded: boolean; loadingMore: boolean; viewingId?: string; currentId?: string; currentStatus?: Status;
  running: boolean; busy: boolean; overlay: boolean; leaving: boolean; onExited(): void; onPick(id: string): void; onCollapse(): void; onDelete(id: string): void; onDetails(record: Translation): void;
}) {
  const list = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; item: Summary } | null>(null), shownMenu = usePresence(menu);
  const closeMenu = useCallback(() => setMenu(null), []);
  const today = startOfDay(new Date());
  const groups = useMemo(() => {
    const result: [string, Summary[]][] = [];
    for (const item of history.items) {
      const label = groupOf(item.createdAt, today), last = result.at(-1);
      if (last?.[0] === label) last[1].push(item); else result.push([label, [item]]);
    }
    return result;
  }, [history.items, today]);
  useEffect(() => {
    const target = sentinel.current; if (!target) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void c.loadMore(); }, { root: list.current, rootMargin: '160px' });
    observer.observe(target); return () => observer.disconnect();
  }, [c, history.next, history.items.length]);
  const entries = (item: Summary): MenuEntry[] => [
    { label: '复制译文', icon: <Copy />, disabled: !item.preview, onSelect: () => void c.read(item.id).then(record => copyText(record.result)).catch(c.report) },
    { label: '用此原文重译', icon: <PenLine />, disabled: running || busy, onSelect: () => void c.read(item.id).then(record => c.newTranslation(record.source)).catch(c.report) },
    { label: '翻译详情', icon: <Gauge />, onSelect: () => void c.read(item.id).then(onDetails).catch(c.report) },
    'separator',
    { label: '删除', icon: <Trash2 />, danger: true, disabled: busy || (running && item.id === currentId), onSelect: () => onDelete(item.id) },
  ];
  return <aside className="dqt-rail" data-overlay={overlay || undefined} data-leaving={leaving || undefined} inert={leaving} aria-label="翻译历史"
    onAnimationEnd={event => { if (leaving && event.target === event.currentTarget) onExited(); }}>
    <header className="dqt-rail-head"><h2>历史记录</h2>{history.total > 0 && <span className="dqt-count">{count(history.total)}</span>}
      <button type="button" className="dqt-icon-button" aria-label="收起历史记录" title="收起历史记录" onClick={onCollapse}><PanelLeftClose /></button></header>
    <div className="dqt-history" ref={list}>
      {groups.map(([label, items]) => <section key={label} aria-label={label}><h3>{label}</h3>
        {items.map(item => {
          const status = item.id === currentId && currentStatus ? currentStatus : item.status;
          const preview = status === 'completed' ? item.preview : status === 'running' ? '翻译中…' : `${STATUS[status]}${item.preview ? ` · ${item.preview}` : ''}`;
          return <button key={item.id} type="button" className="dqt-history-item" data-status={status} aria-current={item.id === viewingId ? 'true' : undefined}
            onClick={() => onPick(item.id)} onContextMenu={event => { event.preventDefault(); setMenu({ anchor: anchorAt(event), item }); }}>
            <span className="dqt-history-title">{item.title || '（空白原文）'}</span>
            <time dateTime={item.createdAt}>{timeOf(item.createdAt, today)}</time>
            <span className="dqt-history-preview">{status !== 'completed' && <i className="dqt-dot" />}<span>{preview}</span></span>
          </button>;
        })}
      </section>)}
      {loaded && !history.total && <div className="dqt-history-empty"><History /><p>还没有翻译记录</p><span>每次翻译都会自动保存在这里，随时回看、复制或重译。</span></div>}
      {history.next !== null && <div ref={sentinel} className="dqt-history-more" aria-hidden>{loadingMore && <LoaderCircle className="dqt-spin" />}</div>}
      {history.warnings.length > 0 && <p className="dqt-history-warning">{history.warnings.join(' ')}</p>}
    </div>
    {shownMenu.value && <Menu anchor={shownMenu.value.anchor} label="历史记录操作" entries={entries(shownMenu.value.item)} onClose={closeMenu} leaving={shownMenu.leaving} onExited={shownMenu.settle} />}
  </aside>;
});

/**
 * The history entry carries a label and the record count: an icon alone left most people unaware the history existed.
 * The count pulses when a run lands in the hidden list, tying the result to where it was kept.
 */
function HistoryButton({ total, onClick }: { total: number; onClick(): void }) {
  const badge = useRef<HTMLSpanElement>(null), seen = useRef(total);
  useEffect(() => {
    if (total > seen.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) badge.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.32)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
    seen.current = total;
  }, [total]);
  return <button type="button" className="dqt-button dqt-history-button" title="展开历史记录" onClick={onClick}>
    <History /><span>历史记录</span>{total > 0 && <span ref={badge} className="dqt-count">{count(total)}</span>}
  </button>;
}

const TopBar = memo(function TopBar({ c, viewing, current, railShown, total, running, busy, loaded, onToggleRail, onSettings, onDelete, onDetails }: {
  c: Controller; viewing: Translation | null; current: Translation | null; railShown: boolean; total: number; running: boolean; busy: boolean; loaded: boolean;
  onToggleRail(): void; onSettings(): void; onDelete(id: string): void; onDetails(record: Translation): void;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null), shownMenu = usePresence(menu);
  const closeMenu = useCallback(() => setMenu(null), []);
  const record = viewing ?? current;
  const entries: MenuEntry[] = record ? [
    { label: '翻译详情', icon: <Gauge />, onSelect: () => onDetails(record) },
    'separator',
    { label: '删除这条记录', icon: <Trash2 />, danger: true, disabled: busy || (running && record.id === current?.id), onSelect: () => onDelete(record.id) },
  ] : [];
  return <header className="dqt-bar" data-mode={viewing ? 'history' : undefined}>
    {!railShown && <HistoryButton total={total} onClick={onToggleRail} />}
    {viewing ? <>
      <button type="button" className="dqt-button dqt-back" title="返回当前翻译（Esc）" onClick={() => c.showCurrent()}><ArrowLeft /><span>返回</span></button>
      <div className="dqt-bar-title"><strong>{fullTime(viewing.createdAt)}</strong><span>{viewing.modelName}</span></div>
      {running && <button type="button" className="dqt-live" onClick={() => c.showCurrent()}><i className="dqt-dot" />翻译进行中</button>}
    </> : <div className="dqt-bar-title"><strong>快捷翻译</strong></div>}
    {record && <button type="button" className="dqt-icon-button" aria-label="更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={!!menu}
      onClick={event => setMenu(menu ? null : anchorFrom(event.currentTarget))}><MoreHorizontal /></button>}
    {!viewing && <button type="button" className="dqt-button" disabled={!loaded} onClick={onSettings}><Settings2 /><span>设置</span></button>}
    {shownMenu.value && record && <Menu anchor={shownMenu.value} label="记录操作" entries={entries} onClose={closeMenu} leaving={shownMenu.leaving} onExited={shownMenu.settle} />}
  </header>;
});

export function Page({ controller: c }: { controller: Controller }) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const layout = useLayout(root), wide = layout === 'wide';
  const [railPref, setRailPref] = useState(readRail), [railOverlay, setRailOverlay] = useState(false);
  const [sheet, setSheet] = useState(false), [modal, setModal] = useState<Modal>(null), [promptDraft, setPromptDraft] = useState<string | null>(null);
  useEffect(() => c.attach(), [c]);
  useEffect(() => { if (wide) setRailOverlay(false); }, [wide]);
  const railShown = wide ? railPref : railOverlay, rail = usePresence(railShown);
  // The rail column animates only after the first frame, so measuring the real width at startup does not slide the page.
  const [settled, setSettled] = useState(false);
  useEffect(() => { const frame = requestAnimationFrame(() => setSettled(true)); return () => cancelAnimationFrame(frame); }, []);
  const toggleRail = useCallback(() => {
    if (wide) setRailPref(shown => { saveRail(!shown); return !shown; }); else setRailOverlay(shown => !shown);
  }, [wide]);
  const showHistory = useCallback(() => { if (wide) { saveRail(true); setRailPref(true); } else setRailOverlay(true); }, [wide]);
  const pick = useCallback((id: string) => { void c.open(id).catch(c.report); setRailOverlay(false); }, [c]);
  const askDelete = useCallback((id: string) => setModal({ kind: 'delete', id }), []);
  const showDetails = useCallback((record: Translation) => setModal({ kind: 'details', record }), []);
  const openSettings = useCallback(() => setSheet(true), []);
  const closeModal = () => setModal(null);
  const viewing = s.selected, running = s.current?.status === 'running', busy = s.busy;
  const ready = !!s.settings?.model && s.models.some(m => m.provider === s.settings!.provider && m.id === s.settings!.model);
  const modified = !viewing && !!s.current && s.draft !== s.current.source;
  const canStart = !busy && !running && !viewing && !!s.draft.trim() && ready && !s.current?.saveError;
  // Docked, the rail's column animates its width (transitionend on the root); as a drawer, the rail animates itself.
  return <div ref={setRoot} className="dqt-root" data-layout={layout ?? undefined} data-rail={railShown ? 'shown' : 'hidden'} data-animate={settled || undefined}
    onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === 'grid-template-columns') rail.settle(); }}
    onKeyDown={event => { if (event.key === 'Escape' && viewing && !event.defaultPrevented && !(event.target as Element).closest('dialog')) c.showCurrent(); }}>
    <style>{css}</style>
    <LayerContext.Provider value={root}>
      {rail.value && <div className="dqt-rail-slot"><HistoryRail c={c} history={s.history} loaded={s.loaded} loadingMore={s.loadingMore} viewingId={viewing?.id} currentId={s.current?.id}
        currentStatus={s.current?.status} running={running} busy={busy} overlay={!wide} leaving={rail.leaving} onExited={rail.settle}
        onPick={pick} onCollapse={toggleRail} onDelete={askDelete} onDetails={showDetails} /></div>}
      {rail.value && !wide && <button type="button" className="dqt-scrim" data-leaving={rail.leaving || undefined} aria-label="关闭历史记录" onClick={() => setRailOverlay(false)} />}
      <main className="dqt-main">
        <TopBar c={c} viewing={viewing} current={s.current} railShown={railShown} total={s.history.total} running={running} busy={busy} loaded={s.loaded}
          onToggleRail={toggleRail} onSettings={openSettings} onDelete={askDelete} onDetails={showDetails} />
        {!s.loaded ? <div className="dqt-boot" role="status">{s.error ? <><CircleAlert /><p>{s.error}</p>
          <button type="button" className="dqt-button dqt-button-secondary" onClick={() => void c.reload().catch(c.report)}>重试</button></>
          : <><LoaderCircle className="dqt-spin" /><p>正在打开快捷翻译…</p></>}</div> : <>
          {s.error && <div className="dqt-banner" role="alert"><CircleAlert /><span>{s.error}</span>
            {running && !s.connected && <button type="button" className="dqt-button dqt-button-secondary" disabled={busy} onClick={() => void c.reload().catch(c.report)}>重新连接</button>}
            <button type="button" className="dqt-icon-button" aria-label="关闭错误提示" onClick={c.dismissError}><X /></button></div>}
          <div className="dqt-canvas">
            <div className="dqt-card" data-mode={viewing ? 'history' : undefined}>
              <SourcePane c={c} text={viewing ? viewing.source : s.draft} viewing={viewing} running={running} busy={busy} canStart={canStart}
                startLabel={s.current && !modified ? '重新翻译' : '翻译'} models={s.models} provider={s.settings?.provider ?? ''} model={s.settings?.model ?? ''}
                modelWarnings={s.modelWarnings} refreshingModels={s.refreshingModels} />
              <ResultPane c={c} record={viewing ?? s.current} historic={!!viewing} modified={modified} busy={busy} onDetails={showDetails} onShowHistory={railShown ? undefined : showHistory} />
            </div>
          </div>
        </>}
      </main>
      <Toast message={sheet ? '' : s.notice} onDismiss={c.dismissNotice} />
      {sheet && s.settings && <SettingsSheet c={c} settings={s.settings} defaultPrompt={s.defaultPrompt} total={s.history.total} running={running} busy={busy}
        draft={promptDraft} onDraft={setPromptDraft} onClose={() => setSheet(false)} onMigrate={() => setModal({ kind: 'migrate' })} onClear={() => setModal({ kind: 'clear' })} />}
      {modal?.kind === 'migrate' && s.settings && <MigrateDialog c={c} current={s.settings.directory} onClose={closeModal} onDone={() => { setModal(null); setSheet(false); }} />}
      {modal?.kind === 'clear' && <ConfirmDialog title="清空全部历史记录？" confirm="确认清空" onClose={closeModal}
        body={`将删除全部 ${s.history.total.toLocaleString()} 条翻译记录。提示词、模型和保存位置设置会保留。此操作无法撤销。`}
        onConfirm={async () => { await c.perform(() => c.clear(), true); setSheet(false); }} />}
      {modal?.kind === 'delete' && <ConfirmDialog title="删除这条记录？" confirm="确认删除" onClose={closeModal}
        body="将删除这条记录的原文、译文和翻译信息。此操作无法撤销。" onConfirm={() => c.perform(() => c.remove(modal.id), true)} />}
      {/* The current run stays live in its dialog: usage arrives with the final event. */}
      {modal?.kind === 'details' && <DetailsDialog record={s.current?.id === modal.record.id ? s.current : modal.record} onClose={closeModal} />}
    </LayerContext.Provider>
  </div>;
}
