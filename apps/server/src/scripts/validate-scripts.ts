/** Validates every curated install script: `pnpm --filter @hearth/server validate-scripts`. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandValue, loadScripts, resolveAnswers, type MacroContext } from '../lib/install-script.ts';
import { SCRIPT_LOCATIONS } from '../lib/install-script.ts';

const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../catalog');
const { scripts, errors } = await loadScripts(dir);

// Dry-run expansion with fake locations so macro mistakes surface here, not during an install.
const ctx: MacroContext = {
  locations: Object.fromEntries(SCRIPT_LOCATIONS.map((id) => [id, `/mnt/test/${id}`])),
  answers: {},
  memoryBytes: 16 * 1024 ** 3,
  cpus: 8,
  installedApps: new Set(),
  lanIp: '192.168.1.20',
  timezone: 'UTC',
};
for (const [id, script] of scripts) {
  try {
    const answers = resolveAnswers(script, {});
    const expanded = JSON.stringify(expandValue(script.app_values, { ...ctx, answers }));
    const leftover = expanded.match(/\$[A-Z_]+/g);
    if (leftover) errors[id] = [`Unexpanded macros: ${[...new Set(leftover)].join(', ')}`];
  } catch (err) {
    errors[id] = [(err as Error).message];
  }
}

const bad = Object.entries(errors);
for (const [id, problems] of bad) console.error(`✗ ${id}\n  - ${problems.join('\n  - ')}`);
console.log(`${scripts.size - bad.filter(([id]) => scripts.has(id)).length} valid, ${bad.length} with problems`);
process.exit(bad.length ? 1 : 0);
