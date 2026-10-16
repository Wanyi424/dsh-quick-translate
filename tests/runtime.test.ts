import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { Runtime, type Llm, type LlmChunk } from '../src/runtime';
import { createHandler } from '../src/host';
import { fixture, pause, until } from './helpers';
import { MAX_SOURCE } from '../src/contracts';

function fake(generate: (options: Parameters<Llm['stream']>[0]) => AsyncIterable<LlmChunk>): Llm {
  return { listProviders: () => [{ id: 'fixture', name: '本地测试提供方' }], listModels: async () => [{ provider: 'fixture', id: 'test', name: '测试模型' }], stream: generate };
}
async function configured(store: Awaited<ReturnType<typeof fixture>>['store']) { await store.update({ prompt: '精确原始提示词，无语言参数。', provider: 'fixture', model: 'test' }); }
test('DSH model route and exact prompt/source are used; reasoning is excluded, final text is authoritative', async () => {
  const f = await fixture(); let options: Parameters<Llm['stream']>[0] | undefined;
  const runtime = new Runtime(f.store, fake(async function* (input) {
    options = input; yield { type: 'reasoning-delta', index: 0, text: 'private thought' };
    yield { type: 'text-delta', index: 1, text: '你' }; yield { type: 'text-delta', index: 1, text: '好' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '你好！' } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }));
  try {
    await configured(f.store); const r = await runtime.start('Hello!'); await until(() => !runtime.running);
    assert.equal(runtime.active?.result, '你好！'); assert.equal(runtime.active?.status, 'completed');
    assert.equal(options!.provider, 'fixture'); assert.equal(options!.purpose, 'quick-translate');
    assert.equal(options!.system, f.store.settings.prompt); assert.deepEqual(options!.messages[0].content, [{ type: 'text', text: 'Hello!' }]);
    assert.equal((await f.store.read(r.id)).prompt, options!.system); assert.ok(!('tools' in options!));
  } finally { await runtime.dispose(); await f.cleanup(); }
});
test('token usage, phase timing and the provider failure code are kept with the record', async () => {
  const f = await fixture(); let fail = false;
  const runtime = new Runtime(f.store, fake(async function* () {
    await pause(30); yield { type: 'reasoning-delta', index: 0, text: 'thinking' };
    await pause(30); yield { type: 'text-delta', index: 1, text: '你好' };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 1000, totalTokens: 1046 } };
    yield { type: 'finish', reason: fail ? { kind: 'error', failure: { message: '请求过于频繁', code: 'RATE_LIMIT' } } : { kind: 'stop' } };
  }));
  try {
    await configured(f.store); const r = await runtime.start('Hello'); await until(() => !runtime.running);
    const saved = await f.store.read(r.id);
    assert.deepEqual(saved.usage, { inputTokens: 12, outputTokens: 34, cacheReadTokens: 1000, totalTokens: 1046 });
    assert.ok(saved.firstTokenMs! >= 25 && saved.firstTextMs! - saved.firstTokenMs! >= 25, 'thinking time sits between the two marks');
    assert.equal(saved.errorCode, undefined);
    fail = true; const failed = await runtime.start('Again'); await until(() => !runtime.running);
    assert.equal((await f.store.read(failed.id)).errorCode, 'RATE_LIMIT'); assert.equal(runtime.active?.status, 'failed');
  } finally { await runtime.dispose(); await f.cleanup(); }
});
test('stream subscriber receives partial output; disconnect does not cancel; reconnect snapshots progress; no idle update loop', async () => {
  const f = await fixture(); const runtime = new Runtime(f.store, fake(async function* () {
    yield { type: 'text-delta', text: 'Hello' }; await pause(240); yield { type: 'text-delta', text: ' world' }; await pause(200); yield { type: 'finish', reason: { kind: 'stop' } };
  }));
  try {
    await configured(f.store); const r = await runtime.start('你好');
    const abort = new AbortController(), reader = runtime.events(r.id, abort.signal).body!.getReader();
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value)); assert.equal(first.type, 'snapshot');
    assert.equal(first.record.status, 'running');
    // After the current output is delivered there must be no busy stream of empty deltas.
    await pause(30); if (first.record.result !== 'Hello') await reader.read();
    const pending = reader.read(); assert.equal(await Promise.race([pending.then(() => 'data'), pause(40).then(() => 'idle')]), 'idle');
    abort.abort(); await pending; assert.equal(runtime.running, true);
    await until(() => !runtime.running); assert.equal(runtime.active?.result, 'Hello world');
    const again = await runtime.events(r.id, new AbortController().signal).text(); const latest = JSON.parse(again.trim()); assert.equal(latest.record.status, 'completed');
  } finally { await runtime.dispose(); await f.cleanup(); }
});
test('only one request runs; clear/migrate are refused during work; stop retains partial output and releases an unresponsive adapter', async () => {
  const f = await fixture(); const runtime = new Runtime(f.store, fake(async function* () {
    yield { type: 'text-delta', text: '保留这部分' }; await new Promise(() => {});
  }));
  try {
    await configured(f.store); const r = await runtime.start('hello'); await until(() => runtime.active?.result === '保留这部分');
    await assert.rejects(runtime.start('second'), /当前翻译/); await assert.rejects(runtime.clear(), /当前翻译/); await assert.rejects(runtime.migrate(join(f.root, 'new')), /当前翻译/);
    await runtime.stop(r.id); assert.equal(runtime.active?.status, 'stopped'); assert.equal((await f.store.read(r.id)).result, '保留这部分');
    await runtime.migrate(join(f.root, 'new')); assert.equal(f.store.settings.directory, join(f.root, 'new'));
  } finally { await runtime.dispose(); await f.cleanup(); }
});
test('failed, truncated, empty and disconnected provider responses are never reported as completed', async () => {
  for (const kind of ['error', 'max-tokens', 'empty', 'disconnected']) {
    const f = await fixture(); const runtime = new Runtime(f.store, fake(async function* () {
      if (kind !== 'empty') yield { type: 'text-delta', text: 'partial' };
      if (kind !== 'disconnected') yield { type: 'finish', reason: { kind: kind === 'empty' ? 'stop' : kind, failure: { message: '模拟提供方错误' } } };
    }));
    try { await configured(f.store); await runtime.start('Hello'); await until(() => !runtime.running); assert.equal(runtime.active?.status, 'failed', kind); assert.ok(runtime.active?.error); }
    finally { await runtime.dispose(); await f.cleanup(); }
  }
});
test('timeout and plugin disposal stop the request and persist its status', async () => {
  const f = await fixture(); const runtime = new Runtime(f.store, fake(async function* () { await new Promise(() => {}); }), 40);
  try {
    await configured(f.store); await runtime.start('hello'); await until(() => !runtime.running); assert.equal(runtime.active?.status, 'stopped');
    const r = await runtime.start('again'); await runtime.dispose(); assert.equal((await f.store.read(r.id)).status, 'stopped'); await assert.rejects(runtime.start('closed'), /关闭/);
  } finally { await runtime.dispose(); await f.cleanup(); }
});
test('persistence failure blocks dispatch; final save failure stays in memory and can be retried', async () => {
  const f = await fixture(); let called = 0; const runtime = new Runtime(f.store, fake(async function* () { called++; yield { type: 'text-delta', text: 'translated' }; yield { type: 'finish', reason: { kind: 'stop' } }; }));
  try {
    await configured(f.store); const original = f.store.save.bind(f.store);
    f.store.save = async () => { throw new Error('disk full'); };
    await assert.rejects(runtime.start('hello'), /disk full/); assert.equal(called, 0);
    f.store.save = async r => { if (r.status !== 'running') throw new Error('disk full'); await original(r); };
    await runtime.start('hello'); await until(() => !runtime.running); assert.ok(runtime.active?.saveError); assert.equal(runtime.active?.result, 'translated');
    await assert.rejects(runtime.start('new'), /尚未保存/); f.store.save = original; await runtime.retrySave(); assert.equal(runtime.active?.saveError, undefined);
    assert.equal((await f.store.read(runtime.active!.id)).result, 'translated');
  } finally { await runtime.dispose(); await f.cleanup(); }
});
test('API validates models/input, confirms clear, resolves only managed directories including after migration', async () => {
  const f = await fixture(); const runtime = new Runtime(f.store, fake(async function* () { yield { type: 'text-delta', text: '你好' }; yield { type: 'finish', reason: { kind: 'stop' } }; }));
  const handle = createHandler(runtime);
  const req = (body: unknown) => handle(new Request('http://localhost/api/quick-translate', { method: 'POST', body: JSON.stringify(body) }));
  try {
    await assert.rejects(runtime.start('Hello'), /选择/); await configured(f.store);
    await assert.rejects(runtime.start('a'.repeat(MAX_SOURCE + 1)), /60,000/);
    assert.equal((await req({ action: 'clear' })).status, 400);
    const directory = await req({ action: 'directory', target: 'history', directory: 'C:\\untrusted' });
    assert.equal(directory.status, 200); assert.deepEqual(await directory.json(), { data: { directory: f.store.settings.directory } });
    const prompts = await req({ action: 'directory', target: 'prompts' });
    assert.equal(prompts.status, 200); assert.deepEqual(await prompts.json(), { data: { directory: dirname(f.store.settings.customPromptFile) } });
    assert.equal((await stat(dirname(f.store.settings.customPromptFile))).isDirectory(), true);
    assert.equal((await req({ action: 'directory', target: 'arbitrary' })).status, 400);
    await runtime.migrate(join(f.root, '迁移后的目录 with spaces'));
    assert.deepEqual(await (await req({ action: 'directory', target: 'history' })).json(), { data: { directory: f.store.settings.directory } });
    const started = await req({ action: 'start', source: 'Hello' }); assert.equal(started.status, 200); await until(() => !runtime.running);
    assert.equal((await req({ action: 'clear', confirm: true })).status, 200); assert.equal((await f.store.list()).total, 0);
  } finally { await runtime.dispose(); await f.cleanup(); }
});
