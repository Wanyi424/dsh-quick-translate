export const API_PATH = '/api/quick-translate';
export type DirectoryTarget = 'history' | 'prompts';
export const MAX_SOURCE = 60_000;
export const MAX_PROMPT = 16_000;
export const MAX_OUTPUT = 240_000;
export type Status = 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface Model { provider: string; id: string; name: string; providerName: string }
export type PromptMode = 'default' | 'custom';
export interface Settings { directory: string; prompt: string; provider: string; model: string; promptMode: PromptMode; defaultPromptFile: string; customPromptFile: string; hasCustomPrompt: boolean; promptError?: string }
export interface SettingsUpdate { prompt?: string; provider?: string; model?: string }
export interface Translation {
  id: string; createdAt: string; updatedAt: string; source: string; result: string;
  provider: string; model: string; modelName: string; prompt: string; status: Status;
  error?: string; saveError?: string; phase?: 'connecting' | 'thinking' | 'translating';
}
export interface Summary { id: string; createdAt: string; title: string; status: Status; modelName: string }
export interface HistoryPage { items: Summary[]; total: number; next: number | null; warnings: string[] }
export interface Migration { directory: string; moved: number; oldDirectoryRemoved: boolean; warnings: string[] }
export interface Bootstrap { settings: Settings; active: Translation | null; defaultPrompt: string }
export type StreamEvent = { type: 'snapshot'; record: Translation } | { type: 'update'; delta?: string; result?: string; phase: Translation['phase']; updatedAt: string } | { type: 'done'; record: Translation };
