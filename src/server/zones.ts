// Zone discovery: scans the EQ directory for archives that contain zone geometry.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PfsArchive } from './pfs.ts';

export interface ZoneInfo {
  name: string;
  kind: 's3d' | 'eqg';
  longName: string;
  archive: string;
  sizeBytes: number;
}

const LONG_NAMES: Record<string, string> = {
  airplane: 'Plane of Sky',
  akanon: "Ak'Anon",
  arena: 'The Arena',
  arena2: 'The Arena (new)',
  befallen: 'Befallen',
  beholder: 'Gorge of King Xorbb',
  blackburrow: 'Blackburrow',
  burningwood: 'The Burning Wood',
  butcher: 'Butcherblock Mountains',
  cabeast: 'East Cabilis',
  cabwest: 'West Cabilis',
  cauldron: "Dagnor's Cauldron",
  cazicthule: 'Lost Temple of Cazic-Thule',
  charasis: 'Howling Stones',
  chardok: 'Chardok',
  citymist: 'City of Mist',
  commons: 'West Commonlands',
  commonlands: 'The Commonlands',
  crushbone: 'Clan Crushbone',
  dalnir: 'Crypt of Dalnir',
  dreadlands: 'The Dreadlands',
  droga: 'Temple of Droga',
  eastkarana: 'Eastern Plains of Karana',
  ecommons: 'East Commonlands',
  emeraldjungle: 'The Emerald Jungle',
  erudnext: 'Erudin',
  erudnint: 'Erudin Palace',
  erudsxing: "Erud's Crossing",
  everfrost: 'Everfrost Peaks',
  fearplane: 'Plane of Fear',
  feerrott: 'The Feerrott',
  felwithea: 'North Felwithe',
  felwitheb: 'South Felwithe',
  fieldofbone: 'The Field of Bone',
  firiona: 'Firiona Vie',
  freporte: 'East Freeport (classic)',
  freportn: 'North Freeport (classic)',
  freportw: 'West Freeport (classic)',
  freeporteast: 'East Freeport',
  freeportwest: 'West Freeport',
  freeportacademy: 'Academy of Arcane Sciences',
  freeportarena: 'Freeport Arena',
  freeportcityhall: 'Freeport City Hall',
  freeporthall: 'Hall of Truth',
  freeportmilitia: 'Freeport Militia House',
  freeportsewers: 'Freeport Sewers',
  freeporttheater: 'Theater of the Tranquil',
  frontiermtns: 'Frontier Mountains',
  gfaydark: 'Greater Faydark',
  grobb: 'Grobb',
  gukbottom: 'Ruins of Old Guk',
  guktop: 'Guk',
  guildhall3: 'Guild Hall',
  guildhalllrg: 'Guild Hall (large)',
  guildhallsml: 'Guild Hall (small)',
  guildhallsng: 'Guild Hall (single)',
  guildlobby: 'Guild Lobby',
  halas: 'Halas',
  hateplane: 'Plane of Hate',
  hateplaneb: 'Plane of Hate (revamp)',
  highkeep: 'High Keep',
  highpass: 'Highpass Hold (classic)',
  highpasshold: 'Highpass Hold',
  hole: 'The Hole',
  innothule: 'Innothule Swamp (classic)',
  innothuleb: 'Innothule Swamp',
  jaggedpine: 'Jaggedpine Forest',
  kaesora: 'Kaesora',
  kaladima: 'North Kaladim',
  kaladimb: 'South Kaladim',
  karnor: "Karnor's Castle",
  kedge: 'Kedge Keep',
  kerraridge: 'Kerra Isle',
  kithicor: 'Kithicor Forest',
  kurn: "Kurn's Tower",
  lakeofillomen: 'Lake of Ill Omen',
  lakerathe: 'Lake Rathetear',
  lavastorm: 'Lavastorm Mountains',
  lfaydark: 'Lesser Faydark',
  mistmoore: 'Castle Mistmoore',
  misty: 'Misty Thicket (classic)',
  mistythicket: 'Misty Thicket',
  najena: 'Najena',
  nedaria: "Nedaria's Landing",
  neighborhood: 'Sunrise Hills',
  nektulos: 'Nektulos Forest',
  nektropos: 'Nektropos',
  nektrunder: 'Nektulos Underground',
  neriaka: 'Neriak Foreign Quarter',
  neriakb: 'Neriak Commons',
  neriakc: 'Neriak Third Gate',
  newsebexp: 'Sebilis (expedition)',
  northkarana: 'Northern Plains of Karana',
  northro: 'North Ro',
  nro: 'Northern Desert of Ro (classic)',
  nurga: 'Mines of Nurga',
  oasis: 'Oasis of Marr',
  oceanoftears: 'Ocean of Tears',
  oggok: 'Oggok',
  oot: 'Ocean of Tears (classic)',
  overthere: 'The Overthere',
  paineel: 'Paineel',
  paw: 'Infected Paw',
  permafrost: 'Permafrost Keep',
  poknowledge: 'Plane of Knowledge',
  pomischief: 'Plane of Mischief',
  qcat: 'Qeynos Catacombs',
  qey2hh1: 'Western Plains of Karana',
  qeynos: 'South Qeynos',
  qeynos2: 'North Qeynos',
  qeytoqrg: 'Qeynos Hills',
  qrg: 'Surefall Glade',
  rathemtn: 'Rathe Mountains',
  rivervale: 'Rivervale',
  runnyeye: 'Clan Runnyeye',
  sebilis: 'Old Sebilis',
  shadowedmount: 'Shadowed Mount',
  shadowrest: 'Shadowrest',
  skyfire: 'Skyfire Mountains',
  soldunga: "Solusek's Eye",
  soldungb: "Nagafen's Lair",
  soldungc: "Nagafen's Lair (revamp)",
  soltemple: 'Temple of Solusek Ro',
  southkarana: 'Southern Plains of Karana',
  southro: 'South Ro',
  sro: 'Southern Desert of Ro (classic)',
  steamfont: 'Steamfont Mountains (classic)',
  steamfontmts: 'Steamfont Mountains',
  stonebrunt: 'Stonebrunt Mountains',
  swampofnohope: 'Swamp of No Hope',
  timorous: 'Timorous Deep',
  tox: 'Toxxulia Forest (classic)',
  toxxulia: 'Toxxulia Forest',
  trakanon: "Trakanon's Teeth",
  tutorial: 'Tutorial (classic)',
  tutoriala: 'The Mines of Gloomingdeep',
  tutorialb: 'The Mines of Gloomingdeep (b)',
  unrest: 'Estate of Unrest',
  veeshan: "Veeshan's Peak",
  warrens: 'The Warrens',
  warslikswood: 'Warsliks Woods',
  bazaar: 'The Bazaar',
  fhalls: 'The Forgotten Halls',
  anniversarytower: 'Anniversary Tower',
  clz: 'Crescent Reach (clz)',
  dragoncrypt: 'Dragon Crypt',
  dragonscalea: 'Dragonscale Hills',
  giftygiver: 'Gifty Giver',
  lakenerius: 'Lake Nerius',
  takishruins: "Takish'Hiz Ruins",
  weddingchapel: 'Wedding Chapel',
  weddingchapeldark: 'Wedding Chapel (dark)',
  pokport_gukta: 'PoK Portal: Gukta',
  sky: 'Sky',
};

