import React, { useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { Controller } from './controller';
import type { ClientContext } from './types';
declare const require: { async<T>(path: string): Promise<T> };
export const inject = ['slots', 'locale'];
const hint: React.CSSProperties = { height: '100%', display: 'grid', placeContent: 'center', gap: 12, justifyItems: 'center', color: 'var(--dsw-alias-label-tertiary)', font: "13px 'Segoe UI', 'Microsoft YaHei UI', sans-serif" };
function LazyPage({ controller }: { controller: Controller }) {
  const [Page, setPage] = useState<React.ComponentType<{ controller: Controller }> | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [slow, setSlow] = useState(false);
  useEffect(() => {
    let live = true; const timer = setTimeout(() => setSlow(true), 200);
    require.async<typeof import('./page')>('./client.page.js').then(m => { if (live) setPage(() => m.Page); }, () => { if (live) setFailed(true); });
    return () => { live = false; clearTimeout(timer); };
  }, [attempt]);
  if (Page) return <Page controller={controller} />;
  // A local chunk usually arrives within a frame or two; only show the hint when it does not.
  return <div style={hint} role="status">{failed ? <>翻译页面加载失败<button onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>重试</button></> : slow ? '正在打开快捷翻译…' : null}</div>;
}
export function apply(ctx: ClientContext) {
  const controller = new Controller();
  ctx.effect(() => ctx.locale.register('quickTranslate', { zh: { title: '快捷翻译' }, en: { title: 'Translate' } }), 'quick-translate: locale');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'quick-translate', locale: 'quickTranslate' }, () => <LazyPage controller={controller} />));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'quick-translate', order: 16, label: () => ctx.locale.bind('quickTranslate')('title'), locale: 'quickTranslate' }, () => <Languages size={20} strokeWidth={1.6} />));
}
