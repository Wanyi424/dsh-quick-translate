import { API_PATH } from './contracts';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Runtime, type Llm } from './runtime';
import { Store } from './storage';
export const name = 'translate';
export const inject = ['connection', 'llm'];
export interface HostContext {
  llm: Llm;
  effect(fn: () => (() => unknown), label?: string): unknown;
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): unknown } };
}
export function createHandler(runtime: Runtime) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await request.json();
      if (!body || typeof body !== 'object') throw new Error('请求格式不正确。');
      let data: unknown;
      switch (body.action) {
        case 'bootstrap': data = runtime.bootstrap(); break;
        case 'models': data = await runtime.models(); break;
        case 'settings': data = await runtime.store.update(body.settings); break;
        case 'prompt-mode': data = await runtime.store.setPromptMode(body.mode); break;
        case 'refresh-prompt': data = await runtime.store.refreshPrompt(); break;
        case 'directory': {
          if (body.target === 'history') {
            await runtime.store.ensureDirectory();
            data = { directory: runtime.store.settings.directory };
          } else if (body.target === 'prompts') {
            const directory = dirname(runtime.store.settings.customPromptFile);
            await mkdir(directory, { recursive: true });
            data = { directory };
          } else throw new Error('不支持的目录类型。');
          break;
        }
        case 'start': data = await runtime.start(body.source); break;
        case 'events': return runtime.events(body.id, request.signal);
        case 'stop': data = await runtime.stop(body.id); break;
        case 'retry-save': data = await runtime.retrySave(); break;
        case 'history': data = await runtime.store.list(body.offset ?? 0, runtime.activeId); break;
        case 'read': data = runtime.active?.id === body.id ? runtime.active : await runtime.store.read(body.id, runtime.activeId); break;
        case 'delete': await runtime.delete(body.id); data = null; break;
        case 'clear': if (body.confirm !== true) throw new Error('请确认清空历史记录。'); data = await runtime.clear(); break;
        case 'migrate': data = await runtime.migrate(body.directory); break;
        default: throw new Error('不支持的翻译操作。');
      }
      return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = code === 'ENOENT' ? '记录或目录已不存在，请刷新后重试。' : code === 'ENOSPC' ? '磁盘空间不足，无法保存。' : ['EACCES', 'EPERM'].includes(code ?? '') ? '无法读写文件，请检查目录权限或文件占用。' : error instanceof Error ? error.message : '操作失败，请重试。';
      return Response.json({ error: { message } }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
export async function apply(ctx: HostContext, _config = {}, store = new Store()) {
  await store.init(); const runtime = new Runtime(store, ctx.llm);
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(runtime) });
  ctx.effect(() => () => runtime.dispose(), 'translate: lifetime');
}
