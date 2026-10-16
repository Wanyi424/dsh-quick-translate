import { randomUUID } from 'node:crypto';
import { MAX_OUTPUT, MAX_SOURCE, type Model, type StreamEvent, type Translation, type Usage } from './contracts';
import { DEFAULT_PROMPT } from './prompts';
import { Store } from './storage';

export interface LlmChunk {
  type: string; index?: number; text?: string; blockType?: string; block?: { type: string; text?: string };
  usage?: Usage; reason?: { kind: string; failure?: { message: string; code?: string } };
}
export interface Llm {
  listProviders(): { id: string; name: string }[];
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>;
  stream(options: { provider: string; model: string; messages: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: string } }[]; system: string; purpose: string; signal: AbortSignal }): AsyncIterable<LlmChunk>;
}
interface Job { record: Translation; abort: AbortController; running: boolean; done: Promise<void> }
function nextWithSignal<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export class Runtime {
  private job: Job | null = null;
  private listeners = new Set<() => void>();
  private notification?: ReturnType<typeof setTimeout>;
  private mutation: Promise<unknown> = Promise.resolve();
  private closed = false;
  private catalog: Model[] = [];
  private catalogPending?: Promise<{ models: Model[]; warnings: string[] }>;
  constructor(readonly store: Store, private llm: Llm, private timeoutMs = 10 * 60_000) {}
  get active() { return this.job ? { ...this.job.record } : null; }
  get running() { return this.job?.running ?? false; }
  get activeId() { return this.running ? this.job!.record.id : undefined; }
  bootstrap() { return { settings: this.store.settings, active: this.active, defaultPrompt: DEFAULT_PROMPT }; }
  models() {
    if (this.catalogPending) return this.catalogPending;
    this.catalogPending = (async () => {
      const providers = this.llm.listProviders(), models: Model[] = [], warnings: string[] = [];
      // Catalog calls use the provider's already configured models, never credentials or arbitrary URLs.
      const results = await Promise.allSettled(providers.map(async p => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([this.llm.listModels(p.id), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('模型列表读取超时')), 10_000); })]); }
        finally { clearTimeout(timer); }
      }));
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') for (const m of result.value) models.push({ provider: m.provider, id: m.id, name: m.name, providerName: providers[i].name });
        else warnings.push(`${providers[i].name} 的模型列表暂时不可用，请在 DSH 设置中检查后刷新。`);
      });
      this.catalog = models; return { models, warnings };
    })().finally(() => { this.catalogPending = undefined; });
    return this.catalogPending;
  }
  private exclusive<T>(fn: () => Promise<T>) { const work = this.mutation.then(fn); this.mutation = work.catch(() => {}); return work; }
  private requireIdle() { if (this.running) throw new Error('请等待当前翻译完成或先停止翻译。'); }
  start(source: string) {
    return this.exclusive(async () => {
      if (this.closed) throw new Error('插件正在关闭。');
      this.requireIdle();
      if (this.job?.record.saveError) throw new Error('上一条翻译尚未保存，请先重试保存或复制结果。');
      if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE) throw new Error('请输入需要翻译的内容，最多 60,000 字符。');
      const config = await this.store.refreshPrompt();
      if (!this.catalog.length) await this.models();
      const model = this.catalog.find(m => m.provider === config.provider && m.id === config.model);
      if (!model) throw new Error('请选择可用的 DSH 模型；如刚修改配置，请刷新模型列表。');
      const now = new Date().toISOString();
      const record: Translation = { id: `${Date.now()}-${randomUUID()}`, createdAt: now, updatedAt: now, source, result: '', provider: config.provider, model: config.model, modelName: model.name, prompt: config.prompt, status: 'running', phase: 'connecting' };
      await this.store.save(record); // Refuse a paid request when its input cannot be persisted.
      if (this.closed) throw new Error('插件正在关闭。');
      const job: Job = { record, abort: new AbortController(), running: true, done: Promise.resolve() };
      this.job = job; job.done = this.run(job); return { ...record };
    });
  }
  private notify(immediate = false) {
    if (immediate) { clearTimeout(this.notification); this.notification = undefined; for (const fn of this.listeners) fn(); return; }
    if (!this.notification && this.listeners.size) this.notification = setTimeout(() => { this.notification = undefined; for (const fn of this.listeners) fn(); }, 80);
  }
  private async run(job: Job) {
    const r = job.record, abort = job.abort, blocks = new Map<number, string>();
    let iterator: AsyncIterator<LlmChunk> | undefined;
    let lastSave = Date.now(), finished = false;
    const timeout = setTimeout(() => abort.abort(new Error('翻译已超过 10 分钟，已停止并保留现有内容。')), this.timeoutMs);
    const since = () => Date.now() - Date.parse(r.createdAt);
    try {
      const stream = this.llm.stream({ provider: r.provider, model: r.model, messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: r.source }], source: { kind: 'dsh-quick-translate' } }], system: r.prompt, purpose: 'quick-translate', signal: abort.signal });
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await nextWithSignal(iterator, abort.signal);
        if (next.done) break;
        const c = next.value, index = c.index ?? 0;
        // DSH sends usage once, just before finish; the final save below persists it.
        if (c.type === 'usage' && c.usage) { r.usage = { ...c.usage }; continue; }
        if (c.type === 'text-delta' && typeof c.text === 'string') { blocks.set(index, (blocks.get(index) ?? '') + c.text); r.phase = 'translating'; }
        else if (c.type === 'block-end' && c.block?.type === 'text') { blocks.set(index, c.block.text ?? ''); r.phase = 'translating'; }
        else if (c.type === 'reasoning-delta' && r.phase !== 'translating') r.phase = 'thinking';
        else if (c.type === 'finish') {
          finished = true;
          if (c.reason?.failure?.code) r.errorCode = c.reason.failure.code;
          if (c.reason?.kind !== 'stop') throw new Error(c.reason?.kind === 'max-tokens' ? '模型已达到输出长度上限，译文可能不完整。' : c.reason?.failure?.message || '模型未正常完成翻译。');
          break;
        }
        // Phase changes mark the timeline: first token of any kind, then the first translated text.
        if (r.phase !== 'connecting') r.firstTokenMs ??= since();
        if (r.phase === 'translating') r.firstTextMs ??= since();
        const text = [...blocks.values()].join('');
        if (text.length > MAX_OUTPUT) { r.result = text.slice(0, MAX_OUTPUT); throw new Error('译文达到 240,000 字符上限，已停止。'); }
        r.result = text; r.updatedAt = new Date().toISOString(); this.notify();
        if (Date.now() - lastSave >= 2000) { await this.store.save(r); lastSave = Date.now(); }
      }
      if (!finished) throw new Error('模型连接提前结束，译文可能不完整。');
      if (!r.result.trim()) throw new Error('模型没有返回译文。');
      r.status = 'completed';
    } catch (error) {
      r.status = abort.signal.aborted ? 'stopped' : 'failed';
      r.error = error instanceof Error ? error.message : '翻译失败，请检查模型配置后重试。';
      if (!abort.signal.aborted) abort.abort(error);
    } finally {
      clearTimeout(timeout);
      // A misbehaving adapter must not keep the Stop button or plugin shutdown pending.
      if (iterator?.return) void Promise.resolve().then(() => iterator!.return!()).catch(() => {});
      r.updatedAt = new Date().toISOString();
      try { await this.store.save(r); } catch { r.saveError = '历史记录保存失败。请保留页面、复制译文或重试保存。'; }
      job.running = false; this.notify(true);
    }
  }
  async stop(id: string) {
    const job = this.job;
    if (!job || id !== job.record.id) throw new Error('该翻译任务已不存在。');
    if (job.running) { job.abort.abort(new Error('已手动停止，保留已输出的内容。')); await job.done; }
    return this.active;
  }
  async retrySave() {
    return this.exclusive(async () => {
      this.requireIdle(); if (!this.job) return null;
      const record = { ...this.job.record }; delete record.saveError;
      await this.store.save(record); this.job.record = record; return this.active;
    });
  }
  migrate(directory: string) { return this.exclusive(async () => { this.requireIdle(); if (this.job?.record.saveError) throw new Error('请先重试保存当前译文。'); return this.store.migrate(directory); }); }
  delete(id: string) { return this.exclusive(async () => { if (id === this.activeId) this.requireIdle(); await this.store.delete(id); if (this.job?.record.id === id) this.job = null; }); }
  clear() { return this.exclusive(async () => { this.requireIdle(); const count = await this.store.clear(); this.job = null; return count; }); }
  events(id: string, signal: AbortSignal): Response {
    const job = this.job;
    if (!job || job.record.id !== id) throw new Error('翻译任务已结束，请从历史记录中查看。');
    const encoder = new TextEncoder(); let controller: ReadableStreamDefaultController<Uint8Array>;
    let sent = '', lastPhase: Translation['phase'], initial = true, closed = false;
    const cleanup = () => { this.listeners.delete(pump); signal.removeEventListener('abort', cancel); };
    const cancel = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
    const pump = () => {
      if (closed || controller.desiredSize! <= 0) return;
      const r = job.record;
      if (!initial && job.running && r.result === sent && r.phase === lastPhase) return;
      const event: StreamEvent = initial ? { type: 'snapshot', record: { ...r } } : !job.running ? { type: 'done', record: { ...r } } : { type: 'update', ...(r.result.startsWith(sent) ? { delta: r.result.slice(sent.length) } : { result: r.result }), phase: r.phase, updatedAt: r.updatedAt };
      initial = false; sent = r.result; lastPhase = r.phase;
      controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      if (!job.running) cancel();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); },
      pull: pump,
      cancel: () => { closed = true; cleanup(); },
    });
    if (!closed) this.listeners.add(pump);
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' } });
  }
  async dispose() { this.closed = true; if (this.job?.running) await this.stop(this.job.record.id); clearTimeout(this.notification); this.listeners.clear(); }
}
