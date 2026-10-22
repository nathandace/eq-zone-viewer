// Import NPC spawn points from a Project EQ (EverQuest Emulator) MySQL dump into spawns/<zone>.json files
// that the viewer serves as /api/zone/<zone>/spawns.json.
//
// Usage: node tools/import-spawns.ts <path/to/peq-dump.sql> [output folder]
//   The dump is the plain .sql file from a Project EQ database release (unzip it first). Only the
//   spawn2, spawnentry and npc_types tables are read; the output folder defaults to spawns/ next to
//   the app and is not part of the repository.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DIR } from '../src/server/config.ts';
import { importSpawns } from '../src/server/spawns.ts';

const dump = process.argv[2];
if (!dump) {
  console.error('Usage: node tools/import-spawns.ts <peq-dump.sql> [output folder]');
  process.exit(2);
}
const outDir = process.argv[3] || join(APP_DIR, 'spawns');
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const zones = await importSpawns(dump, (msg) => console.log(`[import] ${msg}`));
const index: Record<string, number> = {};
for (const [name, data] of zones) {
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(data));
  index[name] = data.spawns.length;
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ importedAt: new Date().toISOString(), source: dump, zones: index }, null, 1));
console.log(`[import] wrote ${zones.size} zone files to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
