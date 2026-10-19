// Isolated carrier for the real built plugin; no DSH account/profile data is accessed.
import React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
const modules: Record<string, unknown> = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsxRuntime };
const dictionaries: Record<string, Record<string, Record<string, string>>> = {};
const cleanups: Array<() => unknown> = [];
const root = createRoot(document.getElementById('plugin')!);
const ctx = {
  locale: {
    register(ns: string, dict: Record<string, Record<string, string>>) { dictionaries[ns] = dict; return () => {}; },
    bind(ns: string) { return (key: string, params?: Record<string, unknown>) => (dictionaries[ns]?.zh?.[key] ?? key).replace(/\{(\w+)\}/g, (m: string, k: string) => String(params?.[k] ?? m)); },
    subscribe() { return () => {}; }, getSnapshot() { return 'zh'; },
  },
  effect(effect: () => (() => unknown)) { cleanups.push(effect()); },
  slots: {
    inject(_slot: string, register: () => unknown) { register(); },
    register(options: { name: string }, Component: React.ComponentType) {
      if (options.name === 'main') {
        document.getElementById('open-translate')!.addEventListener('click', () => root.render(<Component />));
        document.getElementById('close-translate')!.addEventListener('click', () => root.render(null));
      }
      return () => {};
    },
  },
};
type Factory = (require: ((id: string) => unknown) & { async(path: string): Promise<unknown> }) => unknown;
const factories = new Map<string, Factory>(); const cache = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
const localRequire = Object.assign((id: string) => { if (!(id in modules)) throw new Error(`Unresolved shared module: ${id}`); return modules[id]; }, {
  async(path: string): Promise<unknown> {
    const file = path.slice(2), id = `dsh-translate/${file}`;
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    if (!pending.has(id)) pending.set(id, new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/' + file;
      script.onload = () => resolve(); script.onerror = () => reject(new Error('Chunk failed: ' + file)); document.head.append(script);
    }).then(() => { const result = factories.get(id)!(localRequire); cache.set(id, result); return result; }));
    return pending.get(id)!;
  },
});
(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
  load(entry: { id: string; factory: Factory }) {
    factories.set(entry.id, entry.factory);
    if (entry.id === 'dsh-translate') (entry.factory(localRequire) as { apply(ctx: unknown): void }).apply(ctx);
  },
};
