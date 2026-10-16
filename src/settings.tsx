import React, { useEffect, useId, useRef, useState } from 'react';
import { Copy, FolderOpen, LoaderCircle, Trash2 } from 'lucide-react';
import type { Controller } from './controller';
import { MAX_PROMPT, type Settings, type Translation } from './contracts';
import { fullTime } from './format';
import { Dialog, Segmented, copyText } from './ui';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function FileRow({ label, path, note, action }: { label: string; path: string; note?: string; action?: React.ReactNode }) {
  return <div className="dqt-file"><span>{label}{note && <em>{note}</em>}</span><code className="dqt-path" title={path}>{path}</code>{action}</div>;
}

/**
 * Prompt source is a two-state choice. An unsaved custom draft lives in the page (draft), so closing the
 * panel never silently loses edits; it is only written when the user saves.
 */
export function SettingsSheet({ c, settings, defaultPrompt, total, running, busy, draft, onDraft, onClose, onMigrate, onClear }: {
  c: Controller; settings: Settings; defaultPrompt: string; total: number; running: boolean; busy: boolean;
  draft: string | null; onDraft(value: string | null): void; onClose(): void; onMigrate(): void; onClear(): void;
}) {
  const [creating, setCreating] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const custom = settings.promptMode === 'custom' || creating || (draft !== null && !settings.hasCustomPrompt);
  const savedText = settings.promptMode === 'custom' ? settings.prompt : '';
  const value = draft ?? (settings.promptMode === 'custom' ? settings.prompt : defaultPrompt);
  const dirty = draft !== null && draft !== savedText;
  const canSave = dirty && !!value.trim() && value.length <= MAX_PROMPT;
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await c.perform(fn, true); return true; } catch (reason) { setError(message(reason)); return false; }
  };
  const choose = (mode: 'default' | 'custom') => {
    if (mode === 'default') { setCreating(false); if (!settings.hasCustomPrompt) onDraft(null); if (settings.promptMode === 'custom') void run(() => c.switchPrompt('default')); }
    else if (settings.hasCustomPrompt) void run(() => c.switchPrompt('custom'));
    else setCreating(true);
  };
  const save = async () => {
    if (!await run(() => c.saveSettings({ prompt: value }))) return;
    onDraft(null); setCreating(false); setSaved(true); clearTimeout(timer.current); timer.current = setTimeout(() => setSaved(false), 1600);
  };
  const discard = () => { onDraft(null); if (!settings.hasCustomPrompt) setCreating(false); };
  return <Dialog title="翻译设置" className="dqt-sheet" onClose={onClose} busy={busy}>
    <section className="dqt-section">
      <div className="dqt-section-head"><h3>提示词</h3>
        <Segmented label="提示词来源" value={custom ? 'custom' : 'default'} onChange={choose} disabled={busy}
          options={[{ value: 'default', label: '默认' }, { value: 'custom', label: '自定义' }]} /></div>
      <p className="dqt-hint">翻译方向、语气和格式都由提示词决定。修改只影响之后发起的翻译，每次翻译独立发送，不携带上一条译文。</p>
      {settings.promptError && <div className="dqt-inline" data-tone="danger" role="alert"><span>{settings.promptError}</span></div>}
      {custom ? <>
        <textarea className="dqt-prompt-editor" aria-label="翻译提示词" spellCheck={false} value={value} maxLength={MAX_PROMPT} disabled={busy}
          onChange={event => onDraft(event.target.value)} />
        <div className="dqt-row dqt-row-split">
          <span className="dqt-hint">{value.length.toLocaleString()} / {MAX_PROMPT.toLocaleString()}{dirty && <strong> · 未保存</strong>}</span>
          <div className="dqt-row">
            {draft !== null && <button type="button" className="dqt-button" disabled={busy} onClick={discard}>放弃修改</button>}
            <button type="button" className="dqt-button dqt-button-primary" disabled={busy || !canSave} onClick={() => void save()}>{saved ? '已保存' : '保存'}</button>
          </div>
        </div>
        <FileRow label="自定义文件" note={settings.hasCustomPrompt ? undefined : '首次保存时创建'} path={settings.customPromptFile}
          action={<button type="button" className="dqt-link" disabled={busy} onClick={() => void run(() => c.openPrompts())}><FolderOpen />打开文件夹</button>} />
      </> : <>
        <div className="dqt-prompt-view" tabIndex={0} aria-label="默认提示词内容">{defaultPrompt}</div>
        <FileRow label="默认文件" note="随插件提供，不会被修改" path={settings.defaultPromptFile} />
      </>}
    </section>
    <section className="dqt-section">
      <div className="dqt-section-head"><h3>历史记录</h3><span className="dqt-hint">{total.toLocaleString()} 条</span></div>
      <FileRow label="保存位置" path={settings.directory} />
      <div className="dqt-row">
        <button type="button" className="dqt-button dqt-button-secondary" disabled={busy} onClick={() => void run(() => c.openDirectory())}><FolderOpen />打开文件夹</button>
        <button type="button" className="dqt-button dqt-button-secondary" disabled={busy || running} onClick={onMigrate}>更改位置…</button>
        <button type="button" className="dqt-button dqt-button-quiet-danger" disabled={busy || running || !total} onClick={onClear}><Trash2 />清空全部…</button>
      </div>
      {running && <p className="dqt-hint">翻译进行中。完成或停止后，才能更改位置或清空记录。</p>}
    </section>
    {error && <p className="dqt-dialog-error" role="alert">{error}</p>}
  </Dialog>;
}

