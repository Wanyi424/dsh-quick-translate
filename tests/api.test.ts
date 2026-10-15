import test from 'node:test';
import assert from 'node:assert/strict';
import { openDirectory } from '../src/api';

test('both directory buttons use the DSH native launcher and the host-provided path', async () => {
  for (const target of ['history', 'prompts'] as const) {
    const calls: unknown[] = [], directory = `D:\\中文目录 with spaces\\${target}`;
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url, method: init?.method, body: JSON.parse(init?.body as string) });
      return calls.length === 1 ? Response.json({ data: { directory } }) : Response.json({ ok: true });
    };
    await openDirectory(target, fetcher);
    assert.deepEqual(calls, [
      { url: 'api/quick-translate', method: 'POST', body: { action: 'directory', target } },
      { url: 'open-in-app/open', method: 'POST', body: { app: 'explorer', path: directory } },
    ]);
  }
});

test('directory lookup failure stops before contacting the native launcher', async () => {
  let calls = 0;
  await assert.rejects(openDirectory('history', async () => {
    calls++; return Response.json({ error: { message: '无法创建目录' } }, { status: 400 });
  }), /无法创建目录/);
  assert.equal(calls, 1);
});

test('native launch errors and unavailable routes are surfaced instead of reporting success', async () => {
  for (const [response, message] of [
    [Response.json({ message: 'Explorer 启动失败' }, { status: 500 }), /Explorer 启动失败/],
    [new Response('Not found', { status: 404 }), /系统目录打开功能不可用/],
    [new Response('Bad gateway', { status: 502 }), /HTTP 502/],
  ] as const) {
    const fetcher: typeof fetch = async url => url === 'api/quick-translate'
      ? Response.json({ data: { directory: 'D:\\Translations' } }) : response;
    await assert.rejects(openDirectory('history', fetcher), message);
  }
});