const SKIP = /^(gequip\d*|gatesequip|ldonequip|lgequip\d*|loyequip|vequip|obequip_\w+|global\w*|load2?|it\d+|backup_.*|sky|.*_amr\d*|.*_chr\d*|.*_obj\d*|.*_2_obj|.*_lit|.*_assets|.*_sndfx|.*_env)$/i;

export function longNameFor(name: string): string {
  const hit = LONG_NAMES[name.toLowerCase()];
  if (hit) return hit;
  // phinterior1a2 -> Player Housing Interior 1a2, etc.
  if (/^phinterior/i.test(name)) return `Player Housing: ${name.replace(/^phinterior/i, '')}`;
  if (/^plh/i.test(name)) return `Player Housing: ${name.replace(/^plh/i, '')}`;
  if (/^clz-/i.test(name)) return `Crescent Reach (${name.slice(4)})`;
  return name;
}

function signature(eqDir: string): string {
  const names = readdirSync(eqDir).filter((f) => /\.(s3d|eqg|zon)$/i.test(f)).sort();
  let total = 0;
  for (const n of names) {
    try {
      total += statSync(join(eqDir, n)).size;
    } catch {
      /* ignore */
    }
  }
  return `${names.length}:${total}`;
}

export function discoverZones(eqDir: string, cacheDir: string): ZoneInfo[] {
  const cacheFile = join(cacheDir, 'zones.json');
  const sig = signature(eqDir);
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.signature === sig && Array.isArray(cached.zones)) return cached.zones;
    } catch {
      /* rebuild */
    }
  }
  const files = readdirSync(eqDir);
  const lower = new Set(files.map((f) => f.toLowerCase()));
  const zones: ZoneInfo[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const l = f.toLowerCase();
    const m = /^(.+)\.(s3d|eqg)$/.exec(l);
    if (!m) continue;
    const name = m[1];
    const kind = m[2] as 's3d' | 'eqg';
    if (SKIP.test(name) || seen.has(name)) continue;
    let isZone = false;
    let size = 0;
    try {
      const p = join(eqDir, f);
      size = statSync(p).size;
      const a = PfsArchive.open(p);
      if (kind === 's3d') {
        isZone = a.has(`${name}.wld`);
      } else {
        const names = a.names();
        isZone = names.some((n) => n.endsWith('.ter') || n.endsWith('.zon') || n === `${name}.dat`) || lower.has(`${name}.zon`);
      }
    } catch {
      isZone = false;
    }
    if (!isZone) continue;
    seen.add(name);
    zones.push({ name, kind, longName: longNameFor(name), archive: l, sizeBytes: size });
  }
  zones.sort((a, b) => a.longName.localeCompare(b.longName));
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ signature: sig, zones }, null, 1));
  return zones;
}
