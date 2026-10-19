import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage';
import { translationDataDirectory } from '../src/data-paths';
import { fixture, record } from './helpers';

test('DSH home owns settings, custom prompt and history; history migration leaves settings and prompt in place', async () => {
  const f = await fixture(), previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = ' ';
    assert.equal(translationDataDirectory(), join(homedir(), '.dsh', 'plugin-data', 'dsh-translate'));
    process.env.DSH_HOME = join(f.root, 'harness');
    const root = join(process.env.DSH_HOME, 'plugin-data', 'dsh-translate');
    const store = new Store(); await store.init();
    assert.equal(store.settingsFile, join(root, 'settings.json')); assert.equal(store.settings.directory, join(root, 'history'));
    assert.equal(store.settings.customPromptFile, join(root, 'prompts', 'custom.md'));
    await store.update({ prompt: '保留此提示词', provider: 'p', model: 'm' }); const r = record(); await store.save(r);
    const old = store.settings.directory, target = join(f.root, 'moved'); await store.migrate(target);
    await assert.rejects(access(old));
    const reopened = new Store(); await reopened.init();
    assert.equal(reopened.settings.directory, target); assert.equal(reopened.settings.prompt, '保留此提示词');
    assert.equal(await readFile(reopened.settings.customPromptFile, 'utf8'), '保留此提示词'); assert.equal((await reopened.read(r.id)).result, r.result);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await f.cleanup();
  }
});

test('legacy dsh-quick-translate data directory is automatically migrated to dsh-translate', async () => {
  const f = await fixture(), previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join(f.root, 'legacy-home');
    const legacyDir = join(process.env.DSH_HOME, 'plugin-data', 'dsh-quick-translate');
    const newDir = join(process.env.DSH_HOME, 'plugin-data', 'dsh-translate');
    await mkdir(join(legacyDir, 'history'), { recursive: true });
    await writeFile(join(legacyDir, 'settings.json'), JSON.stringify({ directory: join(legacyDir, 'history'), promptMode: 'default' }));

    assert.equal(translationDataDirectory(), newDir);
    await access(newDir);
    await assert.rejects(access(legacyDir));

    const store = new Store(); await store.init();
    assert.equal(store.settings.directory, join(newDir, 'history'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await f.cleanup();
  }
});