export function MigrateDialog({ c, current, onClose, onDone }: { c: Controller; current: string; onClose(): void; onDone(): void }) {
  const [value, setValue] = useState(current), [error, setError] = useState(''), [working, setWorking] = useState(false), [picking, setPicking] = useState(false);
  const id = useId(), busy = working || picking, target = value.trim(), ready = !!target && target !== current;
  const submit = async () => {
    if (!ready || busy) return;
    setError(''); setWorking(true);
    try { await c.perform(() => c.migrate(target), true); onDone(); } catch (reason) { setError(message(reason)); } finally { setWorking(false); }
  };
  const pick = async () => {
    setPicking(true); setError('');
    try { const path = await window.__DSH_DIRECTORY_PICKER__!.pick(); if (path) setValue(path); }
    catch { setError('未能打开目录选择器，可以直接填写完整路径。'); } finally { setPicking(false); }
  };
  return <Dialog title="更改历史记录位置" onClose={onClose} busy={busy} footer={<>
    <button type="button" className="dqt-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="button" className="dqt-button dqt-button-primary" disabled={busy || !ready} onClick={() => void submit()}>{working ? <><LoaderCircle className="dqt-spin" />正在迁移…</> : '迁移并使用'}</button>
  </>}>
    <p className="dqt-dialog-text">把全部翻译记录复制到新位置，确认完整后再清理旧副本。旧目录为空时删除；其中的其他文件和子文件夹保持原样。</p>
    <div className="dqt-field"><span>当前位置</span><code className="dqt-path">{current}</code></div>
    <div className="dqt-field"><label htmlFor={id}>新位置</label><div className="dqt-input-row">
      <input id={id} className="dqt-input" data-autofocus aria-label="新历史记录目录" value={value} disabled={busy} placeholder="例如 D:\Documents\DSH Translations"
        onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} />
      {window.__DSH_DIRECTORY_PICKER__ && <button type="button" className="dqt-button dqt-button-secondary" disabled={busy} onClick={() => void pick()}><FolderOpen />选择…</button>}
    </div></div>
    <p className="dqt-hint">建议使用专门的空文件夹。目标中已有同名记录时会停止迁移，不会覆盖任何文件。</p>
    {error && <p className="dqt-dialog-error" role="alert">{error}</p>}
  </Dialog>;
}

export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: {
  title: string; body: string; confirm: string; onConfirm(): Promise<unknown>; onClose(): void;
}) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const submit = async () => {
    setWorking(true); setError('');
    try { await onConfirm(); onClose(); } catch (reason) { setError(message(reason)); setWorking(false); }
  };
  return <Dialog title={title} onClose={onClose} busy={working} footer={<>
    <button type="button" className="dqt-button" data-autofocus disabled={working} onClick={onClose}>取消</button>
    <button type="button" className="dqt-button dqt-button-danger" disabled={working} onClick={() => void submit()}>{working ? '正在处理…' : confirm}</button>
  </>}>
    <p className="dqt-dialog-text">{body}</p>
    {error && <p className="dqt-dialog-error" role="alert">{error}</p>}
  </Dialog>;
}

export function PromptDialog({ record, onClose }: { record: Translation; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  return <Dialog title="本次翻译使用的提示词" className="dqt-dialog-wide" onClose={onClose} footer={<>
    <button type="button" className="dqt-button dqt-button-secondary" onClick={() => void copyText(record.prompt).then(() => setCopied(true), () => {})}><Copy />{copied ? '已复制' : '复制'}</button>
    <button type="button" className="dqt-button dqt-button-primary" data-autofocus onClick={onClose}>关闭</button>
  </>}>
    <p className="dqt-hint">{record.modelName} · {fullTime(record.createdAt)}。之后修改提示词不会改变这条记录。</p>
    <pre className="dqt-prompt-view dqt-prompt-snapshot">{record.prompt}</pre>
  </Dialog>;
}
