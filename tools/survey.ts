// Survey all archives in the EQ directory: file extensions and format magic/version of key files.
// Usage: node tools/survey.ts "<eq dir>" <out.json>
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PfsArchive } from '../src/server/pfs.ts';
import { resolveEqDir } from '../src/server/config.ts';

const eqDir = resolveEqDir(process.argv[2]).eqDir!;
if (!eqDir) {
  console.error('No EverQuest directory found: pass it as the first argument, set EQ_DIR, or put "eqDir" in config.json.');
  process.exit(1);
}
const outFile = process.argv[3];
const files = readdirSync(eqDir).filter((f) => /\.(s3d|eqg|pfs|pak)$/i.test(f));
const summary: Record<string, any> = {};
const counts: Record<string, number> = {};
const formatVersions: Record<string, number> = {};
const errors: string[] = [];
let i = 0;
const printable = (s: string) => s.replace(/[^\x20-\x7e]/g, '.');
for (const f of files) {
  i++;
  try {
    const a = PfsArchive.open(join(eqDir, f));
    const info: Record<string, any> = { ext: {}, formats: {} };
    for (const n of a.names()) {
      const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
      info.ext[ext] = (info.ext[ext] || 0) + 1;
      counts[ext] = (counts[ext] || 0) + 1;
      if (/^(wld|ter|mod|mds|zon|dat|lay|ani|lit|prt|pts|eco|tog)$/.test(ext)) {
        const head = a.getHead(n, 16)!;
        const magic = head.length >= 4 ? head.toString('latin1', 0, 4) : '';
        let key: string;
        if (ext === 'wld') {
          key = `wld:${head.readUInt32LE(4).toString(16)}`;
        } else if (magic === 'EQGZ' || magic === 'EQGT' || magic === 'EQGM' || magic === 'EQGS' || magic === 'EQGL' || magic === 'EQGA') {
          key = `${ext}:${magic} v${head.readUInt32LE(4)}`;
        } else if (/^[A-Z*\r\n\t ]/.test(magic)) {
          key = `${ext}:text:${printable(head.toString('latin1', 0, 5)).trim()}`;
        } else {
          key = `${ext}:bin:u32=${head.length >= 4 ? head.readUInt32LE(0) : '?'}`;
        }
        info.formats[key] = (info.formats[key] || 0) + 1;
        formatVersions[key] = (formatVersions[key] || 0) + 1;
      }
    }
    summary[f] = info;
  } catch (e: any) {
    errors.push(`${f}: ${e.message}`);
  }
  if (i % 250 === 0) console.log(`${i}/${files.length}`);
}
writeFileSync(outFile, JSON.stringify({ counts, formatVersions, errors, archives: summary }, null, 1));
console.log('extension counts:', JSON.stringify(counts));
console.log('format versions:', JSON.stringify(formatVersions, null, 1));
console.log('errors:', errors.length, errors.slice(0, 20));
