import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, CircleAlert, Copy, History, LoaderCircle, MoreHorizontal, PanelLeftClose, PenLine, ScrollText, Settings2, Trash2, X } from 'lucide-react';
import type { Controller } from './controller';
import type { HistoryPage, Status, Summary, Translation } from './contracts';
import { STATUS, fullTime, groupOf, startOfDay, timeOf } from './format';
import { LayerContext, Menu, Toast, anchorAt, anchorFrom, copyText, type MenuAnchor, type MenuEntry } from './ui';
import { ResultPane, SourcePane } from './workspace';
import { ConfirmDialog, MigrateDialog, PromptDialog, SettingsSheet } from './settings';
import css from './styles.css';

type Layout = 'wide' | 'medium' | 'narrow';
type Modal = { kind: 'migrate' } | { kind: 'clear' } | { kind: 'delete'; id: string } | { kind: 'prompt'; record: Translation } | null;
const RAIL_KEY = 'dsh-quick-translate:history-rail';
function readRail() { try { return localStorage.getItem(RAIL_KEY) !== 'hidden'; } catch { return true; } }
function saveRail(shown: boolean) { try { localStorage.setItem(RAIL_KEY, shown ? 'shown' : 'hidden'); } catch { /* Preference only. */ } }

/** Plugin width, not window width: the host sidebar and window size both change the space available. */
function useLayout(element: HTMLElement | null): Layout {
  const [layout, setLayout] = useState<Layout>('wide');
  useLayoutEffect(() => {
    if (!element) return;
    const measure = (width: number) => setLayout(width >= 1040 ? 'wide' : width >= 720 ? 'medium' : 'narrow');
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element); return () => observer.disconnect();
  }, [element]);
  return layout;
}

const HistoryRail = memo(function HistoryRail({ c, history, loaded, loadingMore, viewingId, currentId, currentStatus, running, busy, overlay, onPick, onCollapse, onDelete }: {
  c: Controller; history: HistoryPage; loaded: boolean; loadingMore: boolean; viewingId?: string; currentId?: string; currentStatus?: Status;
  running: boolean; busy: boolean; overlay: boolean; onPick(id: string): void; onCollapse(): void; onDelete(id: string): void;
}) {
  const list = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; item: Summary } | null>(null);
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
    'separator',
    { label: '删除', icon: <Trash2 />, danger: true, disabled: busy || (running && item.id === currentId), onSelect: () => onDelete(item.id) },
  ];
  return <aside className="dqt-rail" data-overlay={overlay || undefined} aria-label="翻译历史">
    <header className="dqt-rail-head"><h2>历史记录</h2>{history.total > 0 && <span className="dqt-count">{history.total.toLocaleString()}</span>}
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
    {menu && <Menu anchor={menu.anchor} label="历史记录操作" entries={entries(menu.item)} onClose={closeMenu} />}
  </aside>;
});

const TopBar = memo(function TopBar({ c, viewing, current, railShown, running, busy, loaded, onToggleRail, onSettings, onDelete, onPrompt }: {
  c: Controller; viewing: Translation | null; current: Translation | null; railShown: boolean; running: boolean; busy: boolean; loaded: boolean;
  onToggleRail(): void; onSettings(): void; onDelete(id: string): void; onPrompt(record: Translation): void;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const record = viewing ?? current;
  const entries: MenuEntry[] = record ? [
    { label: '查看本次提示词', icon: <ScrollText />, onSelect: () => onPrompt(record) },
    'separator',
    { label: '删除这条记录', icon: <Trash2 />, danger: true, disabled: busy || (running && record.id === current?.id), onSelect: () => onDelete(record.id) },
  ] : [];
  return <header className="dqt-bar" data-mode={viewing ? 'history' : undefined}>
    {!railShown && <button type="button" className="dqt-icon-button" aria-label="展开历史记录" title="历史记录" onClick={onToggleRail}><History /></button>}
    {viewing ? <>
      <button type="button" className="dqt-button dqt-back" title="返回当前翻译（Esc）" onClick={() => c.showCurrent()}><ArrowLeft /><span>返回</span></button>
      <div className="dqt-bar-title"><strong>历史记录</strong><span>{fullTime(viewing.createdAt)} · {viewing.modelName}</span></div>
      {running && <button type="button" className="dqt-live" onClick={() => c.showCurrent()}><i className="dqt-dot" />翻译进行中</button>}
    </> : <div className="dqt-bar-title"><strong>快捷翻译</strong></div>}
    {record && <button type="button" className="dqt-icon-button" aria-label="更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={!!menu}
      onClick={event => setMenu(menu ? null : anchorFrom(event.currentTarget))}><MoreHorizontal /></button>}
    {!viewing && <button type="button" className="dqt-button" disabled={!loaded} onClick={onSettings}><Settings2 /><span>设置</span></button>}
    {menu && record && <Menu anchor={menu} label="记录操作" entries={entries} onClose={closeMenu} />}
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
  const railShown = wide ? railPref : railOverlay;
  const toggleRail = useCallback(() => {
    if (wide) setRailPref(shown => { saveRail(!shown); return !shown; }); else setRailOverlay(shown => !shown);
  }, [wide]);
  const pick = useCallback((id: string) => { void c.open(id).catch(c.report); setRailOverlay(false); }, [c]);
  const askDelete = useCallback((id: string) => setModal({ kind: 'delete', id }), []);
  const showPrompt = useCallback((record: Translation) => setModal({ kind: 'prompt', record }), []);
  const openSettings = useCallback(() => setSheet(true), []);
  const closeModal = () => setModal(null);
  const viewing = s.selected, running = s.current?.status === 'running', busy = s.busy;
  const ready = !!s.settings?.model && s.models.some(m => m.provider === s.settings!.provider && m.id === s.settings!.model);
  const modified = !viewing && !!s.current && s.draft !== s.current.source;
  const canStart = !busy && !running && !viewing && !!s.draft.trim() && ready && !s.current?.saveError;
  return <div ref={setRoot} className="dqt-root" data-layout={layout} data-rail={railShown ? 'shown' : 'hidden'}
    onKeyDown={event => { if (event.key === 'Escape' && viewing && !event.defaultPrevented && !(event.target as Element).closest('dialog')) c.showCurrent(); }}>
    <style>{css}</style>
    <LayerContext.Provider value={root}>
      {railShown && <HistoryRail c={c} history={s.history} loaded={s.loaded} loadingMore={s.loadingMore} viewingId={viewing?.id} currentId={s.current?.id}
        currentStatus={s.current?.status} running={running} busy={busy} overlay={!wide} onPick={pick} onCollapse={toggleRail} onDelete={askDelete} />}
      {railShown && !wide && <button type="button" className="dqt-scrim" aria-label="关闭历史记录" onClick={() => setRailOverlay(false)} />}
      <main className="dqt-main">
        <TopBar c={c} viewing={viewing} current={s.current} railShown={railShown} running={running} busy={busy} loaded={s.loaded}
          onToggleRail={toggleRail} onSettings={openSettings} onDelete={askDelete} onPrompt={showPrompt} />
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
              <ResultPane c={c} record={viewing ?? s.current} historic={!!viewing} modified={modified} busy={busy} />
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
      {modal?.kind === 'prompt' && <PromptDialog record={modal.record} onClose={closeModal} />}
    </LayerContext.Provider>
  </div>;
}
