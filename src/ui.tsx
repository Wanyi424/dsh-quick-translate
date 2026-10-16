import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleCheck, X } from 'lucide-react';

/** Menus are portaled into the plugin root, so they are positioned and clamped against the plugin, not the host. */
export const LayerContext = createContext<HTMLElement | null>(null);

export type MenuEntry = 'separator' | { group: string } | { label: string; icon?: React.ReactNode; onSelect(): void; danger?: boolean; disabled?: boolean; checked?: boolean };
export interface MenuAnchor { x: number; y: number; width: number; height: number; align: 'start' | 'end'; trigger: HTMLElement | null }
export const anchorFrom = (element: HTMLElement, align: MenuAnchor['align'] = 'end'): MenuAnchor => {
  const r = element.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, align, trigger: element };
};
export const anchorAt = (event: React.MouseEvent): MenuAnchor => ({ x: event.clientX, y: event.clientY, width: 0, height: 0, align: 'start', trigger: event.currentTarget as HTMLElement });

const HIDDEN: React.CSSProperties = { visibility: 'hidden' };
export function Menu({ anchor, entries, label, onClose, footer, className = '' }: {
  anchor: MenuAnchor; entries: MenuEntry[]; label: string; onClose(): void; footer?: React.ReactNode; className?: string;
}) {
  const layer = useContext(LayerContext), ref = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { onClose(); if (restore) anchor.trigger?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    const menu = ref.current; if (!menu || !layer) return;
    const bounds = layer.getBoundingClientRect(), own = menu.getBoundingClientRect(), gap = 6, edge = 8;
    const below = anchor.y + anchor.height + gap, fits = below + own.height <= bounds.bottom - edge;
    const top = fits || anchor.y - gap - own.height < bounds.top + edge ? below : anchor.y - gap - own.height;
    const left = anchor.align === 'end' ? anchor.x + anchor.width - own.width : anchor.x;
    // Placed directly before paint; the item can only take focus once the menu is visible.
    Object.assign(menu.style, {
      left: `${Math.max(edge, Math.min(left - bounds.left, bounds.width - own.width - edge))}px`,
      top: `${Math.max(edge, Math.min(top - bounds.top, bounds.height - own.height - edge))}px`,
      transformOrigin: `${anchor.align === 'end' ? 'right' : 'left'} ${fits ? 'top' : 'bottom'}`, visibility: 'visible',
    });
    menu.querySelector<HTMLButtonElement>('[role^=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor, layer]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!ref.current?.contains(target) && !anchor.trigger?.contains(target)) onClose(); };
    const dismiss = () => onClose();
    const scrolled = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    layer?.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); layer?.removeEventListener('scroll', scrolled, true); };
  }, [anchor, layer, onClose]);
  if (!layer) return null;
  return createPortal(<div ref={ref} className={`dqt-menu ${className}`} role="menu" aria-label={label} style={HIDDEN} onKeyDown={event => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => { event.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') focus(index + 1);
    else if (event.key === 'ArrowUp') focus(index - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close(false);
  }}>
    {entries.map((entry, i) => entry === 'separator' ? <hr key={i} /> : 'group' in entry ? <div key={i} className="dqt-menu-group" role="presentation">{entry.group}</div> :
      <button key={i} type="button" role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={entry.checked} className={entry.danger ? 'dqt-danger' : undefined}
        disabled={entry.disabled} onClick={() => { close(); entry.onSelect(); }}>
        {entry.icon}<span>{entry.label}</span>{entry.checked && <Check className="dqt-menu-check" />}
      </button>)}
    {footer}
  </div>, layer);
}

/** Native modal dialog: focus trap, Esc and top layer come from the browser. */
export function Dialog({ title, onClose, busy = false, className = '', children, footer }: {
  title: string; onClose(): void; busy?: boolean; className?: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`dqt-dialog ${className}`} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <header><h2 id={id}>{title}</h2><button type="button" className="dqt-icon-button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X /></button></header>
    <div className="dqt-dialog-body">{children}</div>
    {footer && <footer>{footer}</footer>}
  </dialog>;
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled = false }: {
  value: T; options: { value: T; label: string; icon?: React.ReactNode }[]; onChange(value: T): void; label: string; disabled?: boolean;
}) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return <div className="dqt-segmented" role="group" aria-label={label} style={{ '--count': options.length, '--index': index } as React.CSSProperties}>
    <span className="dqt-segmented-thumb" aria-hidden />
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} disabled={disabled}
      onClick={() => { if (option.value !== value) onChange(option.value); }}>{option.icon}<span>{option.label}</span></button>)}
  </div>;
}

/** One transient confirmation at a time; errors that need action stay in the page banner instead. */
export function Toast({ message, onDismiss }: { message: string; onDismiss(): void }) {
  useEffect(() => { if (!message) return; const timer = setTimeout(onDismiss, 3600); return () => clearTimeout(timer); }, [message, onDismiss]);
  return <div className="dqt-toast-region" role="status" aria-live="polite">
    {message && <div className="dqt-toast" key={message}><CircleCheck /><span>{message}</span><button type="button" aria-label="关闭提示" onClick={onDismiss}><X /></button></div>}
  </div>;
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Some desktop carriers deny the async clipboard API. */ }
  const focused = document.activeElement as HTMLElement | null, area = document.createElement('textarea');
  area.className = 'dqt-copy-buffer'; area.value = text; area.setAttribute('aria-hidden', 'true');
  document.body.append(area); area.select();
  try { if (!document.execCommand('copy')) throw new Error('复制失败，请选择文字后手动复制。'); }
  finally { area.remove(); focused?.focus({ preventScroll: true }); }
}
