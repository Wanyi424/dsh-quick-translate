import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import assert from 'node:assert/strict';
import { fixture, pause, until } from '../tests/helpers';
import type { HostContext } from '../src/host';
import type { LlmChunk } from '../src/runtime';
import { DEFAULT_PROMPT } from '../src/prompts';

// Real built plugin and Host handler, fake model only. No DSH profile or account is touched.
const f = await fixture(), output = resolve('artifacts/qa');
await mkdir(output, { recursive: true });
let browser: Browser | undefined, server: Server | undefined;
const disposers: (() => unknown)[] = [], opened: string[] = [], modelCalls: unknown[] = [];
let failOpen = false;
try {
  await build({ entryPoints: ['tests/browser-entry.tsx'], outfile: join(f.root, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const { apply } = await import('../lib/' + 'host.js');
  let api: (request: Request) => Promise<Response>;
  const ctx: HostContext = {
    connection: { fetch: { register(route) { api = route.fetch; } } },
    effect(fn) { disposers.push(fn()); },
    llm: {
      listProviders: () => [{ id: 'fixture', name: '隔离测试模型' }],
      listModels: async () => [{ provider: 'fixture', id: 'test', name: '流式翻译测试' }],
      async *stream(options): AsyncIterable<LlmChunk> {
        modelCalls.push({ source: options.messages[0].content[0].text, prompt: options.system });
        yield { type: 'reasoning-delta', index: 0, text: 'Hidden thought' }; await pause(160);
        const text = options.messages[0].content[0].text.includes('STOP') ? '这是一段保留的部分译文。'.repeat(40) : 'Clear expression begins with understanding.\n\nA good translation preserves not just the meaning of the original, but also its tone and rhythm. Keep the language natural, the structure clear, and the details accurate.\n\nEvery word deserves a thoughtful choice.';
        for (let i = 0; i < text.length; i += 20) { options.signal.throwIfAborted(); yield { type: 'text-delta', index: 1, text: text.slice(i, i + 20) }; await pause(110); }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  await apply(ctx, {}, f.store);
  const theme = JSON.parse(await readFile('tests/themes.json', 'utf8'));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${theme.light}}html[data-theme=dark]{${theme.dark}}*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}.fixture-shell{height:100%;display:grid;grid-template-columns:240px minmax(0,1fr)}.fixture-nav{background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l2);padding:28px 18px}.fixture-nav h2{font-size:22px;margin:0 0 34px}.fixture-nav div,.fixture-nav button{font-size:14px;padding:12px;border-radius:8px;margin-bottom:6px;display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;cursor:pointer}.fixture-nav .active{background:var(--dsw-alias-interactive-bg-active)}.fixture-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:24px}#plugin{min-width:0;height:100%;overflow:hidden}@media(max-width:900px){.fixture-shell{grid-template-columns:minmax(0,1fr)}.fixture-nav{display:none}}</style></head><body><div class="fixture-shell"><aside class="fixture-nav"><h2>deepseek HARNESS</h2><button id="close-translate">工作台</button><div>插件</div><div>笔记</div><button id="open-translate" class="active">快捷翻译</button><p class="fixture-label">隔离验证 · 非 DSH 实际窗口</p></aside><div id="plugin"></div></div><script src="/entry.js"></script><script src="/plugin.js"></script></body></html>`;
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/open-in-app/open') {
        const chunks: Buffer[] = []; for await (const part of req) chunks.push(part);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.app, 'explorer');
        assert.ok([f.store.settings.directory, dirname(f.store.settings.customPromptFile)].includes(body.path));
        res.writeHead(failOpen ? 500 : 200, { 'content-type': 'application/json' });
        if (!failOpen) opened.push(body.path);
        res.end(JSON.stringify(failOpen ? { message: '模拟原生启动失败' } : { ok: true })); return;
      }
      if (req.url === '/api/quick-translate') {
        const chunks: Buffer[] = []; for await (const part of req) chunks.push(part);
        const abort = new AbortController(); res.on('close', () => abort.abort());
        const response = await api!(new Request('http://localhost/api/quick-translate', { method: 'POST', body: Buffer.concat(chunks), signal: abort.signal }));
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          try { while (true) { const { value, done } = await reader.read(); if (done || res.destroyed) break; if (!res.write(value)) await once(res, 'drain'); } }
          finally { await reader.cancel().catch(() => {}); }
        }
        res.end(); return;
      }
      res.writeHead(200, { 'content-type': req.url?.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
      res.end(req.url === '/entry.js' ? await readFile(join(f.root, 'entry.js')) : req.url === '/plugin.js' ? await readFile('lib/client.js') : req.url === '/client.page.js' ? await readFile('lib/client.page.js') : html);
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1584, height: 992 } });
  const errors: string[] = [], requests: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { const url = new URL(req.url()); (url.hostname === '127.0.0.1' ? requests : external).push(url.pathname); });
  await page.addInitScript(() => { const w = window as unknown as { longTasks: number[] }; w.longTasks = []; new PerformanceObserver(list => list.getEntries().forEach(e => w.longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true }); });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { waitUntil: 'networkidle' });
  assert.ok(!requests.some(p => p.includes('/api/') || p.includes('client.page')));
  await page.locator('#open-translate').click();
  await page.getByRole('heading', { name: '快捷翻译', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '翻译模型' }).selectOption(JSON.stringify(['fixture', 'test']));
  await page.waitForFunction(() => !(document.querySelector('.dqt-model select') as HTMLSelectElement)?.disabled);
  await page.screenshot({ path: join(output, 'empty-light.png') });
  await page.getByRole('button', { name: '翻译设置', exact: true }).click();
  const customPrompt = '只做中英文翻译。忠于原文，保留段落，不添加说明。';
  await page.getByRole('textbox', { name: '翻译提示词', exact: true }).fill(customPrompt);
  await page.getByRole('button', { name: '保存自定义提示词', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await readFile(f.store.settings.customPromptFile, 'utf8'), customPrompt);
  await page.getByRole('button', { name: '翻译设置', exact: true }).click();
  await page.getByRole('button', { name: '恢复默认提示词', exact: true }).click();
  await page.waitForFunction(text => (document.querySelector('textarea[aria-label="翻译提示词"]') as HTMLTextAreaElement)?.value === text, DEFAULT_PROMPT.replace(/\r\n/g, '\n'));
  assert.equal(await readFile(f.store.settings.customPromptFile, 'utf8'), customPrompt);
  assert.equal(await page.locator('.dqt-prompt-files').getByText(f.store.settings.defaultPromptFile, { exact: true }).count(), 1);
  assert.equal(await page.locator('.dqt-prompt-files').getByText(f.store.settings.customPromptFile, { exact: true }).count(), 1);
  await page.getByRole('button', { name: '使用已保存的自定义', exact: true }).click();
  await page.waitForFunction(text => (document.querySelector('textarea[aria-label="翻译提示词"]') as HTMLTextAreaElement)?.value === text, customPrompt);
  await page.getByRole('button', { name: '打开自定义提示词目录', exact: true }).click();
  await until(() => opened.length === 1); assert.equal(opened[0], dirname(f.store.settings.customPromptFile));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('textbox', { name: '待翻译原文' }).fill('清晰的表达，从理解开始。\n\n好的翻译不仅保留原文的含义，也保留它的语气与节奏。语言要自然，结构要清楚，细节要准确。\n\n每一个词，都值得认真选择。');
  await page.getByRole('button', { name: '开始翻译', exact: true }).click();
  await page.locator('.dqt-translated').waitFor(); assert.ok((await page.locator('.dqt-translated').innerText()).length < 245);
  await page.screenshot({ path: join(output, 'streaming.png') });
  await page.locator('#close-translate').click(); const hiddenRequests = requests.length;
  await pause(700); assert.equal(requests.length, hiddenRequests);
  await page.locator('#open-translate').click(); await page.locator('.dqt-translated').waitFor();
  await page.getByRole('button', { name: '重新翻译', exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(modelCalls.length, 1); assert.equal((modelCalls[0] as { prompt: string }).prompt, customPrompt);
  await page.getByRole('button', { name: '复制译文' }).click(); await page.getByText('已复制', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'translated-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: join(output, 'translated-dark.png') });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.getByRole('button', { name: '翻译设置', exact: true }).click(); await page.screenshot({ path: join(output, 'settings.png') }); await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '新建翻译', exact: true }).click();
  await page.getByRole('textbox', { name: '待翻译原文' }).fill('STOP：测试停止后保留已输出部分');
  await page.getByRole('button', { name: '开始翻译', exact: true }).click(); await page.locator('.dqt-translated').waitFor();
  await page.getByRole('button', { name: '停止翻译', exact: true }).click(); await page.getByRole('button', { name: '重新翻译', exact: true }).waitFor();
  assert.equal((await f.store.list()).items[0].status, 'stopped'); assert.ok((await page.locator('.dqt-translated').innerText()).length > 0);
  await page.locator('.dqt-history-item').last().click(); assert.equal(await page.getByRole('textbox', { name: '待翻译原文' }).getAttribute('readonly'), '');
  await page.getByLabel('更多操作').click(); await page.getByRole('button', { name: '查看本次提示词', exact: true }).click(); assert.equal(await page.locator('.dqt-prompt-snapshot').innerText(), customPrompt); await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('更多操作').click(); await page.getByRole('button', { name: '在资源管理器打开', exact: true }).click();
  await until(() => opened.length === 2); assert.equal(opened[1], f.store.settings.directory);
  failOpen = true;
  await page.getByLabel('更多操作').click(); await page.getByRole('button', { name: '在资源管理器打开', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '资源管理器打开失败：模拟原生启动失败' }).waitFor();
  assert.equal(opened.length, 2); failOpen = false; await page.getByRole('button', { name: '关闭错误提示' }).click();
  const old = f.store.settings.directory, target = join(f.root, 'moved');
  await page.getByRole('button', { name: '更改位置', exact: true }).click(); await page.getByRole('textbox', { name: '新历史记录目录' }).fill(target);
  await page.screenshot({ path: join(output, 'migration.png') }); await page.getByRole('button', { name: '迁移并使用', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(f.store.settings.directory, target); await assert.rejects(access(old)); assert.equal((await f.store.list()).total, 2);
  await page.getByLabel('更多操作').click(); await page.getByRole('button', { name: '在资源管理器打开', exact: true }).click();
  await until(() => opened.length === 3); assert.equal(opened[2], target);
  await page.setViewportSize({ width: 900, height: 800 }); await page.screenshot({ path: join(output, 'compact.png') });
  await page.setViewportSize({ width: 420, height: 820 });
  if (await page.getByRole('button', { name: '收起历史记录' }).isVisible()) await page.getByRole('button', { name: '收起历史记录' }).click();
  await page.screenshot({ path: join(output, 'narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1584, height: 992 });
  if (await page.getByRole('button', { name: '展开历史记录' }).isVisible()) await page.getByRole('button', { name: '展开历史记录' }).click();
  await page.getByRole('button', { name: '清空历史记录', exact: true }).click(); await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal((await f.store.list()).total, 2);
  await page.getByLabel('更多操作').click(); await page.getByRole('button', { name: '删除这条记录', exact: true }).click(); await page.getByRole('button', { name: '确认删除', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal((await f.store.list()).total, 1);
  await page.getByRole('button', { name: '清空历史记录', exact: true }).click(); await page.getByRole('button', { name: '确认清空', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal((await f.store.list()).total, 0);
  const report = { entryBytes: (await stat('lib/client.js')).size, pageBytes: (await stat('lib/client.page.js')).size, errors, externalRequests: external, longTasks: await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks), streaming: 'partial result visible before completion', background: 'no page requests while hidden; returned to same request', modelRequests: modelCalls.length, promptSnapshot: 'exact', migration: 'old empty directory removed, new path persisted', stop: 'partial output saved', explorer: 'correct directory, OS launch mocked', historyDeleteAndClear: 'passed', responsiveOverflow: false };
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile('artifacts/verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); for (const dispose of disposers) await dispose();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await f.cleanup();
}
