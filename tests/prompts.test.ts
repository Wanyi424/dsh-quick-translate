import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/storage';
import { DEFAULT_PROMPT, DEFAULT_PROMPT_FILE } from '../src/prompts';
import { fixture, record } from './helpers';

test('default comes from packaged Markdown; custom save and model selection do not modify it', async () => {
  const f = await fixture();
  try {
    const original = await readFile(DEFAULT_PROMPT_FILE);
    assert.equal(f.store.settings.promptMode, 'default'); assert.equal(f.store.settings.prompt, original.toString('utf8'));
    await assert.rejects(access(f.store.settings.customPromptFile));
    await f.store.update({ provider: 'fixture', model: 'test' }); await assert.rejects(access(f.store.settings.customPromptFile));
    const custom = '# 自定义提示词\r\n\r\n只翻译，不解释。\r\n';
    await f.store.update({ prompt: custom }); assert.equal(await readFile(f.store.settings.customPromptFile, 'utf8'), custom);
    const config = JSON.parse(await readFile(f.store.settingsFile, 'utf8')); assert.equal(config.prompt, undefined); assert.equal(config.promptMode, 'custom');
    await f.store.update({ model: 'another' }); assert.equal(await readFile(f.store.settings.customPromptFile, 'utf8'), custom);
    assert.deepEqual(await readFile(DEFAULT_PROMPT_FILE), original);
  } finally { await f.cleanup(); }
});
test('restoring default preserves custom file; both modes survive restart and historical migration', async () => {
  const f = await fixture();
  try {
    await f.store.update({ prompt: '用户自己的翻译规则' }); const path = f.store.settings.customPromptFile;
    await f.store.setPromptMode('default'); assert.equal(f.store.settings.prompt, DEFAULT_PROMPT); assert.equal(await readFile(path, 'utf8'), '用户自己的翻译规则');
    const reopened = new Store(f.store.settingsFile); await reopened.init(); assert.equal(reopened.settings.promptMode, 'default'); assert.equal(reopened.settings.hasCustomPrompt, true);
    await reopened.setPromptMode('custom'); assert.equal(reopened.settings.prompt, '用户自己的翻译规则');
    await reopened.save(record()); await reopened.migrate(join(f.root, 'moved'));
    const again = new Store(f.store.settingsFile); await again.init(); assert.equal(again.settings.promptMode, 'custom'); assert.equal(again.settings.customPromptFile, path); assert.equal(again.settings.prompt, '用户自己的翻译规则');
  } finally { await f.cleanup(); }
});
test('missing active custom file allows startup recovery but refuses to translate with an invented fallback', async () => {
  const f = await fixture();
  try {
    await f.store.update({ prompt: '自定义' }); await unlink(f.store.settings.customPromptFile);
    const next = new Store(f.store.settingsFile); await next.init(); assert.ok(next.settings.promptError);
    await assert.rejects(next.refreshPrompt(), /不存在/); await next.setPromptMode('default');
    assert.equal(next.settings.prompt, DEFAULT_PROMPT); assert.equal(next.settings.promptError, undefined);
  } finally { await f.cleanup(); }
});
