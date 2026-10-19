// src/contracts.ts
var API_PATH = "/api/translate";
var MAX_SOURCE = 6e4;
var MAX_PROMPT = 16e3;
var MAX_OUTPUT = 24e4;

// src/host.ts
import { dirname as dirname3 } from "node:path";
import { mkdir as mkdir2 } from "node:fs/promises";

// src/runtime.ts
import { randomUUID } from "node:crypto";

// src/prompts.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
var DEFAULT_PROMPT_FILE = fileURLToPath(new URL("../prompts/default.md", import.meta.url));
var DEFAULT_PROMPT = readFileSync(DEFAULT_PROMPT_FILE, "utf8");

// src/runtime.ts
function nextWithSignal(iterator, signal) {
  signal.throwIfAborted();
  return new Promise((resolve3, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(resolve3, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
var Runtime = class {
  constructor(store, llm, timeoutMs = 10 * 6e4) {
    this.store = store;
    this.llm = llm;
    this.timeoutMs = timeoutMs;
  }
  job = null;
  listeners = /* @__PURE__ */ new Set();
  notification;
  mutation = Promise.resolve();
  closed = false;
  catalog = [];
  catalogPending;
  get active() {
    return this.job ? { ...this.job.record } : null;
  }
  get running() {
    return this.job?.running ?? false;
  }
  get activeId() {
    return this.running ? this.job.record.id : void 0;
  }
  bootstrap() {
    return { settings: this.store.settings, active: this.active, defaultPrompt: DEFAULT_PROMPT };
  }
  models() {
    if (this.catalogPending) return this.catalogPending;
    this.catalogPending = (async () => {
      const providers = this.llm.listProviders(), models = [], warnings = [];
      const results = await Promise.allSettled(providers.map(async (p) => {
        let timer;
        try {
          return await Promise.race([this.llm.listModels(p.id), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("\u6A21\u578B\u5217\u8868\u8BFB\u53D6\u8D85\u65F6")), 1e4);
          })]);
        } finally {
          clearTimeout(timer);
        }
      }));
      results.forEach((result, i) => {
        if (result.status === "fulfilled") for (const m of result.value) models.push({ provider: m.provider, id: m.id, name: m.name, providerName: providers[i].name });
        else warnings.push(`${providers[i].name} \u7684\u6A21\u578B\u5217\u8868\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5728 DSH \u8BBE\u7F6E\u4E2D\u68C0\u67E5\u540E\u5237\u65B0\u3002`);
      });
      this.catalog = models;
      return { models, warnings };
    })().finally(() => {
      this.catalogPending = void 0;
    });
    return this.catalogPending;
  }
  exclusive(fn) {
    const work = this.mutation.then(fn);
    this.mutation = work.catch(() => {
    });
    return work;
  }
  requireIdle() {
    if (this.running) throw new Error("\u8BF7\u7B49\u5F85\u5F53\u524D\u7FFB\u8BD1\u5B8C\u6210\u6216\u5148\u505C\u6B62\u7FFB\u8BD1\u3002");
  }
  start(source) {
    return this.exclusive(async () => {
      if (this.closed) throw new Error("\u63D2\u4EF6\u6B63\u5728\u5173\u95ED\u3002");
      this.requireIdle();
      if (this.job?.record.saveError) throw new Error("\u4E0A\u4E00\u6761\u7FFB\u8BD1\u5C1A\u672A\u4FDD\u5B58\uFF0C\u8BF7\u5148\u91CD\u8BD5\u4FDD\u5B58\u6216\u590D\u5236\u7ED3\u679C\u3002");
      if (typeof source !== "string" || !source.trim() || source.length > MAX_SOURCE) throw new Error("\u8BF7\u8F93\u5165\u9700\u8981\u7FFB\u8BD1\u7684\u5185\u5BB9\uFF0C\u6700\u591A 60,000 \u5B57\u7B26\u3002");
      const config = await this.store.refreshPrompt();
      if (!this.catalog.length) await this.models();
      const model = this.catalog.find((m) => m.provider === config.provider && m.id === config.model);
      if (!model) throw new Error("\u8BF7\u9009\u62E9\u53EF\u7528\u7684 DSH \u6A21\u578B\uFF1B\u5982\u521A\u4FEE\u6539\u914D\u7F6E\uFF0C\u8BF7\u5237\u65B0\u6A21\u578B\u5217\u8868\u3002");
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const record = { id: `${Date.now()}-${randomUUID()}`, createdAt: now, updatedAt: now, source, result: "", provider: config.provider, model: config.model, modelName: model.name, prompt: config.prompt, status: "running", phase: "connecting" };
      await this.store.save(record);
      if (this.closed) throw new Error("\u63D2\u4EF6\u6B63\u5728\u5173\u95ED\u3002");
      const job = { record, abort: new AbortController(), running: true, done: Promise.resolve() };
      this.job = job;
      job.done = this.run(job);
      return { ...record };
    });
  }
  notify(immediate = false) {
    if (immediate) {
      clearTimeout(this.notification);
      this.notification = void 0;
      for (const fn of this.listeners) fn();
      return;
    }
    if (!this.notification && this.listeners.size) this.notification = setTimeout(() => {
      this.notification = void 0;
      for (const fn of this.listeners) fn();
    }, 80);
  }
  async run(job) {
    const r = job.record, abort = job.abort, blocks = /* @__PURE__ */ new Map();
    let iterator;
    let lastSave = Date.now(), finished = false;
    const timeout = setTimeout(() => abort.abort(new Error("\u7FFB\u8BD1\u5DF2\u8D85\u8FC7 10 \u5206\u949F\uFF0C\u5DF2\u505C\u6B62\u5E76\u4FDD\u7559\u73B0\u6709\u5185\u5BB9\u3002")), this.timeoutMs);
    const since = () => Date.now() - Date.parse(r.createdAt);
    try {
      const stream = this.llm.stream({ provider: r.provider, model: r.model, messages: [{ id: randomUUID(), role: "user", content: [{ type: "text", text: r.source }], source: { kind: "dsh-translate" } }], system: r.prompt, purpose: "translate", signal: abort.signal });
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await nextWithSignal(iterator, abort.signal);
        if (next.done) break;
        const c = next.value, index = c.index ?? 0;
        if (c.type === "usage" && c.usage) {
          r.usage = { ...c.usage };
          continue;
        }
        if (c.type === "text-delta" && typeof c.text === "string") {
          blocks.set(index, (blocks.get(index) ?? "") + c.text);
          r.phase = "translating";
        } else if (c.type === "block-end" && c.block?.type === "text") {
          blocks.set(index, c.block.text ?? "");
          r.phase = "translating";
        } else if (c.type === "reasoning-delta" && r.phase !== "translating") r.phase = "thinking";
        else if (c.type === "finish") {
          finished = true;
          if (c.reason?.failure?.code) r.errorCode = c.reason.failure.code;
          if (c.reason?.kind !== "stop") throw new Error(c.reason?.kind === "max-tokens" ? "\u6A21\u578B\u5DF2\u8FBE\u5230\u8F93\u51FA\u957F\u5EA6\u4E0A\u9650\uFF0C\u8BD1\u6587\u53EF\u80FD\u4E0D\u5B8C\u6574\u3002" : c.reason?.failure?.message || "\u6A21\u578B\u672A\u6B63\u5E38\u5B8C\u6210\u7FFB\u8BD1\u3002");
          break;
        }
        if (r.phase !== "connecting") r.firstTokenMs ??= since();
        if (r.phase === "translating") r.firstTextMs ??= since();
        const text = [...blocks.values()].join("");
        if (text.length > MAX_OUTPUT) {
          r.result = text.slice(0, MAX_OUTPUT);
          throw new Error("\u8BD1\u6587\u8FBE\u5230 240,000 \u5B57\u7B26\u4E0A\u9650\uFF0C\u5DF2\u505C\u6B62\u3002");
        }
        r.result = text;
        r.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        this.notify();
        if (Date.now() - lastSave >= 2e3) {
          await this.store.save(r);
          lastSave = Date.now();
        }
      }
      if (!finished) throw new Error("\u6A21\u578B\u8FDE\u63A5\u63D0\u524D\u7ED3\u675F\uFF0C\u8BD1\u6587\u53EF\u80FD\u4E0D\u5B8C\u6574\u3002");
      if (!r.result.trim()) throw new Error("\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u8BD1\u6587\u3002");
      r.status = "completed";
    } catch (error) {
      r.status = abort.signal.aborted ? "stopped" : "failed";
      r.error = error instanceof Error ? error.message : "\u7FFB\u8BD1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6A21\u578B\u914D\u7F6E\u540E\u91CD\u8BD5\u3002";
      if (!abort.signal.aborted) abort.abort(error);
    } finally {
      clearTimeout(timeout);
      if (iterator?.return) void Promise.resolve().then(() => iterator.return()).catch(() => {
      });
      r.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      try {
        await this.store.save(r);
      } catch {
        r.saveError = "\u5386\u53F2\u8BB0\u5F55\u4FDD\u5B58\u5931\u8D25\u3002\u8BF7\u4FDD\u7559\u9875\u9762\u3001\u590D\u5236\u8BD1\u6587\u6216\u91CD\u8BD5\u4FDD\u5B58\u3002";
      }
      job.running = false;
      this.notify(true);
    }
  }
  async stop(id) {
    const job = this.job;
    if (!job || id !== job.record.id) throw new Error("\u8BE5\u7FFB\u8BD1\u4EFB\u52A1\u5DF2\u4E0D\u5B58\u5728\u3002");
    if (job.running) {
      job.abort.abort(new Error("\u5DF2\u624B\u52A8\u505C\u6B62\uFF0C\u4FDD\u7559\u5DF2\u8F93\u51FA\u7684\u5185\u5BB9\u3002"));
      await job.done;
    }
    return this.active;
  }
  async retrySave() {
    return this.exclusive(async () => {
      this.requireIdle();
      if (!this.job) return null;
      const record = { ...this.job.record };
      delete record.saveError;
      await this.store.save(record);
      this.job.record = record;
      return this.active;
    });
  }
  migrate(directory) {
    return this.exclusive(async () => {
      this.requireIdle();
      if (this.job?.record.saveError) throw new Error("\u8BF7\u5148\u91CD\u8BD5\u4FDD\u5B58\u5F53\u524D\u8BD1\u6587\u3002");
      return this.store.migrate(directory);
    });
  }
  delete(id) {
    return this.exclusive(async () => {
      if (id === this.activeId) this.requireIdle();
      await this.store.delete(id);
      if (this.job?.record.id === id) this.job = null;
    });
  }
  clear() {
    return this.exclusive(async () => {
      this.requireIdle();
      const count = await this.store.clear();
      this.job = null;
      return count;
    });
  }
  events(id, signal) {
    const job = this.job;
    if (!job || job.record.id !== id) throw new Error("\u7FFB\u8BD1\u4EFB\u52A1\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u4ECE\u5386\u53F2\u8BB0\u5F55\u4E2D\u67E5\u770B\u3002");
    const encoder = new TextEncoder();
    let controller;
    let sent = "", lastPhase, initial = true, closed = false;
    const cleanup = () => {
      this.listeners.delete(pump);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      if (closed) return;
      closed = true;
      cleanup();
      try {
        controller.close();
      } catch {
      }
    };
    const pump = () => {
      if (closed || controller.desiredSize <= 0) return;
      const r = job.record;
      if (!initial && job.running && r.result === sent && r.phase === lastPhase) return;
      const event = initial ? { type: "snapshot", record: { ...r } } : !job.running ? { type: "done", record: { ...r } } : { type: "update", ...r.result.startsWith(sent) ? { delta: r.result.slice(sent.length) } : { result: r.result }, phase: r.phase, updatedAt: r.updatedAt };
      initial = false;
      sent = r.result;
      lastPhase = r.phase;
      controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      if (!job.running) cancel();
    };
    const stream = new ReadableStream({
      start(c) {
        controller = c;
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      },
      pull: pump,
      cancel: () => {
        closed = true;
        cleanup();
      }
    });
    if (!closed) this.listeners.add(pump);
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" } });
  }
  async dispose() {
    this.closed = true;
    if (this.job?.running) await this.stop(this.job.record.id);
    clearTimeout(this.notification);
    this.listeners.clear();
  }
};

