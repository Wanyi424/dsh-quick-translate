import { build } from 'esbuild';
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { fixture, pause, until } from '../tests/helpers';
import type { HostContext } from '../src/host';
import type { LlmChunk } from '../src/runtime';
import { DEFAULT_PROMPT } from '../src/prompts';

// Real built plugin and Host handler, fake model only. No DSH profile or account is touched.
// Pages are served by request interception and API calls travel through the plugin's
// __DSH_TRANSPORT__ seam, so the check needs no TCP port and runs the same on Windows and WSL.
const f = await fixture(), output = resolve('artifacts/qa');
await mkdir(output, { recursive: true });
let browser: Browser | undefined, lastPage: Page | undefined;
const errors: string[] = [], external: string[] = [];
const disposers: (() => unknown)[] = [], opened: string[] = [], modelCalls: { source: string; prompt: string }[] = [];
let failOpen = false, bridgeCalls = 0;
try {
  await build({ entryPoints: ['tests/browser-entry.tsx'], outfile: join(f.root, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const { apply } = await import('../lib/' + 'host.js');
  let api!: (request: Request) => Promise<Response>;
  const ctx: HostContext = {
    connection: { fetch: { register(route) { api = route.fetch; } } },
    effect(fn) { disposers.push(fn()); },
    llm: {
      listProviders: () => [{ id: 'fixture', name: '隔离测试模型' }],
      listModels: async () => [{ provider: 'fixture', id: 'test', name: '流式翻译测试' }, { provider: 'fixture', id: 'alt', name: '备用模型' }],
      async *stream(options): AsyncIterable<LlmChunk> {
        modelCalls.push({ source: options.messages[0].content[0].text, prompt: options.system });
        await pause(300); yield { type: 'reasoning-delta', index: 0, text: 'Hidden thought' }; await pause(400);
        const text = options.messages[0].content[0].text.includes('STOP') ? '这是一段保留的部分译文。'.repeat(40) : 'Clear expression begins with understanding.\n\nA good translation preserves not just the meaning of the original, but also its tone and rhythm. Keep the language natural, the structure clear, and the details accurate.\n\nEvery word deserves a thoughtful choice.';
        for (let i = 0; i < text.length; i += 20) { options.signal.throwIfAborted(); yield { type: 'text-delta', index: 1, text: text.slice(i, i + 20) }; await pause(110); }
        yield { type: 'usage', usage: { inputTokens: 186, outputTokens: 64, cacheReadTokens: 1024, totalTokens: 1274 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  await apply(ctx, {}, f.store);
  const theme = JSON.parse(await readFile('tests/themes.json', 'utf8'));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${theme.light}}html[data-theme=dark]{${theme.dark}}*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}.fixture-shell{height:100%;display:grid;grid-template-columns:240px minmax(0,1fr)}.fixture-nav{background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l2);padding:28px 18px}.fixture-nav h2{font-size:22px;margin:0 0 34px}.fixture-nav div,.fixture-nav button{font-size:14px;padding:12px;border-radius:8px;margin-bottom:6px;display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;cursor:pointer}.fixture-nav .active{background:var(--dsw-alias-interactive-bg-active)}.fixture-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:24px}#plugin{min-width:0;height:100%;overflow:hidden}@media(max-width:900px){.fixture-shell{grid-template-columns:minmax(0,1fr)}.fixture-nav{display:none}}</style></head><body><div class="fixture-shell"><aside class="fixture-nav"><h2>deepseek HARNESS</h2><button id="close-translate">工作台</button><div>插件</div><div>笔记</div><button id="open-translate" class="active">快捷翻译</button><p class="fixture-label">隔离验证 · 非 DSH 实际窗口</p></aside><div id="plugin"></div></div><script src="/entry.js"></script><script src="/plugin.js"></script></body></html>`;
  const files: Record<string, string> = { '/entry.js': join(f.root, 'entry.js'), '/plugin.js': 'lib/client.js', '/client.page.js': 'lib/client.page.js' };
  browser = await chromium.launch({ headless: true });
  const page = lastPage = await browser.newPage({ viewport: { width: 1584, height: 992 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dsh.test') { external.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (files[url.pathname]) return route.fulfill({ contentType: 'text/javascript', body: await readFile(files[url.pathname]) });
    return route.fulfill({ status: 404, body: '' });
  });
  // Host transport bridge with real streaming: the page pulls each NDJSON chunk as it is produced.
  const streams = new Map<number, { reader: ReadableStreamDefaultReader<Uint8Array>; abort: AbortController }>();
  let nextStream = 0; const decoder = new TextDecoder();
  await page.exposeFunction('__bridgeFetch', async (path: string, body: string) => {
    bridgeCalls++;
    if (path === 'open-in-app/open') {
      const request = JSON.parse(body);
      assert.equal(request.app, 'explorer');
      assert.ok([f.store.settings.directory, dirname(f.store.settings.customPromptFile)].includes(request.path));
      if (!failOpen) opened.push(request.path);
      return { status: failOpen ? 500 : 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(failOpen ? { message: '模拟原生启动失败' } : { ok: true }) };
    }
    assert.equal(path, 'api/quick-translate');
    const abort = new AbortController();
    const response = await api(new Request('http://localhost/api/quick-translate', { method: 'POST', body, signal: abort.signal }));
    const id = ++nextStream; streams.set(id, { reader: response.body!.getReader(), abort });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), stream: id };
  });
  await page.exposeFunction('__bridgeRead', async (id: number) => {
    const stream = streams.get(id); if (!stream) return null;
    const { value, done } = await stream.reader.read();
    if (done) { streams.delete(id); return null; }
    return decoder.decode(value, { stream: true });
  });
  await page.exposeFunction('__bridgeCancel', async (id: number) => { const stream = streams.get(id); streams.delete(id); stream?.abort.abort(); await stream?.reader.cancel().catch(() => {}); });
  // Passed as source text: transpiler helpers (for example __name) do not exist inside the page.
  await page.addInitScript({ content: `(() => {
    const encoder = new TextEncoder();
    window.__DSH_TRANSPORT__ = { fetch: async (path, init = {}) => {
      const result = await window.__bridgeFetch(String(path), String(init.body ?? ''));
      if (result.stream === undefined) return new Response(result.body ?? null, { status: result.status, headers: result.headers });
      const id = result.stream;
      if (init.signal) init.signal.addEventListener('abort', () => void window.__bridgeCancel(id));
      return new Response(new ReadableStream({
        pull: async controller => { const chunk = await window.__bridgeRead(id); if (chunk === null) controller.close(); else controller.enqueue(encoder.encode(chunk)); },
        cancel: () => void window.__bridgeCancel(id),
      }), { status: result.status, headers: result.headers });
    } };
    window.longTasks = []; new PerformanceObserver(list => list.getEntries().forEach(e => window.longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
  })();` });
  const shot = (name: string) => page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' });
  const noDialog = () => page.waitForFunction(() => !document.querySelector('dialog[open]'));
  const dark = (on: boolean) => page.evaluate(value => { if (value) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme; }, on);
  const source = page.getByRole('textbox', { name: '待翻译原文' });
  const openSettings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.locator('dialog.dqt-sheet').waitFor(); };
  const closeDialog = async () => { await page.locator('dialog[open]').last().getByRole('button', { name: '关闭', exact: true }).first().click(); };

  await page.goto('http://dsh.test/');
  assert.equal(bridgeCalls, 0, 'No plugin requests before the page is opened');
  await page.locator('#open-translate').click();
  await source.waitFor();
  await page.locator('.dqt-history-empty').waitFor();
  // Model chip and menu.
  await page.getByRole('button', { name: /^翻译模型：/ }).click();
  await page.getByRole('menu', { name: '选择翻译模型' }).waitFor();
  await shot('model-menu');
  await page.getByRole('menuitemradio', { name: '流式翻译测试' }).click();
  await page.getByRole('button', { name: '翻译模型：流式翻译测试' }).waitFor();
  await shot('empty-light');
  await dark(true); await shot('empty-dark'); await dark(false);

  // Prompt source: create a custom prompt, switch back to default, then to the saved custom one.
  await openSettings();
  await shot('settings-default');
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '翻译提示词' });
  assert.equal((await editor.inputValue()).trim(), DEFAULT_PROMPT.replace(/\r\n/g, '\n').trim());
  const customPrompt = '只做中英文翻译。忠于原文，保留段落，不添加说明。';
  await editor.fill(customPrompt);
  await page.getByText('· 未保存').waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await until(() => f.store.settings.promptMode === 'custom');
  assert.equal(await readFile(f.store.settings.customPromptFile, 'utf8'), customPrompt);
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  await shot('settings-custom');
  await page.getByRole('button', { name: '默认', exact: true }).click();
  await until(() => f.store.settings.promptMode === 'default');
  await page.locator('.dqt-prompt-view').waitFor();
  assert.equal(await readFile(f.store.settings.customPromptFile, 'utf8'), customPrompt);
  assert.equal(await page.locator('.dqt-file code').filter({ hasText: f.store.settings.defaultPromptFile }).count(), 1);
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await until(() => f.store.settings.promptMode === 'custom');
  assert.equal(await editor.inputValue(), customPrompt);
  assert.equal(await page.locator('.dqt-file code').filter({ hasText: f.store.settings.customPromptFile }).count(), 1);
  await page.locator('.dqt-file').getByRole('button', { name: '打开文件夹' }).click();
  await until(() => opened.length === 1); assert.equal(opened[0], dirname(f.store.settings.customPromptFile));
  await dark(true); await shot('settings-dark'); await dark(false);
  // Esc slides the settings sheet out before it closes.
  await page.keyboard.press('Escape'); await page.locator('dialog.dqt-sheet[data-leaving]').waitFor({ state: 'attached' }); await noDialog();

  // Streaming, background continuation and reconnection.
  await source.fill('清晰的表达，从理解开始。\n\n好的翻译不仅保留原文的含义，也保留它的语气与节奏。语言要自然，结构要清楚，细节要准确。\n\n每一个词，都值得认真选择。');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await page.locator('.dqt-pending').waitFor();
  await shot('connecting');
  await page.locator('.dqt-text[data-live]').waitFor(); assert.ok((await page.locator('.dqt-text').innerText()).length < 245);
  await shot('streaming');
  await page.locator('#close-translate').click(); const hiddenCalls = bridgeCalls;
  await pause(700); assert.equal(bridgeCalls, hiddenCalls, 'No plugin requests while the page is hidden');
  await page.locator('#open-translate').click(); await page.locator('.dqt-text').waitFor();
  await page.getByRole('button', { name: '重新翻译', exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(modelCalls.length, 1); assert.equal(modelCalls[0].prompt, customPrompt);
  await page.locator('.dqt-status[data-status="completed"]').waitFor();
  await page.getByRole('button', { name: '复制译文' }).click(); await page.getByRole('button', { name: '已复制' }).waitFor();
  // Usage shows under the result: input counts cached tokens too.
  assert.equal(await page.locator('.dqt-meta').innerText(), '输入 1,210 · 输出 64 tokens');
  await shot('translated-light');
  await dark(true); await shot('translated-dark'); await dark(false);
  assert.match(await page.locator('.dqt-history-preview').first().innerText(), /^Clear expression/);
  // With the list hidden, the history entry is labeled and counted, and the result links to it.
  // Docked, the rail folds its column away and stays mounted (inert) until the column transition ends.
  await page.getByRole('button', { name: '收起历史记录' }).click();
  await page.locator('.dqt-rail[data-leaving][inert]').waitFor({ state: 'attached' }); await page.locator('.dqt-rail').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.dqt-history-button .dqt-count').innerText(), '1');
  await page.locator('.dqt-saved').waitFor(); await shot('rail-collapsed');
  await page.getByRole('button', { name: '已保存到历史' }).click(); await page.locator('.dqt-rail').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh-quick-translate:history-rail')), 'shown');
  assert.equal(await page.locator('.dqt-saved').count(), 0);
  // Run details: tokens, where the time went, the outcome and the prompt snapshot.
  await page.locator('.dqt-meta').click(); await page.locator('dialog.dqt-details').waitFor();
  const stats = await page.locator('.dqt-stat strong').allInnerTexts();
  assert.deepEqual(stats.slice(0, 2), ['1,210', '64']); assert.match(stats[2], / 秒$/);
  assert.match(await page.locator('.dqt-stat small').first().innerText(), /缓存命中 1,024/);
  assert.deepEqual(await page.locator('.dqt-timeline-legend span').evaluateAll(spans => spans.map(span => (span as HTMLElement).dataset.phase)), ['wait', 'think', 'write']);
  await shot('details');
  await dark(true); await shot('details-dark'); await dark(false);
  await closeDialog(); await noDialog();
  // Editing the source marks the shown translation as stale instead of replacing it.
  await source.press('End'); await source.type('补充');
  await page.locator('.dqt-result[data-stale]').waitFor();
  await page.getByRole('button', { name: '翻译', exact: true }).waitFor();
  await shot('stale');

  // Clear starts a new translation; stopping keeps partial output.
  await page.getByRole('button', { name: '清空原文' }).click();
  assert.equal(await source.inputValue(), '');
  await source.fill('STOP：测试停止后保留已输出部分');
  await page.keyboard.press('Control+Enter');
  await page.locator('.dqt-text[data-live]').waitFor();
  await page.getByRole('button', { name: '停止', exact: true }).click(); await page.getByRole('button', { name: '重新翻译', exact: true }).waitFor();
  // Find records by content, not position: list order follows creation timestamps, which a clock correction can reorder.
  assert.equal((await f.store.list()).items.find(item => item.title.startsWith('STOP'))?.status, 'stopped'); assert.ok((await page.locator('.dqt-text').innerText()).length > 0);
  await page.locator('.dqt-status[data-status="stopped"]').waitFor();
  await page.locator('.dqt-meta').filter({ hasText: '无用量数据' }).waitFor();

  // History view: read-only snapshot with its own prompt, and a clear way back.
  const firstRecord = page.locator('.dqt-history-item').filter({ hasText: '清晰的表达' });
  await firstRecord.click();
  await page.locator('.dqt-bar[data-mode="history"]').waitFor();
  assert.equal(await source.getAttribute('readonly'), '');
  await shot('history-view');
  await page.getByRole('button', { name: '更多操作' }).click(); await page.getByRole('menuitem', { name: '翻译详情' }).click();
  await page.locator('.dqt-disclosure summary').click();
  assert.equal(await page.locator('.dqt-prompt-snapshot').innerText(), customPrompt);
  await page.locator('dialog[open]').getByRole('button', { name: '关闭', exact: true }).last().click(); await noDialog();
  // The trigger toggles its own menu, and the menu sits flush with it (no first-frame scale offset).
  const more = page.getByRole('button', { name: '更多操作' }); await more.click();
  const [menuBox, moreBox] = [await page.getByRole('menu', { name: '记录操作' }).boundingBox(), await more.boundingBox()];
  assert.ok(Math.abs(menuBox!.x + menuBox!.width - moreBox!.x - moreBox!.width) < 1, 'menu right edge aligns with its trigger');
  await more.click(); await page.getByRole('menu').waitFor({ state: 'detached' });
  await source.focus(); await page.keyboard.press('Escape'); await page.locator('.dqt-bar[data-mode="history"]').waitFor({ state: 'detached' });
  await firstRecord.click({ button: 'right' });
  await page.getByRole('menu', { name: '历史记录操作' }).waitFor(); await shot('history-menu');
  await page.getByRole('menuitem', { name: '用此原文重译' }).click();
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="待翻译原文"]') as HTMLTextAreaElement).value.startsWith('清晰的表达'));

  // Data folder actions from settings, including a native-open failure.
  await openSettings();
  await page.locator('.dqt-section').nth(1).getByRole('button', { name: '打开文件夹' }).click();
  await until(() => opened.length === 2); assert.equal(opened[1], f.store.settings.directory);
  failOpen = true;
  await page.locator('.dqt-section').nth(1).getByRole('button', { name: '打开文件夹' }).click();
  await page.locator('dialog.dqt-sheet [role="alert"]').filter({ hasText: '资源管理器打开失败：模拟原生启动失败' }).waitFor();
  assert.equal(opened.length, 2); failOpen = false;
  const old = f.store.settings.directory, target = join(f.root, 'moved');
  await page.getByRole('button', { name: '更改位置…' }).click();
  await page.getByRole('textbox', { name: '新历史记录目录' }).fill(target);
  await shot('migration');
  await page.getByRole('button', { name: '迁移并使用', exact: true }).click();
  await noDialog();
  assert.equal(f.store.settings.directory, target); await assert.rejects(access(old)); assert.equal((await f.store.list()).total, 2);
  await page.locator('.dqt-toast').filter({ hasText: '已迁移 2 条记录' }).waitFor(); await shot('toast');
  await openSettings(); await page.locator('.dqt-section').nth(1).getByRole('button', { name: '打开文件夹' }).click();
  await until(() => opened.length === 3); assert.equal(opened[2], target);
  await closeDialog();

  // Responsive: drawer history at medium widths, stacked panes when narrow, never horizontal overflow.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('.dqt-root[data-layout="medium"]').waitFor(); await shot('compact');
  await page.locator('.dqt-history-button').click(); await page.locator('.dqt-rail[data-overlay]').waitFor(); await shot('compact-history');
  // The drawer slides back out over a fading scrim before it leaves the DOM.
  await page.locator('.dqt-scrim').click();
  await page.locator('.dqt-rail[data-leaving]').waitFor({ state: 'attached' }); await page.locator('.dqt-rail').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 420, height: 820 });
  await page.locator('.dqt-root[data-layout="narrow"]').waitFor(); await shot('narrow');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await dark(true); await shot('narrow-dark'); await dark(false);
  // Entering at a narrow width never renders the rail: the width is measured before the first paint, so no drawer slides away.
  await page.evaluate(() => document.getElementById('close-translate')!.click());
  await page.evaluate(() => { const w = window as unknown as { sawRail: boolean }; w.sawRail = false; new MutationObserver(() => { if (document.querySelector('.dqt-rail')) w.sawRail = true; }).observe(document.body, { subtree: true, childList: true }); });
  await page.evaluate(() => document.getElementById('open-translate')!.click());
  await page.locator('.dqt-root[data-layout="narrow"]').waitFor(); await pause(500);
  assert.equal(await page.evaluate(() => (window as unknown as { sawRail: boolean }).sawRail), false, 'no rail flashes when entering narrow');
  await page.setViewportSize({ width: 1584, height: 992 });
  await page.locator('.dqt-rail').waitFor();

  // Delete and clear always ask first.
  await openSettings(); await page.getByRole('button', { name: '清空全部…' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal((await f.store.list()).total, 2);
  await closeDialog();
  await page.locator('.dqt-history-item').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除' }).click(); await shot('delete-confirm');
  await page.getByRole('button', { name: '确认删除', exact: true }).click(); await noDialog();
  assert.equal((await f.store.list()).total, 1);
  await openSettings(); await page.getByRole('button', { name: '清空全部…' }).click();
  await page.getByRole('button', { name: '确认清空', exact: true }).click(); await noDialog();
  assert.equal((await f.store.list()).total, 0);
  await page.locator('.dqt-history-empty').waitFor();

  const report = { entryBytes: (await stat('lib/client.js')).size, pageBytes: (await stat('lib/client.page.js')).size, errors, externalRequests: external, longTasks: await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks), streaming: 'partial result visible before completion', usage: 'shown under the result and in run details', motion: 'rail column and drawer, menus and the settings sheet animate out before unmounting', historyEntry: 'labeled and counted when the list is hidden; result links to it', background: 'no page requests while hidden; returned to same request', modelRequests: modelCalls.length, promptSnapshot: 'exact', promptSource: 'default/custom switch keeps custom.md', staleResult: 'marked after source edit', historyPreview: 'translation first line shown', migration: 'old empty directory removed, new path persisted', stop: 'partial output saved', explorer: 'correct directory, OS launch mocked', historyDeleteAndClear: 'passed', responsiveOverflow: false };
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile('artifacts/verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Leave evidence for a failed run: the last frame and any page errors.
  await lastPage?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'));
  throw error;
} finally {
  await browser?.close(); for (const dispose of disposers) await dispose();
  await f.cleanup();
}
