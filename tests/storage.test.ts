import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, record } from './helpers';
import { Store } from '../src/storage';
import { DEFAULT_PROMPT } from '../src/prompts';

test('startup is lazy; preferences and UTF-8 records persist; interrupted records remain inspectable', async () => {
  const f = await fixture();
  try {
    await assert.rejects(access(f.store.settings.directory));
    assert.equal(f.store.settings.prompt, DEFAULT_PROMPT);
    await f.store.update({ prompt: '只翻译内容', provider: 'p', model: 'm' });
    const r = { ...record(), status: 'running' as const }; await f.store.save(r);
    const reopened = new Store(f.store.settingsFile); await reopened.init();
    assert.equal(reopened.settings.directory, f.store.settings.directory);
    assert.equal((await reopened.read(r.id)).status, 'interrupted');
    assert.equal((await reopened.read(r.id, r.id)).status, 'running');
    assert.equal((await reopened.read(r.id)).result, r.result);
    await assert.rejects(reopened.read('../settings/settings'), /编号/);
  } finally { await f.cleanup(); }
});
test('history is paged, skips malformed records, and clear preserves unrelated files and preferences', async () => {
  const f = await fixture();
  try {
    const records = Array.from({ length: 28 }, (_, i) => record(i));
    for (const r of records) await f.store.save(r);
    const a = await f.store.list(), b = await f.store.list(25);
    assert.equal(a.items.length, 25); assert.equal(a.next, 25); assert.equal(b.items.length, 3); assert.equal(b.next, null);
    await writeFile(join(f.store.settings.directory, `${records[0].id}.json`), '{oops');
    assert.equal((await f.store.list(25)).warnings.length, 1);
    await writeFile(join(f.store.settings.directory, 'keep.txt'), 'mine'); await mkdir(join(f.store.settings.directory, 'folder'));
    assert.equal(await f.store.clear(), 28);
    assert.deepEqual((await readdir(f.store.settings.directory)).sort(), ['folder', 'keep.txt']);
    assert.equal(f.store.settings.prompt, DEFAULT_PROMPT);
  } finally { await f.cleanup(); }
});
test('migration commits new location before deleting copies and removes the empty old directory', async () => {
  const f = await fixture();
  try {
    const r = record(), old = f.store.settings.directory; await f.store.save(r);
    const target = join(f.root, 'moved'); const moved = await f.store.migrate(target);
    assert.equal(moved.moved, 1); assert.equal(moved.oldDirectoryRemoved, true); await assert.rejects(access(old));
    assert.equal((await f.store.read(r.id)).result, r.result);
    const reopened = new Store(f.store.settingsFile); await reopened.init(); assert.equal(reopened.settings.directory, target);
    assert.equal(JSON.parse(await readFile(f.store.settingsFile, 'utf8')).directory, target);
  } finally { await f.cleanup(); }
});
test('migration preserves foreign files and rejects target collisions, nested directories and junctions', async () => {
  const f = await fixture();
  try {
    const r = record(), old = f.store.settings.directory; await f.store.save(r);
    await assert.rejects(f.store.migrate(join(old, 'child')), /父子/);
    await assert.rejects(f.store.migrate(f.root), /父子/);
    const target = join(f.root, 'target'); await mkdir(target);
    await writeFile(join(target, `${r.id}.json`), 'existing');
    await assert.rejects(f.store.migrate(target), /同名/); assert.equal((await f.store.read(r.id)).source, r.source);
    const linked = join(f.root, 'linked'); await symlink(target, linked, 'junction');
    await assert.rejects(f.store.migrate(linked), /普通文件夹/);
    await writeFile(join(old, 'personal.md'), '# keep'); await mkdir(join(old, 'other'));
    const moved = await f.store.migrate(join(f.root, 'safe'));
    assert.equal(moved.oldDirectoryRemoved, false); assert.equal(moved.warnings.length, 1);
    assert.deepEqual((await readdir(old)).sort(), ['other', 'personal.md']);
  } finally { await f.cleanup(); }
});
test('failed settings commit rolls back only copied history; originals and unrelated destination content survive', async () => {
  const f = await fixture();
  try {
    const store = new Store(join(f.root, 'blocked', 'settings.json'), join(f.root, 'old')); await store.init();
    const r = record(); await store.save(r); await writeFile(join(f.root, 'blocked'), 'not a folder');
    const target = join(f.root, 'target'); await mkdir(target); await writeFile(join(target, 'keep.txt'), 'keep');
    await assert.rejects(store.migrate(target));
    assert.equal((await store.read(r.id)).source, r.source); assert.deepEqual(await readdir(target), ['keep.txt']);
  } finally { await f.cleanup(); }
});
