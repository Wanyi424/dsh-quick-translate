import { existsSync, renameSync } from 'node:fs';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

export function legacyTranslationDataDirectory() { return dshHomePath('plugin-data', 'dsh-quick-translate'); }

/** DSH_HOME is resolved by DSH itself, including the ~/.dsh default. Migrates legacy data directory if present. */
export function translationDataDirectory() {
  const current = dshHomePath('plugin-data', 'dsh-translate');
  const legacy = legacyTranslationDataDirectory();
  if (!existsSync(current) && existsSync(legacy)) {
    try { renameSync(legacy, current); } catch { return legacy; }
  }
  return current;
}
