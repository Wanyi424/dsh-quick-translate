import type React from 'react';
export interface ClientContext {
  effect(fn: () => (() => unknown), label?: string): unknown;
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(namespace: string): (key: string) => string };
  slots: { inject(slot: string, fn: () => unknown): unknown; register(options: { name: string; key?: string; id?: string; order?: number; label?: () => string; locale?: string }, component: React.ComponentType): () => void };
}
