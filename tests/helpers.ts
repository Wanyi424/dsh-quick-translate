import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../src/storage';
import type { Translation } from '../src/contracts';
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-translate-test-'));
  const store = new Store(join(root, 'settings', 'settings.json'), join(root, 'history')); await store.init();
  return { root, store, cleanup: async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('dsh-translate-test-')); await rm(root, { recursive: true, force: true }); } };
}
export function record(offset = 0): Translation {
  return { id: `${Date.now() + offset}-${randomUUID()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'Hello 世界', result: '你好 World', prompt: 'Translate', provider: 'fixture', model: 'test', modelName: '测试模型', status: 'completed' };
}
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await pause(10); } }
