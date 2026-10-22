// Builds every discovered zone (without the server) and reports failures, timings and warnings.
// Usage: node tools/build-all.ts [<eq dir>] [report.json] [filter-regex]
//   <eq dir> defaults to the folder the server would use (EQ_DIR, config.json or auto-detected).
//   report.json defaults to cache/build-report.json.
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { discoverZones } from '../src/server/zones.ts';
import { buildS3dZone } from '../src/server/build-s3d.ts';
import { buildEqgZone } from '../src/server/build-eqg.ts';
import { buildGlb } from '../src/server/gltf.ts';
import { resolveEqDir } from '../src/server/config.ts';

const args = process.argv.slice(2);
const explicitDir = args[0] && existsSync(args[0]) && statSync(args[0]).isDirectory() ? args.shift() : undefined;
const eqDir = resolveEqDir(explicitDir).eqDir;
if (!eqDir) {
  console.error('No EverQuest directory found: pass it as the first argument, set EQ_DIR, or put "eqDir" in config.json.');
  process.exit(1);
}
const out = args[0] || join('cache', 'build-report.json');
const filter = args[1] ? new RegExp(args[1], 'i') : null;
const cacheDir = join(process.cwd(), 'cache', 'scan');
mkdirSync(cacheDir, { recursive: true });
console.log(`EverQuest dir: ${eqDir}`);
const zones = discoverZones(eqDir, cacheDir).filter((z) => !filter || filter.test(z.name));
const report: any[] = [];
let failed = 0;
for (const z of zones) {
  const t0 = Date.now();
  try {
    const scene = z.kind === 's3d' ? buildS3dZone(eqDir, z.name) : buildEqgZone(eqDir, z.name);
    const glb = buildGlb(scene);
    const ms = Date.now() - t0;
    const missing = scene.warnings.filter((w) => w.startsWith('missing')).length;
    report.push({ zone: z.name, kind: z.kind, ok: true, ms, glbBytes: glb.length, stats: scene.stats, warnings: scene.warnings.length, missing, sample: scene.warnings.slice(0, 5) });
    console.log(`OK   ${z.name.padEnd(22)} ${z.kind} ${String(ms).padStart(6)}ms ${(glb.length / 1e6).toFixed(1).padStart(6)}MB tris=${scene.stats.triangles} objs=${scene.stats.objects} warn=${scene.warnings.length}`);
  } catch (e: any) {
    failed++;
    report.push({ zone: z.name, kind: z.kind, ok: false, error: e.message, stack: String(e.stack).split('\n').slice(0, 4) });
    console.log(`FAIL ${z.name.padEnd(22)} ${z.kind} ${e.message}`);
  }
}
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\n${zones.length - failed}/${zones.length} zones built, report written to ${out}`);
