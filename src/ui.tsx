import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleCheck, X } from 'lucide-react';

/** Menus are portaled into the plugin root, so they are positioned and clamped against the plugin, not the host. */
export const LayerContext = createContext<HTMLElement | null>(null);

/**
 * Keeps a surface mounted while it animates out. While `value` is set it is returned as is; once it clears, the last value
 * stays, with `leaving` true, until the exit animation's end event calls `settle` (a stable callback).
 */
export function usePresence<T>(value: T) {
  const [kept, setKept] = useState(value), latest = useRef(value);
  if (value && value !== kept) setKept(value);
  useLayoutEffect(() => { latest.current = value; });
  const settle = useCallback(() => { if (!latest.current) setKept(latest.current); }, []);
  return { value: value || kept, leaving: !value && !!kept, settle };
}

export type MenuEntry = 'separator' | { group: string } | { label: string; icon?: React.ReactNode; onSelect(): void; danger?: boolean; disabled?: boolean; checked?: boolean };
/** `toggle`: the trigger owns the menu, so pressing it again closes the menu instead of counting as an outside press. */
export interface MenuAnchor { x: number; y: number; width: number; height: number; align: 'start' | 'end'; trigger: HTMLElement | null; toggle: boolean }
/** Menu under a button; the button's own click toggles it. */
export const anchorFrom = (element: HTMLElement, align: MenuAnchor['align'] = 'end'): MenuAnchor => {
  const r = element.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, align, trigger: element, toggle: true };
};
/** Context menu at the pointer: any press outside closes it, so another right-click reopens it where the pointer is. */
export const anchorAt = (event: React.MouseEvent): MenuAnchor => ({ x: event.clientX, y: event.clientY, width: 0, height: 0, align: 'start', trigger: event.currentTarget as HTMLElement, toggle: false });

const HIDDEN: React.CSSProperties = { visibility: 'hidden' };
export function Menu({ anchor, entries, label, onClose, footer, className = '', leaving = false, onExited }: {
  anchor: MenuAnchor; entries: MenuEntry[]; label: string; onClose(): void; footer?: React.ReactNode; className?: string;
  /** Closing: the menu fades out, ignores input and reports the end of its exit animation. */
  leaving?: boolean; onExited?(): void;
}) {
  const layer = useContext(LayerContext), ref = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { onClose(); if (restore) anchor.trigger?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    const menu = ref.current; if (!menu || !layer) return;
    // Layout size, not getBoundingClientRect: on its first frame the opening animation still scales the menu down.
    const bounds = layer.getBoundingClientRect(), own = { width: menu.offsetWidth, height: menu.offsetHeight }, gap = 6, edge = 8;
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
    if (leaving) return;
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!ref.current?.contains(target) && !(anchor.toggle && anchor.trigger?.contains(target))) onClose(); };
    const dismiss = () => onClose();
    // Only a scroll that carries the anchor away detaches the menu; scrolling another region, such as a reading pane, does not.
    const scrolled = (event: Event) => { const target = event.target as Node; if (!ref.current?.contains(target) && target.contains(anchor.trigger)) onClose(); };
    document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    layer?.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); layer?.removeEventListener('scroll', scrolled, true); };
  }, [anchor, layer, onClose, leaving]);
  if (!layer) return null;
  return createPortal(<div ref={ref} className={`dqt-menu ${className}`} role="menu" aria-label={label} style={HIDDEN}
    data-leaving={leaving || undefined} inert={leaving} aria-hidden={leaving || undefined}
    onAnimationEnd={event => { if (leaving && event.target === event.currentTarget) onExited?.(); }} onKeyDown={event => {
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

/**
 * Native modal dialog: focus trap, Esc and top layer come from the browser. Esc, the backdrop and the close button play the
 * exit animation before `onClose`; footer actions close at once.
 */
export function Dialog({ title, onClose, busy = false, className = '', children, footer }: {
  title: string; onClose(): void; busy?: boolean; className?: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId(), [leaving, setLeaving] = useState(false);
  const dismiss = () => { if (!busy) setLeaving(true); };
  useEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`dqt-dialog ${className}`} aria-labelledby={id} data-leaving={leaving || undefined}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}
    onAnimationEnd={event => { if (leaving && event.target === event.currentTarget && !event.pseudoElement) onClose(); }}>
    <header><h2 id={id}>{title}</h2><button type="button" className="dqt-icon-button" aria-label="关闭" title="关闭" disabled={busy} onClick={dismiss}><X /></button></header>
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
