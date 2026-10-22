// Character (NPC) models from the client's *_chr.s3d archives, in their default pose, plus the mapping from
// emulator race ids to the three-letter model codes the archives use.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PfsArchive } from './pfs.ts';
import { S3dBuilder } from './build-s3d.ts';
import { Bounds, type ZoneScene } from './scene.ts';

/** Player races: two-letter stem plus M/F for gender. */
const PLAYER_RACES: Record<number, string> = {
  1: 'HU',
  2: 'BA',
  3: 'ER',
  4: 'EL',
  5: 'HI',
  6: 'DA',
  7: 'HA',
  8: 'DW',
  9: 'TR',
  10: 'OG',
  11: 'HO',
  12: 'GN',
  128: 'IK',
  130: 'VA',
};

/** NPC races with a fixed model code (classic through Velious; unknown ids fall back to a marker). */
const NPC_RACES: Record<number, string> = {
  13: 'AVI', 14: 'WER', 15: 'BRN', 16: 'CEN', 17: 'GOL', 18: 'GIA', 19: 'TRK', 20: 'VST', 21: 'EYE', 22: 'BET', 23: 'CPM', 24: 'FIS',
  25: 'FAI', 26: 'FRO', 27: 'FRG', 28: 'FUN', 29: 'GAR', 30: 'GAM', 31: 'GEL', 32: 'GHO', 33: 'GHU', 34: 'BAT', 35: 'EEL', 36: 'RAT',
  37: 'SNA', 38: 'SPI', 39: 'GNN', 40: 'GOB', 41: 'GOR', 42: 'WOL', 43: 'BEA', 44: 'FPM', 45: 'DML', 46: 'IMP', 47: 'GRI', 48: 'KOB',
  49: 'DRA', 50: 'LIO', 51: 'LIZ', 52: 'MIM', 53: 'MIN', 54: 'ORC', 55: 'BGM', 56: 'PIX', 57: 'DRC', 58: 'SOL', 59: 'BGG', 60: 'SKE',
  61: 'SHA', 62: 'TUN', 63: 'TIG', 64: 'TRE', 65: 'VAM', 66: 'RAL', 67: 'HHM', 68: 'TEN', 69: 'WIL', 70: 'ZOM', 71: 'QCM', 72: 'SHP',
  73: 'LAU', 74: 'PIR', 75: 'ELE', 76: 'PUM', 77: 'NGM', 78: 'EGM', 79: 'BIX', 80: 'HAN', 81: 'RIM', 82: 'SCA', 83: 'SKU', 84: 'SNE',
  85: 'SPE', 86: 'SPH', 87: 'ARM', 88: 'CLW', 89: 'DRK', 90: 'HOM', 91: 'ALL', 92: 'OGM', 93: 'TRM', 94: 'DWM', 95: 'CAZ', 96: 'COC',
  97: 'DAM', 98: 'VSM', 99: 'AMY', 100: 'DER', 101: 'EFR', 102: 'FRT', 103: 'KED', 104: 'LEE', 105: 'SWO', 106: 'FEL', 107: 'MAM',
  108: 'EYE', 109: 'WAS', 110: 'MER', 111: 'HAR', 112: 'GFM', 113: 'DRI', 114: 'GSP', 115: 'CLA', 116: 'SEA', 119: 'SAB', 120: 'WOE',
  121: 'GOR', 123: 'INN', 124: 'UNI', 125: 'PEG', 126: 'DJI', 127: 'IVM', 129: 'SCO', 131: 'SRN', 134: 'MOS', 135: 'RHI', 136: 'XAL',
  137: 'KGO', 138: 'YET', 139: 'ICM', 140: 'FGI', 145: 'GOO', 150: 'ISK', 151: 'IKG', 156: 'WUR', 157: 'DEV', 158: 'IKG',
};

export function modelCodeFor(race: number, gender: number): string | undefined {
  const stem = PLAYER_RACES[race];
  if (stem) return stem + (gender === 1 ? 'F' : 'M');
  return NPC_RACES[race];
}

/** Archives that may hold a zone's character models, most specific first. */
function characterArchives(eqDir: string, zone: string): string[] {
  const out: string[] = [];
  const push = (f: string) => {
    if (existsSync(join(eqDir, f)) && !out.includes(f)) out.push(f);
  };
  push(`${zone}_chr.s3d`);
  push(`${zone}_chr2.s3d`);
  const list = join(eqDir, `${zone}_chr.txt`);
  if (existsSync(list)) {
    for (const line of readFileSync(list, 'latin1').split(/\r?\n/)) {
      const parts = line.trim().split(',');
      if (parts.length < 2) continue;
      const base = parts[1].trim().toLowerCase();
      if (!base) continue;
      push(`${base}.s3d`);
      push(`${base}_chr.s3d`);
    }
  }
  push('global_chr.s3d');
  for (let i = 2; i <= 9; i++) push(`global${i}_chr.s3d`);
  return out;
}

const sceneCache = new Map<string, ZoneScene | null>();

/** Build a character model (default pose) as a one-node scene, or undefined when no archive has it. */
export function buildCharacterScene(eqDir: string, zone: string, code: string): ZoneScene | undefined {
  const key = `${eqDir}|${zone}|${code}`;
  if (sceneCache.has(key)) return sceneCache.get(key) ?? undefined;
  const want = `${code.toUpperCase()}_ACTORDEF`;
  for (const file of characterArchives(eqDir, zone)) {
    let archive: PfsArchive;
    try {
      archive = PfsArchive.open(join(eqDir, file));
    } catch {
      continue;
    }
    const wldName = archive.names().find((n) => n.endsWith('.wld'));
    if (!wldName) continue;
    const builder = new S3dBuilder(eqDir, zone);
    const ctx = builder.openContext(archive, file, wldName);
    if (!ctx) continue;
    const frag = ctx.wld.byType(0x14).find((f) => f.name === want);
    if (!frag) continue;
    const mesh = builder.actorMesh(ctx, frag, code);
    if (!mesh) continue;
    const bounds = new Bounds();
    bounds.addPositions(mesh.positions);
    const scene: ZoneScene = {
      name: code,
      materials: builder.materials.list,
      meshes: [mesh],
      nodes: [{ name: code, kind: 'object', mesh: 0, instances: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] }],
      bounds: { min: bounds.min, max: bounds.max },
      warnings: builder.warnings,
      stats: { format: `character (${file})`, triangles: mesh.groups.reduce((s, g) => s + g.indices.length / 3, 0) },
    };
    sceneCache.set(key, scene);
    return scene;
  }
  sceneCache.set(key, null);
  return undefined;
}
