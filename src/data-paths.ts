import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

/** DSH_HOME is resolved by DSH itself, including the ~/.dsh default. */
export function translationDataDirectory() { return dshHomePath('plugin-data', 'dsh-quick-translate'); }
