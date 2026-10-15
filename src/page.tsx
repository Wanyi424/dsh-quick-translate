import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Check, Copy, FolderOpen, History, Languages, LoaderCircle, MoreHorizontal, PanelLeftClose, Plus, RefreshCw, Settings2, Square, Trash2, X } from 'lucide-react';
import { Controller } from './controller';
import { MAX_PROMPT, MAX_SOURCE, type Status } from './contracts';
import css from './styles.css';

const labels: Record<Status, string> = { running: '翻译中', completed: '已完成', stopped: '已停止', failed: '未完成', interrupted: '已中断' };
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function Dialog({ title, children, onClose, busy = false }: { title: string; children: React.ReactNode; onClose(): void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="dqt-dialog" aria-label={title} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>{title}</h2><button aria-label="关闭对话框" disabled={busy} onClick={onClose}><X /></button></header>{children}
  </dialog>;
}
export function Page({ controller: c }: { controller: Controller }) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot), [rail, setRail] = useState(() => window.innerWidth > 900);
  const [modal, setModal] = useState<'settings' | 'directory' | 'prompt' | 'delete' | 'clear' | null>(null);
  const [prompt, setPrompt] = useState(''), [directory, setDirectory] = useState(''), [localError, setLocalError] = useState('');
  const [copied, setCopied] = useState(false), [picking, setPicking] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null), output = useRef<HTMLDivElement>(null), sticky = useRef(true), copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const record = s.selected ?? s.current, running = c.running, historic = !!s.selected, busy = s.busy || picking;
  const modified = !historic && !!s.current && s.draft !== s.current.source;
  useEffect(() => c.attach(), [c]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => { if (!historic && sticky.current && output.current) output.current.scrollTop = output.current.scrollHeight; }, [record?.result, historic]);
  useEffect(() => { sticky.current = true; if (output.current) output.current.scrollTop = 0; }, [record?.id]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current) menu.current.open = false; };
    document.addEventListener('click', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', escape); };
  }, []);
  const run = (action: () => Promise<unknown>) => { void c.perform(action).catch(() => {}); };
  const openModal = (next: typeof modal) => {
    setLocalError(''); setPrompt(s.settings?.prompt ?? ''); setDirectory(s.settings?.directory ?? ''); setModal(next); if (menu.current) menu.current.open = false;
  };
  const submitDialog = async (fn: () => Promise<unknown>) => {
    setLocalError(''); try { await c.perform(fn); setModal(null); } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };
  const copy = async () => {
    if (!record?.result) return;
    try {
      try { await navigator.clipboard.writeText(record.result); } catch {
        const textarea = document.createElement('textarea'); textarea.className = 'dqt-copy-buffer'; textarea.value = record.result;
        output.current!.append(textarea); textarea.select(); const ok = document.execCommand('copy'); textarea.remove(); if (!ok) throw new Error('复制失败，请选择译文后手动复制。');
      }
      setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch (error) { c.report(error); }
  };
  const chooseDirectory = async () => {
    setPicking(true); setLocalError('');
    try { const path = await window.__DSH_DIRECTORY_PICKER__!.pick(); if (path) setDirectory(path); }
    catch { setLocalError('未能打开目录选择器，可直接填写完整路径。'); } finally { setPicking(false); }
  };
  return <div className={`dqt-root ${rail ? '' : 'dqt-hide-rail'}`}>
    <style>{css}</style>
    {rail && <aside className="dqt-rail" aria-label="翻译历史">
      <div className="dqt-rail-top"><span><History />历史记录</span><button aria-label="收起历史记录" onClick={() => setRail(false)}><PanelLeftClose /></button></div>
      <button className="dqt-new" disabled={busy || running || !!s.current?.saveError} onClick={() => c.newTranslation()}><Plus />新建翻译</button>
      <nav className="dqt-history" aria-label="历史记录列表">
        {s.history.items.map(item => <button key={item.id} className={`dqt-history-item ${record?.id === item.id ? 'dqt-selected' : ''}`} aria-current={record?.id === item.id ? 'page' : undefined} disabled={busy} onClick={() => run(async () => { await c.open(item.id); if (window.innerWidth <= 900) setRail(false); })}>
          <span className="dqt-history-title">{item.title}</span><span className="dqt-history-meta"><time>{date(item.createdAt)}</time><span>{item.id === s.current?.id ? labels[s.current.status] : labels[item.status]}</span></span>
        </button>)}
        {s.loaded && !s.history.total && <p className="dqt-history-empty">还没有翻译记录<br />翻译后会自动保存在这里。</p>}
        {s.history.next !== null && <button className="dqt-load-more" disabled={busy} onClick={() => run(() => c.history(true))}>加载更多</button>}
        {s.history.warnings.length > 0 && <p className="dqt-muted">{s.history.warnings.join(' ')}</p>}
      </nav>
      <footer className="dqt-rail-bottom"><span>{s.history.total} 条记录</span><button aria-label="刷新历史记录" disabled={busy} onClick={() => run(() => c.history())}><RefreshCw /></button><button aria-label="清空历史记录" disabled={busy || running || !s.history.total} onClick={() => openModal('clear')}><Trash2 /></button></footer>
    </aside>}
    <main className="dqt-main">
      <header className="dqt-header">
        {!rail && <button aria-label="展开历史记录" onClick={() => setRail(true)}><History /></button>}
        <div className="dqt-heading"><h1>快捷翻译</h1><p>中英文翻译，由你的提示词决定。</p></div>
        <button disabled={!s.loaded || busy} onClick={() => openModal('settings')}><Settings2 /><span>翻译设置</span></button>
        <details ref={menu} className="dqt-more"><summary aria-label="更多操作"><MoreHorizontal /></summary><div className="dqt-menu">
          <button onClick={() => { menu.current!.open = false; run(() => c.openDirectory()); }} disabled={!s.loaded || busy}><FolderOpen />在资源管理器打开</button>
          <button onClick={() => openModal('directory')} disabled={!s.loaded || busy || running}><FolderOpen />历史记录保存位置</button>
          {record && <><hr /><button onClick={() => openModal('prompt')}>查看本次提示词</button><button className="dqt-danger" disabled={busy || (running && record.id === s.current?.id)} onClick={() => openModal('delete')}><Trash2 />删除这条记录</button></>}
        </div></details>
      </header>
      {s.error && <div className="dqt-alert" role="alert"><span>{s.error}</span><button onClick={c.dismissError.bind(c)} aria-label="关闭错误提示"><X /></button></div>}
      {s.notice && <div className="dqt-notice" role="status"><span>{s.notice}</span><button onClick={c.dismissNotice.bind(c)} aria-label="关闭提示"><X /></button></div>}
      {!s.loaded ? <div className="dqt-loading"><LoaderCircle />正在读取翻译设置…{s.error && <button onClick={() => run(() => c.reload())}>重试</button>}</div> : <>
        <div className="dqt-controls">
          {historic ? <><span className="dqt-record-label">{date(record!.createdAt)} · {record!.modelName}</span><button disabled={busy || running} onClick={() => c.newTranslation(record!.source)}>用原文新建<ArrowRight /></button></> : <>
            <label className="dqt-model"><span>翻译模型</span><select aria-label="翻译模型" value={s.settings ? JSON.stringify([s.settings.provider, s.settings.model]) : ''} disabled={busy || running} onChange={event => { const [provider, model] = JSON.parse(event.target.value); run(() => c.saveSettings({ provider, model })); }}>
              <option value={JSON.stringify(['', ''])} disabled>选择 DSH 模型</option>
              {s.settings?.model && !s.models.some(m => m.provider === s.settings!.provider && m.id === s.settings!.model) && <option value={JSON.stringify([s.settings.provider, s.settings.model])} disabled>{s.settings.model}（不可用）</option>}
              {s.models.map(m => <option key={JSON.stringify([m.provider, m.id])} value={JSON.stringify([m.provider, m.id])}>{m.name} · {m.providerName}</option>)}
            </select></label>
            <button aria-label="刷新模型列表" title="在 DSH 设置中修改模型后，点击刷新" disabled={busy || running} onClick={() => run(() => c.refreshModels())}><RefreshCw /></button>
            <span className="dqt-controls-hint">{s.models.length ? '使用 DSH 已配置的模型' : '请先在 DSH 设置中配置模型，然后刷新'}</span>
          </>}
        </div>
        {s.modelWarnings.length > 0 && <div className="dqt-inline-warning">{s.modelWarnings.join(' ')}</div>}
        {running && (historic || !s.connected) && <div className="dqt-notice"><span>当前翻译正在后台进行。</span><button onClick={() => c.showCurrent()}>返回当前翻译</button>{!s.connected && <button disabled={busy} onClick={() => run(() => c.reload())}>重新连接</button>}<button disabled={busy} onClick={() => run(() => c.stop())}>停止</button></div>}
        <div className="dqt-workspace">
          <section className="dqt-pane dqt-source">
            <div className="dqt-pane-heading"><h2>原文</h2><span>{(historic ? record!.source : s.draft).length.toLocaleString()} / {MAX_SOURCE.toLocaleString()}</span>{!historic && <button disabled={busy || running || !s.draft} onClick={() => c.setDraft('')}>清空</button>}</div>
            <textarea aria-label="待翻译原文" spellCheck={false} maxLength={MAX_SOURCE} readOnly={historic || running || busy} value={historic ? record!.source : s.draft} onChange={event => c.setDraft(event.target.value)} placeholder={'输入或粘贴需要翻译的内容…\n\n支持中文与英文，保留段落和原文格式。'} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy && !running && !historic && s.draft.trim() && s.settings?.model) { event.preventDefault(); run(() => c.start()); } }} />
            <footer className="dqt-source-footer" data-history={historic}><span>{historic ? '历史原文 · 只读' : 'Ctrl + Enter 翻译'}</span>{!historic && (running ? <button className="dqt-stop" disabled={busy} onClick={() => run(() => c.stop())}><Square />停止翻译</button> : <button className="dqt-primary" disabled={busy || !s.draft.trim() || !s.settings?.model || !!s.current?.saveError} onClick={() => run(() => c.start())}>{busy ? <LoaderCircle className="dqt-spin" /> : <Languages />}{s.current ? '重新翻译' : '开始翻译'}</button>)}</footer>
          </section>
          <section className="dqt-pane dqt-result">
            <div className="dqt-pane-heading"><h2>译文</h2><span role="status">{record ? record.status === 'running' ? <><i className="dqt-pulse" />{record.phase === 'thinking' ? '模型正在思考…' : record.phase === 'translating' ? '正在翻译…' : '正在连接模型…'}</> : labels[record.status] : ''}</span><button onClick={() => void copy()} disabled={!record?.result} aria-label="复制译文">{copied ? <Check /> : <Copy />}{copied ? '已复制' : '复制'}</button></div>
            {modified && <div className="dqt-inline-warning">原文已修改，下面仍是上一次译文。</div>}
            {record?.error && <div className="dqt-inline-warning" role="status">{record.error}</div>}
            {record?.saveError && <div className="dqt-alert" role="alert"><span>{record.saveError}</span><button disabled={busy} onClick={() => run(() => c.retrySave())}>重试保存</button></div>}
            <div ref={output} className="dqt-output" tabIndex={0} aria-label="译文内容" onScroll={() => { const el = output.current!; sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>
              {record?.result ? <div className="dqt-translated">{record.result}</div> : <div className="dqt-empty"><Languages /><h3>{record?.status === 'running' ? '译文即将显示在这里' : '让表达跨越语言'}</h3><p>{record?.status === 'running' ? '收到模型输出后逐步显示。你可以切换页面，稍后回来查看。' : record ? '这次翻译还没有产生译文。可使用原文重新翻译。' : '在左侧输入原文，选择模型后开始翻译。'}</p></div>}
            </div>
            <footer className="dqt-result-footer"><span>{record?.status === 'running' ? '切换页面后继续翻译' : record && !record.saveError ? '已保存到本地历史记录' : '译文自动保存到本地'}</span><span>{record?.result.length.toLocaleString() ?? 0} 字符</span></footer>
          </section>
        </div>
        <footer className="dqt-storage"><FolderOpen /><span title={s.settings?.directory}>历史记录：{s.settings?.directory}</span><button disabled={busy || running} onClick={() => openModal('directory')}>更改位置</button></footer>
      </>}
    </main>
    {modal && <Dialog title={modal === 'settings' ? '翻译设置' : modal === 'directory' ? '历史记录保存位置' : modal === 'prompt' ? '本次翻译使用的提示词' : modal === 'delete' ? '删除这条记录？' : '清空所有历史记录？'} busy={busy} onClose={() => setModal(null)}>
      {modal === 'settings' && <>
        <p className="dqt-muted">当前使用：{s.settings?.promptMode === 'custom' ? '自定义提示词' : '默认提示词'}。修改并保存会写入独立的 custom.md，默认文件保持不变。每次翻译独立发送，不携带上一条译文。</p>
        {s.settings?.promptError && <p className="dqt-dialog-error" role="alert">{s.settings.promptError}</p>}
        <label className="dqt-field">翻译提示词<textarea autoFocus aria-label="翻译提示词" disabled={busy} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={MAX_PROMPT} rows={8} /></label>
        <div className="dqt-form-note"><span>{prompt.length.toLocaleString()} / {MAX_PROMPT.toLocaleString()}</span><button onClick={() => run(async () => { const saved = await c.switchPrompt('default'); setPrompt(saved.prompt); })} disabled={busy}>恢复默认提示词</button></div>
        <div className="dqt-prompt-files">
          <span>默认提示词文件（随插件提供）</span><code>{s.settings?.defaultPromptFile}</code>
          <span>自定义提示词文件{s.settings?.hasCustomPrompt ? '' : '（首次保存时创建）'}</span><code>{s.settings?.customPromptFile}</code>
          <div><button disabled={busy} onClick={() => run(() => c.openPrompts())}><FolderOpen />打开自定义提示词目录</button>{s.settings?.hasCustomPrompt && <button disabled={busy} onClick={() => run(async () => { const saved = await c.switchPrompt('custom'); setPrompt(saved.prompt); })}>使用已保存的自定义</button>}</div>
          <span>恢复默认后立即生效，自定义文件仍保留。修改仅用于后续翻译。</span>
        </div>
        <div className="dqt-storage-setting"><span>历史记录保存在</span><code>{s.settings?.directory}</code><button onClick={() => openModal('directory')} disabled={busy || running || prompt !== s.settings?.prompt}>更改位置并迁移</button>{prompt !== s.settings?.prompt && <span>请先保存提示词，再更改历史记录位置。</span>}</div>
        <footer><button disabled={busy} onClick={() => setModal(null)}>关闭</button><button className="dqt-primary" disabled={busy || !prompt.trim() || prompt === s.settings?.prompt} onClick={() => void submitDialog(() => c.saveSettings({ prompt }))}>{busy ? '保存中…' : '保存自定义提示词'}</button></footer>
      </>}
      {modal === 'directory' && <>
        <p className="dqt-muted">迁移全部翻译历史，完成后自动使用新位置。旧目录为空时删除；其他文件或子文件夹会保留。</p>
        <label className="dqt-field">当前目录<code>{s.settings?.directory}</code></label>
        <label className="dqt-field">新目录<input autoFocus aria-label="新历史记录目录" value={directory} onChange={e => setDirectory(e.target.value)} disabled={busy} placeholder="例如 D:\Documents\DSH Translations" /></label>
        {window.__DSH_DIRECTORY_PICKER__ && <button disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen />选择文件夹</button>}
        <p className="dqt-muted">建议使用专门的空文件夹。同名记录会阻止迁移，不会覆盖。</p>
        <footer><button disabled={busy} onClick={() => setModal(null)}>取消</button><button className="dqt-primary" disabled={busy || running || !directory.trim() || directory === s.settings?.directory} onClick={() => void submitDialog(() => c.migrate(directory))}>{busy ? '迁移中…' : '迁移并使用'}</button></footer>
      </>}
      {modal === 'prompt' && <><p className="dqt-muted">{record?.modelName} · {record && date(record.createdAt)}</p><pre className="dqt-prompt-snapshot">{record?.prompt}</pre><footer><button onClick={() => setModal(null)}>关闭</button></footer></>}
      {(modal === 'delete' || modal === 'clear') && <>
        <p>{modal === 'delete' ? '将删除这条记录的原文、译文及翻译信息。此操作无法撤销。' : `将删除全部 ${s.history.total} 条翻译记录。提示词、模型和保存位置设置会保留。此操作无法撤销。`}</p>
        <footer><button autoFocus disabled={busy} onClick={() => setModal(null)}>取消</button><button className="dqt-danger-button" disabled={busy || (modal === 'clear' && running)} onClick={() => void submitDialog(() => modal === 'delete' ? c.remove(record!.id) : c.clear())}>{busy ? '删除中…' : modal === 'delete' ? '确认删除' : '确认清空'}</button></footer>
      </>}
      {localError && <p className="dqt-dialog-error" role="alert">{localError}</p>}
    </Dialog>}
  </div>;
}
