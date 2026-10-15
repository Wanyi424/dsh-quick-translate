import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MAX_PROMPT, type HistoryPage, type Migration, type PromptMode, type Settings, type SettingsUpdate, type Translation } from './contracts';
import { DEFAULT_PROMPT, DEFAULT_PROMPT_FILE } from './prompts';
import { translationDataDirectory } from './data-paths';

const ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const owned = (name: string) => name.endsWith('.json') && ID.test(name.slice(0, -5));
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export async function atomicText(file: string, text: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx', encoding: 'utf8' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
}
export async function atomicJson(file: string, value: unknown) { await atomicText(file, JSON.stringify(value, null, 2) + '\n'); }
export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private config!: Settings;
  constructor(readonly settingsFile = join(translationDataDirectory(), 'settings.json'), private defaultDirectory = join(dirname(settingsFile), 'history')) {}
  get settings(): Settings { return { ...this.config }; }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation); this.tail = next.catch(() => {}); return next;
  }
  async init() {
    let saved: Partial<Pick<Settings, 'directory' | 'provider' | 'model' | 'promptMode'>> = {};
    try { saved = JSON.parse(await readFile(this.settingsFile, 'utf8')); } catch (error) { if (!missing(error)) throw error; }
    const directory = saved.directory ?? this.defaultDirectory;
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('历史记录目录配置无效。');
    const customPromptFile = join(dirname(this.settingsFile), 'prompts', 'custom.md');
    const mode: PromptMode = saved.promptMode === 'custom' ? 'custom' : 'default';
    this.config = { directory: resolve(directory), prompt: DEFAULT_PROMPT, provider: typeof saved.provider === 'string' ? saved.provider : '', model: typeof saved.model === 'string' ? saved.model : '', promptMode: mode, defaultPromptFile: DEFAULT_PROMPT_FILE, customPromptFile, hasCustomPrompt: false };
    try { await this.readPrompt(); }
    catch (error) { this.config.prompt = ''; this.config.promptError = error instanceof Error ? error.message : '无法读取自定义提示词，请恢复默认。'; }
    // No history-folder creation or record scan during startup.
  }
  async ensureDirectory() { await mkdir(this.config.directory, { recursive: true }); }
  private async commit(config: Settings) {
    await mkdir(dirname(this.settingsFile), { recursive: true });
    await atomicJson(this.settingsFile, { version: 2, directory: config.directory, provider: config.provider, model: config.model, promptMode: config.promptMode }); this.config = config;
  }
  private validatePrompt(text: unknown): asserts text is string {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT) throw new Error('请填写有效的提示词，最多 16,000 字符。');
  }
  private async readCustom(): Promise<string | undefined> {
    try {
      const info = await lstat(this.config.customPromptFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROMPT * 4) throw new Error('自定义提示词必须是普通 UTF-8 Markdown 文件，最多 16,000 字符。');
      return await readFile(this.config.customPromptFile, 'utf8');
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  private async readPrompt() {
    let custom: string | undefined;
    try { custom = await this.readCustom(); } catch (error) { if (this.config.promptMode === 'custom') throw error; }
    let prompt = DEFAULT_PROMPT;
    if (this.config.promptMode === 'custom') {
      if (custom === undefined) throw new Error(`自定义提示词文件不存在：${this.config.customPromptFile}。请在翻译设置中恢复默认。`);
      this.validatePrompt(custom); prompt = custom;
    }
    this.config = { ...this.config, prompt, hasCustomPrompt: custom !== undefined, promptError: undefined }; return this.settings;
  }
  refreshPrompt() { return this.serial(() => this.readPrompt()); }
  setPromptMode(mode: PromptMode) {
    return this.serial(async () => {
      if (mode !== 'default' && mode !== 'custom') throw new Error('提示词来源无效。');
      const custom = mode === 'custom' ? await this.readCustom() : undefined;
      if (mode === 'custom') { if (custom === undefined) throw new Error('还没有已保存的自定义提示词。'); this.validatePrompt(custom); }
      await this.commit({ ...this.config, promptMode: mode, prompt: mode === 'custom' ? custom! : DEFAULT_PROMPT, promptError: undefined });
      return this.settings;
    });
  }
  update(input: SettingsUpdate) {
    return this.serial(async () => {
      if (!input || typeof input !== 'object') throw new Error('设置格式不正确。');
      for (const key of ['provider', 'model'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 500)) throw new Error('模型配置无效。');
      const next = { ...this.config, provider: input.provider ?? this.config.provider, model: input.model ?? this.config.model };
      if (input.prompt !== undefined) {
        this.validatePrompt(input.prompt);
        // Only an explicit prompt save writes custom.md; changing model never touches it.
        const previous = await this.readCustom();
        await mkdir(dirname(next.customPromptFile), { recursive: true });
        await atomicText(next.customPromptFile, input.prompt);
        next.prompt = input.prompt; next.promptMode = 'custom'; next.hasCustomPrompt = true; next.promptError = undefined;
        try { await this.commit(next); }
        catch (error) { if (previous === undefined) await unlink(next.customPromptFile); else await atomicText(next.customPromptFile, previous); throw error; }
      } else await this.commit(next);
      return this.settings;
    });
  }
  private file(id: string) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('历史记录编号无效。');
    return join(this.config.directory, `${id}.json`);
  }
  private async readRecord(id: string): Promise<Translation> {
    const file = this.file(id), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('记录文件无效或过大。');
    const record = JSON.parse(await readFile(file, 'utf8')) as Translation;
    if (!record || record.id !== id || typeof record.source !== 'string' || typeof record.result !== 'string' || typeof record.prompt !== 'string' || typeof record.createdAt !== 'string' || typeof record.model !== 'string' || typeof record.provider !== 'string' || typeof record.modelName !== 'string' || !['running', 'completed', 'stopped', 'failed', 'interrupted'].includes(record.status)) throw new Error('记录文件格式无效。');
    return record;
  }
  read(id: string, activeId?: string) {
    return this.serial(async () => {
      const record = await this.readRecord(id);
      if (record.status === 'running' && id !== activeId) return { ...record, status: 'interrupted' as const, error: '上次翻译被中断，已保留最后保存的内容。' };
      return record;
    });
  }
  save(record: Translation) {
    const snapshot = structuredClone(record);
    return this.serial(async () => {
      await this.ensureDirectory();
      const file = this.file(snapshot.id);
      try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('不能覆盖非普通文件。'); } catch (error) { if (!missing(error)) throw error; }
      await atomicJson(file, snapshot);
    });
  }
  list(offset = 0, activeId?: string): Promise<HistoryPage> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('分页位置无效。');
      let files: string[];
      try { files = (await readdir(this.config.directory, { withFileTypes: true })).filter(e => e.isFile() && owned(e.name)).map(e => e.name).sort().reverse(); }
      catch (error) { if (missing(error)) return { items: [], total: 0, next: null, warnings: [] }; throw error; }
      const items: HistoryPage['items'] = [], warnings: string[] = [];
      for (const file of files.slice(offset, offset + 25)) {
        try {
          const r = await this.readRecord(file.slice(0, -5));
          items.push({ id: r.id, createdAt: r.createdAt, title: r.source.replace(/\s+/g, ' ').slice(0, 72), status: r.status === 'running' && r.id !== activeId ? 'interrupted' : r.status, modelName: r.modelName });
        } catch { warnings.push(`${file} 无法读取，原文件已保留。`); }
      }
      return { items, total: files.length, next: offset + 25 < files.length ? offset + 25 : null, warnings };
    });
  }
  delete(id: string) {
    return this.serial(async () => { await this.readRecord(id); await unlink(this.file(id)); });
  }
  clear() {
    return this.serial(async () => {
      let entries;
      try { entries = await readdir(this.config.directory, { withFileTypes: true }); } catch (error) { if (missing(error)) return 0; throw error; }
      let count = 0;
      for (const e of entries) if (e.isFile() && owned(e.name)) { await unlink(join(this.config.directory, e.name)); count++; }
      return count;
    });
  }
  migrate(input: string): Promise<Migration> {
    return this.serial(async () => {
      if (typeof input !== 'string' || !isAbsolute(input.trim())) throw new Error('请选择或输入完整的绝对目录路径。');
      const source = resolve(this.config.directory), requested = resolve(input.trim());
      const inside = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
      if (relative(source, requested) === '') return { directory: source, moved: 0, oldDirectoryRemoved: false, warnings: [] };
      if ([source, requested].some(p => p === parse(p).root || relative(p, homedir()) === '')) throw new Error('请使用专门的历史记录文件夹，不能使用磁盘根目录或用户主目录。');
      if (inside(source, requested) || inside(requested, source)) throw new Error('新旧目录不能互为父子目录。');
      await mkdir(source, { recursive: true });
      if ((await lstat(source)).isSymbolicLink()) throw new Error('旧目录不能是链接或联接点。');
      let created = false;
      try { await mkdir(requested); created = true; } catch (error) {
        if (missing(error)) { await mkdir(requested, { recursive: true }); created = true; }
        else if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const copies: string[] = []; let committed = false;
      try {
        const info = await lstat(requested);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('新目录必须是普通文件夹。');
        const [realSource, target] = await Promise.all([realpath(source), realpath(requested)]);
        if (inside(realSource, target) || inside(target, realSource)) throw new Error('新旧目录实际指向相同位置或互为父子目录。');
        if (inside(realSource, resolve(this.settingsFile)) || inside(target, resolve(this.settingsFile))) throw new Error('历史记录目录不能包含插件设置文件。');
        const entries = (await readdir(source, { withFileTypes: true })).filter(e => e.isFile() && owned(e.name));
        const names = new Set((await readdir(target)).map(n => process.platform === 'win32' ? n.toLowerCase() : n));
        if (entries.some(e => names.has(process.platform === 'win32' ? e.name.toLowerCase() : e.name))) throw new Error('目标目录已有同名记录，请选择其他目录，原记录未改动。');
        const originals: { name: string; size: number; mtimeMs: number }[] = [];
        for (const e of entries) {
          const from = join(source, e.name), to = join(target, e.name), before = await lstat(from);
          if (!before.isFile() || before.isSymbolicLink()) throw new Error('迁移期间文件发生变化，请重试。');
          await copyFile(from, to, constants.COPYFILE_EXCL); copies.push(to);
          const after = await lstat(from), dest = await lstat(to);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || dest.size !== before.size) throw new Error('复制期间记录被修改，已停止迁移。');
          originals.push({ name: e.name, size: before.size, mtimeMs: before.mtimeMs });
        }
        await this.commit({ ...this.config, directory: target }); committed = true;
        const warnings: string[] = [];
        for (const original of originals) {
          try {
            const path = join(source, original.name), now = await lstat(path);
            if (!now.isFile() || now.isSymbolicLink() || now.size !== original.size || now.mtimeMs !== original.mtimeMs) { warnings.push(`${original.name} 在迁移期间被修改，已保留旧副本。`); continue; }
            await unlink(path);
          } catch (error) { if (!missing(error)) warnings.push(`${original.name} 的旧副本暂时无法删除。`); }
        }
        let oldDirectoryRemoved = false;
        // Never recursive: unrelated files and subdirectories remain untouched.
        try { await rmdir(source); oldDirectoryRemoved = true; } catch { warnings.push('旧目录还有其他内容或暂时无法删除，已保留旧目录。'); }
        return { directory: target, moved: originals.length, oldDirectoryRemoved, warnings };
      } catch (error) {
        if (!committed) { for (const path of copies) await unlink(path).catch(() => {}); if (created) await rmdir(requested).catch(() => {}); }
        throw error;
      }
    });
  }
}