// src/storage.ts
import { constants, existsSync as existsSync2 } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, join as join2, parse, relative, resolve as resolve2, sep } from "node:path";
import { homedir as homedir2 } from "node:os";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/data-paths.ts
import { existsSync, renameSync } from "node:fs";

// node_modules/@deepseek-ai/dsh-home-paths/lib/index.js
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
var DSH_HOME_DIR_NAME = ".dsh";
var DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`;
var DSH_HOME_ENV = "DSH_HOME";
function defaultDshHome() {
  return join(homedir(), DSH_HOME_DIR_NAME);
}
function expandHomePath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV];
  return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())));
}
function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}

// src/data-paths.ts
function legacyTranslationDataDirectory() {
  return dshHomePath("plugin-data", "dsh-quick-translate");
}
function translationDataDirectory() {
  const current = dshHomePath("plugin-data", "dsh-translate");
  const legacy = legacyTranslationDataDirectory();
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      return legacy;
    }
  }
  return current;
}

// src/storage.ts
var ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var owned = (name2) => name2.endsWith(".json") && ID.test(name2.slice(0, -5));
var missing = (error) => error.code === "ENOENT";
var line = (text) => text.replace(/\s+/g, " ").trim().slice(0, 80);
async function atomicText(file, text) {
  const temp = `${file}.${randomUUID2()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", encoding: "utf8" });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
async function atomicJson(file, value) {
  await atomicText(file, JSON.stringify(value, null, 2) + "\n");
}
var Store = class {
  constructor(settingsFile = join2(translationDataDirectory(), "settings.json"), defaultDirectory = join2(dirname2(settingsFile), "history")) {
    this.settingsFile = settingsFile;
    this.defaultDirectory = defaultDirectory;
  }
  tail = Promise.resolve();
  config;
  get settings() {
    return { ...this.config };
  }
  serial(operation) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {
    });
    return next;
  }
  async init() {
    let saved = {};
    try {
      saved = JSON.parse(await readFile(this.settingsFile, "utf8"));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    let directory = saved.directory ?? this.defaultDirectory;
    if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("\u5386\u53F2\u8BB0\u5F55\u76EE\u5F55\u914D\u7F6E\u65E0\u6548\u3002");
    if (directory.includes("dsh-quick-translate") && !existsSync2(directory)) {
      const migrated = directory.replace("dsh-quick-translate", "dsh-translate");
      if (existsSync2(migrated) || directory === join2(dirname2(this.settingsFile).replace("dsh-translate", "dsh-quick-translate"), "history")) {
        directory = migrated;
      }
    }
    const customPromptFile = join2(dirname2(this.settingsFile), "prompts", "custom.md");
    const mode = saved.promptMode === "custom" ? "custom" : "default";
    this.config = { directory: resolve2(directory), prompt: DEFAULT_PROMPT, provider: typeof saved.provider === "string" ? saved.provider : "", model: typeof saved.model === "string" ? saved.model : "", promptMode: mode, defaultPromptFile: DEFAULT_PROMPT_FILE, customPromptFile, hasCustomPrompt: false };
    try {
      await this.readPrompt();
    } catch (error) {
      this.config.prompt = "";
      this.config.promptError = error instanceof Error ? error.message : "\u65E0\u6CD5\u8BFB\u53D6\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD\uFF0C\u8BF7\u6062\u590D\u9ED8\u8BA4\u3002";
    }
  }
  async ensureDirectory() {
    await mkdir(this.config.directory, { recursive: true });
  }
  async commit(config) {
    await mkdir(dirname2(this.settingsFile), { recursive: true });
    await atomicJson(this.settingsFile, { version: 2, directory: config.directory, provider: config.provider, model: config.model, promptMode: config.promptMode });
    this.config = config;
  }
  validatePrompt(text) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_PROMPT) throw new Error("\u8BF7\u586B\u5199\u6709\u6548\u7684\u63D0\u793A\u8BCD\uFF0C\u6700\u591A 16,000 \u5B57\u7B26\u3002");
  }
  async readCustom() {
    try {
      const info = await lstat(this.config.customPromptFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROMPT * 4) throw new Error("\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD\u5FC5\u987B\u662F\u666E\u901A UTF-8 Markdown \u6587\u4EF6\uFF0C\u6700\u591A 16,000 \u5B57\u7B26\u3002");
      return await readFile(this.config.customPromptFile, "utf8");
    } catch (error) {
      if (missing(error)) return void 0;
      throw error;
    }
  }
  async readPrompt() {
    let custom;
    try {
      custom = await this.readCustom();
    } catch (error) {
      if (this.config.promptMode === "custom") throw error;
    }
    let prompt = DEFAULT_PROMPT;
    if (this.config.promptMode === "custom") {
      if (custom === void 0) throw new Error(`\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${this.config.customPromptFile}\u3002\u8BF7\u5728\u7FFB\u8BD1\u8BBE\u7F6E\u4E2D\u6062\u590D\u9ED8\u8BA4\u3002`);
      this.validatePrompt(custom);
      prompt = custom;
    }
    this.config = { ...this.config, prompt, hasCustomPrompt: custom !== void 0, promptError: void 0 };
    return this.settings;
  }
  refreshPrompt() {
    return this.serial(() => this.readPrompt());
  }
  setPromptMode(mode) {
    return this.serial(async () => {
      if (mode !== "default" && mode !== "custom") throw new Error("\u63D0\u793A\u8BCD\u6765\u6E90\u65E0\u6548\u3002");
      const custom = mode === "custom" ? await this.readCustom() : void 0;
      if (mode === "custom") {
        if (custom === void 0) throw new Error("\u8FD8\u6CA1\u6709\u5DF2\u4FDD\u5B58\u7684\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD\u3002");
        this.validatePrompt(custom);
      }
      await this.commit({ ...this.config, promptMode: mode, prompt: mode === "custom" ? custom : DEFAULT_PROMPT, promptError: void 0 });
      return this.settings;
    });
  }
  update(input) {
    return this.serial(async () => {
      if (!input || typeof input !== "object") throw new Error("\u8BBE\u7F6E\u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
      for (const key of ["provider", "model"]) if (input[key] !== void 0 && (typeof input[key] !== "string" || input[key].length > 500)) throw new Error("\u6A21\u578B\u914D\u7F6E\u65E0\u6548\u3002");
      const next = { ...this.config, provider: input.provider ?? this.config.provider, model: input.model ?? this.config.model };
      if (input.prompt !== void 0) {
        this.validatePrompt(input.prompt);
        const previous = await this.readCustom();
        await mkdir(dirname2(next.customPromptFile), { recursive: true });
        await atomicText(next.customPromptFile, input.prompt);
        next.prompt = input.prompt;
        next.promptMode = "custom";
        next.hasCustomPrompt = true;
        next.promptError = void 0;
        try {
          await this.commit(next);
        } catch (error) {
          if (previous === void 0) await unlink(next.customPromptFile);
          else await atomicText(next.customPromptFile, previous);
          throw error;
        }
      } else await this.commit(next);
      return this.settings;
    });
  }
  file(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("\u5386\u53F2\u8BB0\u5F55\u7F16\u53F7\u65E0\u6548\u3002");
    return join2(this.config.directory, `${id}.json`);
  }
  async readRecord(id) {
    const file = this.file(id), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("\u8BB0\u5F55\u6587\u4EF6\u65E0\u6548\u6216\u8FC7\u5927\u3002");
    const record = JSON.parse(await readFile(file, "utf8"));
    if (!record || record.id !== id || typeof record.source !== "string" || typeof record.result !== "string" || typeof record.prompt !== "string" || typeof record.createdAt !== "string" || typeof record.model !== "string" || typeof record.provider !== "string" || typeof record.modelName !== "string" || !["running", "completed", "stopped", "failed", "interrupted"].includes(record.status)) throw new Error("\u8BB0\u5F55\u6587\u4EF6\u683C\u5F0F\u65E0\u6548\u3002");
    return record;
  }
  read(id, activeId) {
    return this.serial(async () => {
      const record = await this.readRecord(id);
      if (record.status === "running" && id !== activeId) return { ...record, status: "interrupted", error: "\u4E0A\u6B21\u7FFB\u8BD1\u88AB\u4E2D\u65AD\uFF0C\u5DF2\u4FDD\u7559\u6700\u540E\u4FDD\u5B58\u7684\u5185\u5BB9\u3002" };
      return record;
    });
  }
  save(record) {
    const snapshot = structuredClone(record);
    return this.serial(async () => {
      await this.ensureDirectory();
      const file = this.file(snapshot.id);
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("\u4E0D\u80FD\u8986\u76D6\u975E\u666E\u901A\u6587\u4EF6\u3002");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await atomicJson(file, snapshot);
    });
  }
  list(offset = 0, activeId) {
    return this.serial(async () => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("\u5206\u9875\u4F4D\u7F6E\u65E0\u6548\u3002");
      let files;
      try {
        files = (await readdir(this.config.directory, { withFileTypes: true })).filter((e) => e.isFile() && owned(e.name)).map((e) => e.name).sort().reverse();
      } catch (error) {
        if (missing(error)) return { items: [], total: 0, next: null, warnings: [] };
        throw error;
      }
      const items = [], warnings = [];
      for (const file of files.slice(offset, offset + 25)) {
        try {
          const r = await this.readRecord(file.slice(0, -5));
          items.push({ id: r.id, createdAt: r.createdAt, title: line(r.source), preview: line(r.result), status: r.status === "running" && r.id !== activeId ? "interrupted" : r.status, modelName: r.modelName });
        } catch {
          warnings.push(`${file} \u65E0\u6CD5\u8BFB\u53D6\uFF0C\u539F\u6587\u4EF6\u5DF2\u4FDD\u7559\u3002`);
        }
      }
      return { items, total: files.length, next: offset + 25 < files.length ? offset + 25 : null, warnings };
    });
  }
  delete(id) {
    return this.serial(async () => {
      await this.readRecord(id);
      await unlink(this.file(id));
    });
  }
  clear() {
    return this.serial(async () => {
      let entries;
      try {
        entries = await readdir(this.config.directory, { withFileTypes: true });
      } catch (error) {
        if (missing(error)) return 0;
        throw error;
      }
      let count = 0;
      for (const e of entries) if (e.isFile() && owned(e.name)) {
        await unlink(join2(this.config.directory, e.name));
        count++;
      }
      return count;
    });
  }
  migrate(input) {
    return this.serial(async () => {
      if (typeof input !== "string" || !isAbsolute(input.trim())) throw new Error("\u8BF7\u9009\u62E9\u6216\u8F93\u5165\u5B8C\u6574\u7684\u7EDD\u5BF9\u76EE\u5F55\u8DEF\u5F84\u3002");
      const source = resolve2(this.config.directory), requested = resolve2(input.trim());
      const inside = (parent, child) => {
        const r = relative(parent, child);
        return r === "" || !r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r);
      };
      if (relative(source, requested) === "") return { directory: source, moved: 0, oldDirectoryRemoved: false, warnings: [] };
      if ([source, requested].some((p) => p === parse(p).root || relative(p, homedir2()) === "")) throw new Error("\u8BF7\u4F7F\u7528\u4E13\u95E8\u7684\u5386\u53F2\u8BB0\u5F55\u6587\u4EF6\u5939\uFF0C\u4E0D\u80FD\u4F7F\u7528\u78C1\u76D8\u6839\u76EE\u5F55\u6216\u7528\u6237\u4E3B\u76EE\u5F55\u3002");
      if (inside(source, requested) || inside(requested, source)) throw new Error("\u65B0\u65E7\u76EE\u5F55\u4E0D\u80FD\u4E92\u4E3A\u7236\u5B50\u76EE\u5F55\u3002");
      await mkdir(source, { recursive: true });
      if ((await lstat(source)).isSymbolicLink()) throw new Error("\u65E7\u76EE\u5F55\u4E0D\u80FD\u662F\u94FE\u63A5\u6216\u8054\u63A5\u70B9\u3002");
      let created = false;
      try {
        await mkdir(requested);
        created = true;
      } catch (error) {
        if (missing(error)) {
          await mkdir(requested, { recursive: true });
          created = true;
        } else if (error.code !== "EEXIST") throw error;
      }
      const copies = [];
      let committed = false;
      try {
        const info = await lstat(requested);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("\u65B0\u76EE\u5F55\u5FC5\u987B\u662F\u666E\u901A\u6587\u4EF6\u5939\u3002");
        const [realSource, target] = await Promise.all([realpath(source), realpath(requested)]);
        if (inside(realSource, target) || inside(target, realSource)) throw new Error("\u65B0\u65E7\u76EE\u5F55\u5B9E\u9645\u6307\u5411\u76F8\u540C\u4F4D\u7F6E\u6216\u4E92\u4E3A\u7236\u5B50\u76EE\u5F55\u3002");
        if (inside(realSource, resolve2(this.settingsFile)) || inside(target, resolve2(this.settingsFile))) throw new Error("\u5386\u53F2\u8BB0\u5F55\u76EE\u5F55\u4E0D\u80FD\u5305\u542B\u63D2\u4EF6\u8BBE\u7F6E\u6587\u4EF6\u3002");
        const entries = (await readdir(source, { withFileTypes: true })).filter((e) => e.isFile() && owned(e.name));
        const names = new Set((await readdir(target)).map((n) => process.platform === "win32" ? n.toLowerCase() : n));
        if (entries.some((e) => names.has(process.platform === "win32" ? e.name.toLowerCase() : e.name))) throw new Error("\u76EE\u6807\u76EE\u5F55\u5DF2\u6709\u540C\u540D\u8BB0\u5F55\uFF0C\u8BF7\u9009\u62E9\u5176\u4ED6\u76EE\u5F55\uFF0C\u539F\u8BB0\u5F55\u672A\u6539\u52A8\u3002");
        const originals = [];
        for (const e of entries) {
          const from = join2(source, e.name), to = join2(target, e.name), before = await lstat(from);
          if (!before.isFile() || before.isSymbolicLink()) throw new Error("\u8FC1\u79FB\u671F\u95F4\u6587\u4EF6\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u8BD5\u3002");
          await copyFile(from, to, constants.COPYFILE_EXCL);
          copies.push(to);
          const after = await lstat(from), dest = await lstat(to);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || dest.size !== before.size) throw new Error("\u590D\u5236\u671F\u95F4\u8BB0\u5F55\u88AB\u4FEE\u6539\uFF0C\u5DF2\u505C\u6B62\u8FC1\u79FB\u3002");
          originals.push({ name: e.name, size: before.size, mtimeMs: before.mtimeMs });
        }
        await this.commit({ ...this.config, directory: target });
        committed = true;
        const warnings = [];
        for (const original of originals) {
          try {
            const path = join2(source, original.name), now = await lstat(path);
            if (!now.isFile() || now.isSymbolicLink() || now.size !== original.size || now.mtimeMs !== original.mtimeMs) {
              warnings.push(`${original.name} \u5728\u8FC1\u79FB\u671F\u95F4\u88AB\u4FEE\u6539\uFF0C\u5DF2\u4FDD\u7559\u65E7\u526F\u672C\u3002`);
              continue;
            }
            await unlink(path);
          } catch (error) {
            if (!missing(error)) warnings.push(`${original.name} \u7684\u65E7\u526F\u672C\u6682\u65F6\u65E0\u6CD5\u5220\u9664\u3002`);
          }
        }
        let oldDirectoryRemoved = false;
        try {
          await rmdir(source);
          oldDirectoryRemoved = true;
        } catch {
          warnings.push("\u65E7\u76EE\u5F55\u8FD8\u6709\u5176\u4ED6\u5185\u5BB9\u6216\u6682\u65F6\u65E0\u6CD5\u5220\u9664\uFF0C\u5DF2\u4FDD\u7559\u65E7\u76EE\u5F55\u3002");
        }
        return { directory: target, moved: originals.length, oldDirectoryRemoved, warnings };
      } catch (error) {
        if (!committed) {
          for (const path of copies) await unlink(path).catch(() => {
          });
          if (created) await rmdir(requested).catch(() => {
          });
        }
        throw error;
      }
    });
  }
};

