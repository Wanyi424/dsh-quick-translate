import { API_PATH, type DirectoryTarget, type StreamEvent } from './contracts';
declare global { interface Window { __DSH_TRANSPORT__?: { fetch?: typeof fetch }; __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } } }
function transport() { return window.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis); }
async function send(body: unknown, signal?: AbortSignal, fetcher = transport()) {
  const response = await fetcher(API_PATH.slice(1), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message ?? `请求失败（HTTP ${response.status}）。`); }
  return response;
}
export async function request<T>(body: unknown): Promise<T> { return (await (await send(body)).json()).data; }
export async function openDirectory(target: DirectoryTarget, fetcher = transport()): Promise<void> {
  const { data: { directory } } = await (await send({ action: 'directory', target }, undefined, fetcher)).json();
  // Let DSH's native launcher handle Explorer visibility and startup failures.
  const response = await fetcher('open-in-app/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'explorer', path: directory }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(response.status === 404
      ? 'DSH 的系统目录打开功能不可用，请检查桌面版的原生打开服务。'
      : `资源管理器打开失败：${result?.message ?? `HTTP ${response.status}`}`);
  }
}
export async function readEvents(id: string, signal: AbortSignal, accept: (event: StreamEvent) => void) {
  const response = await send({ action: 'events', id }, signal);
  if (!response.body) throw new Error('当前连接不支持流式输出，请重新打开翻译页面。');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (line) accept(JSON.parse(line) as StreamEvent);
      }
      if (done) break;
    }
    if (pending.trim()) accept(JSON.parse(pending));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
