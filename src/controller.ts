import { openDirectory, readEvents, request } from './api';
import { type Bootstrap, type HistoryPage, type Migration, type Model, type PromptMode, type Settings, type SettingsUpdate, type Translation } from './contracts';
export interface ViewState {
  loaded: boolean; busy: boolean; draft: string; current: Translation | null; selected: Translation | null;
  settings: Settings | null; defaultPrompt: string; models: Model[]; modelWarnings: string[]; refreshingModels: boolean;
  history: HistoryPage; loadingMore: boolean; error: string; notice: string; connected: boolean;
}
export class Controller {
  private state: ViewState = { loaded: false, busy: false, draft: '', current: null, selected: null, settings: null, defaultPrompt: '', models: [], modelWarnings: [], refreshingModels: false, history: { items: [], total: 0, next: null, warnings: [] }, loadingMore: false, error: '', notice: '', connected: false };
  private listeners = new Set<() => void>();
  private stream?: AbortController;
  private attached = false;
  private generation = 0;
  // Reads never take the busy lock; sequence numbers make the latest request win instead.
  private historySeq = 0;
  private viewSeq = 0;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  private patch(patch: Partial<ViewState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  get running() { return this.state.current?.status === 'running'; }
  setDraft(draft: string) { this.patch({ draft }); }
  dismissError = () => { if (this.state.error) this.patch({ error: '' }); };
  dismissNotice = () => { if (this.state.notice) this.patch({ notice: '' }); };
  report = (error: unknown) => { this.patch({ error: error instanceof Error ? error.message : String(error) }); };
  /** Serializes mutations. Dialogs pass quiet so the error is shown in place rather than in the page banner. */
  async perform<T>(fn: () => Promise<T>, quiet = false): Promise<T | undefined> {
    if (this.state.busy) return;
    this.patch({ busy: true, error: '' });
    try { return await fn(); } catch (error) { if (!quiet) this.report(error); throw error; } finally { this.patch({ busy: false }); }
  }
  attach() { this.attached = true; void this.reload().catch(this.report); return () => { this.attached = false; this.generation++; this.stream?.abort(); this.patch({ connected: false }); }; }
  async reload() {
    const generation = ++this.generation;
    const data = await request<Bootstrap>({ action: 'bootstrap' });
    if (!this.attached || generation !== this.generation) return;
    this.patch({ settings: data.settings, defaultPrompt: data.defaultPrompt, current: data.active, loaded: true, ...(!this.state.loaded && data.active ? { draft: data.active.source } : {}) });
    if (data.active?.status === 'running') this.connect(data.active.id);
    await Promise.all([this.refreshModels(), this.history()]);
  }
  async refreshModels() {
    this.patch({ refreshingModels: true });
    try {
      const result = await request<{ models: Model[]; warnings: string[] }>({ action: 'models' });
      this.patch({ models: result.models, modelWarnings: result.warnings });
    } finally { this.patch({ refreshingModels: false }); }
  }
  async history() {
    const seq = ++this.historySeq, history = await request<HistoryPage>({ action: 'history', offset: 0 });
    if (seq === this.historySeq) this.patch({ history });
  }
  async loadMore() {
    const { next } = this.state.history, seq = this.historySeq;
    if (next === null || this.state.loadingMore) return;
    this.patch({ loadingMore: true });
    try {
      const page = await request<HistoryPage>({ action: 'history', offset: next });
      if (seq === this.historySeq) this.patch({ history: { ...page, items: [...this.state.history.items, ...page.items] } });
    } catch (error) { this.report(error); } finally { this.patch({ loadingMore: false }); }
  }
  async saveSettings(settings: SettingsUpdate) {
    const saved = await request<Settings>({ action: 'settings', settings }); this.patch({ settings: saved }); return saved;
  }
  async start() {
    const current = await request<Translation>({ action: 'start', source: this.state.draft });
    this.viewSeq++; this.patch({ current, selected: null, notice: '' }); this.connect(current.id); await this.history();
  }
  private connect(id: string) {
    this.stream?.abort(); if (!this.attached) return;
    const abort = this.stream = new AbortController(); this.patch({ connected: true });
    void readEvents(id, abort.signal, event => {
      if (abort.signal.aborted) return;
      if (event.type === 'snapshot' || event.type === 'done') this.patch({ current: event.record });
      else if (this.state.current?.id === id) this.patch({ current: { ...this.state.current, result: event.result ?? this.state.current.result + (event.delta ?? ''), phase: event.phase, updatedAt: event.updatedAt } });
    }).then(async () => {
      if (abort.signal.aborted) return;
      if (this.state.current?.status === 'running') throw new Error('实时连接已断开，后台翻译可能仍在进行。');
      await this.history();
    }).catch(error => { if (!abort.signal.aborted) this.report(error); }).finally(() => { if (this.stream === abort) this.patch({ connected: false }); });
  }
  async stop() { if (!this.state.current) return; const current = await request<Translation>({ action: 'stop', id: this.state.current.id }); this.patch({ current }); await this.history(); }
  async retrySave() { const current = await request<Translation>({ action: 'retry-save' }); this.patch({ current, notice: '历史记录已保存' }); await this.history(); }
  /** Reads a record without changing what the page shows (copy or reuse from the history list). */
  read(id: string) { return id === this.state.current?.id ? Promise.resolve(this.state.current) : request<Translation>({ action: 'read', id }); }
  async open(id: string) {
    const seq = ++this.viewSeq;
    if (id === this.state.current?.id) { this.patch({ selected: null }); return; }
    const selected = await request<Translation>({ action: 'read', id });
    if (seq === this.viewSeq) this.patch({ selected });
  }
  showCurrent() { this.viewSeq++; if (this.state.selected) this.patch({ selected: null }); }
  newTranslation(source = '') { this.viewSeq++; this.patch({ draft: source, selected: null, ...(!this.running ? { current: null } : {}) }); }
  async remove(id: string) {
    await request({ action: 'delete', id });
    this.patch({ ...(this.state.selected?.id === id ? { selected: null } : {}), ...(this.state.current?.id === id ? { current: null, draft: '' } : {}), notice: '已删除这条记录' }); await this.history();
  }
  async clear() { await request({ action: 'clear', confirm: true }); this.patch({ selected: null, current: null, draft: '', notice: '历史记录已清空' }); await this.history(); }
  async migrate(directory: string) {
    const result = await request<Migration>({ action: 'migrate', directory });
    this.patch({ settings: { ...this.state.settings!, directory: result.directory }, notice: `已迁移 ${result.moved} 条记录。${result.oldDirectoryRemoved ? '旧目录已删除。' : ''}${result.warnings.join(' ')}` }); await this.history(); return result;
  }
  async openDirectory() { await openDirectory('history'); }
  async switchPrompt(mode: PromptMode) {
    const settings = await request<Settings>({ action: 'prompt-mode', mode }); this.patch({ settings }); return settings;
  }
  async refreshPrompt() {
    const settings = await request<Settings>({ action: 'refresh-prompt' }); this.patch({ settings }); return settings;
  }
  async openPrompts() { await openDirectory('prompts'); }
}
