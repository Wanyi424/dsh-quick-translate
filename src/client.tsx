import React, { useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { Controller } from './controller';
import type { ClientContext } from './types';
declare const require: { async<T>(path: string): Promise<T> };
export const inject = ['slots', 'locale'];
function LazyPage({ controller }: { controller: Controller }) {
  const [Page, setPage] = useState<React.ComponentType<{ controller: Controller }> | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    require.async<typeof import('./page')>('./client.page.js').then(m => { if (live) setPage(() => m.Page); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);
  return Page ? <Page controller={controller} /> : <div style={{ padding: 28, color: 'var(--dsw-alias-label-secondary)' }} role="status">{failed ? <>翻译页面加载失败。<button onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>重试</button></> : '正在打开快捷翻译…'}</div>;
}
export function apply(ctx: ClientContext) {
  const controller = new Controller();
  ctx.effect(() => ctx.locale.register('quickTranslate', { zh: { title: '快捷翻译' }, en: { title: 'Translate' } }), 'quick-translate: locale');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'quick-translate', locale: 'quickTranslate' }, () => <LazyPage controller={controller} />));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'quick-translate', order: 16, label: () => ctx.locale.bind('quickTranslate')('title'), locale: 'quickTranslate' }, () => <Languages size={20} strokeWidth={1.6} />));
}
