import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A packaged, unchanged copy of the user's document. Never written by UI operations.
// ../prompts works both from src/ in tests and lib/ in the installed package.
export const DEFAULT_PROMPT_FILE = fileURLToPath(new URL('../prompts/default.md', import.meta.url));
export const DEFAULT_PROMPT = readFileSync(DEFAULT_PROMPT_FILE, 'utf8');