// src/host.ts
var name = "translate";
var inject = ["connection", "llm"];
function createHandler(runtime) {
  return async (request) => {
    try {
      const body = await request.json();
      if (!body || typeof body !== "object") throw new Error("\u8BF7\u6C42\u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
      let data;
      switch (body.action) {
        case "bootstrap":
          data = runtime.bootstrap();
          break;
        case "models":
          data = await runtime.models();
          break;
        case "settings":
          data = await runtime.store.update(body.settings);
          break;
        case "prompt-mode":
          data = await runtime.store.setPromptMode(body.mode);
          break;
        case "refresh-prompt":
          data = await runtime.store.refreshPrompt();
          break;
        case "directory": {
          if (body.target === "history") {
            await runtime.store.ensureDirectory();
            data = { directory: runtime.store.settings.directory };
          } else if (body.target === "prompts") {
            const directory = dirname3(runtime.store.settings.customPromptFile);
            await mkdir2(directory, { recursive: true });
            data = { directory };
          } else throw new Error("\u4E0D\u652F\u6301\u7684\u76EE\u5F55\u7C7B\u578B\u3002");
          break;
        }
        case "start":
          data = await runtime.start(body.source);
          break;
        case "events":
          return runtime.events(body.id, request.signal);
        case "stop":
          data = await runtime.stop(body.id);
          break;
        case "retry-save":
          data = await runtime.retrySave();
          break;
        case "history":
          data = await runtime.store.list(body.offset ?? 0, runtime.activeId);
          break;
        case "read":
          data = runtime.active?.id === body.id ? runtime.active : await runtime.store.read(body.id, runtime.activeId);
          break;
        case "delete":
          await runtime.delete(body.id);
          data = null;
          break;
        case "clear":
          if (body.confirm !== true) throw new Error("\u8BF7\u786E\u8BA4\u6E05\u7A7A\u5386\u53F2\u8BB0\u5F55\u3002");
          data = await runtime.clear();
          break;
        case "migrate":
          data = await runtime.migrate(body.directory);
          break;
        default:
          throw new Error("\u4E0D\u652F\u6301\u7684\u7FFB\u8BD1\u64CD\u4F5C\u3002");
      }
      return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const code = error.code;
      const message = code === "ENOENT" ? "\u8BB0\u5F55\u6216\u76EE\u5F55\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002" : code === "ENOSPC" ? "\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u3002" : ["EACCES", "EPERM"].includes(code ?? "") ? "\u65E0\u6CD5\u8BFB\u5199\u6587\u4EF6\uFF0C\u8BF7\u68C0\u67E5\u76EE\u5F55\u6743\u9650\u6216\u6587\u4EF6\u5360\u7528\u3002" : error instanceof Error ? error.message : "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002";
      return Response.json({ error: { message } }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
  };
}
async function apply(ctx, _config = {}, store = new Store()) {
  await store.init();
  const runtime = new Runtime(store, ctx.llm);
  ctx.connection.fetch.register({ path: API_PATH, methods: ["POST"], requestBody: "buffered", fetch: createHandler(runtime) });
  ctx.effect(() => () => runtime.dispose(), "translate: lifetime");
}
export {
  apply,
  createHandler,
  inject,
  name
};
