// Zone sound placements.
//   Classic zones:  <zone>_sounds.eff (84-byte records) + <zone>_sndbnk.eff (text: EMIT list, LOOP list)
//   Newer zones:    <zone>.emt (comma-separated text, one emitter per line)
// Sound files live in snd<n>.pfs archives (WAV) or next to the game (MP3 music).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PfsArchive } from './pfs.ts';
import { eqToGl, type Vec3 } from './scene.ts';

export interface SoundEmitter {
  /** Position in viewer space. */
  p: Vec3;
  /** Audible radius in game units; 0 means everywhere in the zone. */
  radius: number;
  kind: 'loop' | 'emit' | 'music';
  /** File played by day / by night (undefined = silent then). */
  day?: string;
  night?: string;
  /** Milliseconds between one-shot plays [min, max]; [0, 0] loops continuously. */
  cooldown: [number, number];
  volume: number;
}

export interface ZoneSounds {
  emitters: SoundEmitter[];
  files: string[];
  /** Music entries that reference XMI (MIDI) tracks, which the viewer cannot play. */
  skippedMidi: number;
}

export function parseSoundBank(text: string): { emit: string[]; loop: string[] } {
  const bank = { emit: [] as string[], loop: [] as string[] };
  let section: 'emit' | 'loop' | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^emit$/i.test(line)) section = 'emit';
    else if (/^loop$/i.test(line)) section = 'loop';
    else if (section) bank[section].push(line.toLowerCase());
  }
  return bank;
}

/** Decode the fixed 84-byte records of a <zone>_sounds.eff file. */
export function parseSoundsEff(buf: Buffer, bank: { emit: string[]; loop: string[] }): { emitters: SoundEmitter[]; skippedMidi: number } {
  const emitters: SoundEmitter[] = [];
  let skippedMidi = 0;
  const all = [...bank.emit, ...bank.loop];
  for (let o = 0; o + 84 <= buf.length; o += 84) {
    const x = buf.readFloatLE(o + 16);
    const y = buf.readFloatLE(o + 20);
    const z = buf.readFloatLE(o + 24);
    const radius = buf.readFloatLE(o + 28);
    const cooldownDay = buf.readInt32LE(o + 32);
    const cooldownNight = buf.readInt32LE(o + 36);
    const randomDelay = buf.readInt32LE(o + 40);
    const idDay = buf.readInt32LE(o + 48);
    const idNight = buf.readInt32LE(o + 52);
    const type = buf[o + 56]; // 0 music (XMI track), 1 ambient loop, 2 emitter
    if (type === 0) {
      skippedMidi++;
      continue;
    }
    const list = type === 2 ? bank.emit : bank.loop;
    const resolve = (id: number): string | undefined => {
      if (id <= 0) return undefined;
      const name = list[id - 1] ?? all[id - 1];
      return name ? `${name}.wav` : undefined;
    };
    const day = resolve(idDay);
    const night = resolve(idNight);
    if (!day && !night) continue;
    const cd = Math.max(0, cooldownDay, cooldownNight);
    emitters.push({
      p: eqToGl(x, y, z),
      radius: Math.max(0, radius),
      kind: type === 1 ? 'loop' : 'emit',
      day,
      night,
      cooldown: [cd, cd + Math.max(0, randomDelay)],
      volume: 1,
    });
  }
  return { emitters, skippedMidi };
}

/** Decode a <zone>.emt file: "type,file,?,?,volume,cooldownMin,cooldownMax,?,x,y,z,inner,outer,...". */
export function parseEmt(text: string): SoundEmitter[] {
  const out: SoundEmitter[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.length < 13 || !parts[1]) continue;
    const file = parts[1].toLowerCase();
    if (!/\.(wav|mp3)$/.test(file)) continue;
    const num = (i: number, def = 0): number => {
      const v = Number(parts[i]);
      return Number.isFinite(v) ? v : def;
    };
    const volume = Math.max(0, Math.min(1, num(4, 1)));
    const cdMin = num(5);
    const cdMax = Math.max(cdMin, num(6));
    const outer = Math.max(num(11), num(12));
    const music = file.endsWith('.mp3');
    out.push({
      p: eqToGl(num(8), num(9), num(10)),
      radius: outer,
      kind: music ? 'music' : cdMin > 0 || cdMax > 0 ? 'emit' : 'loop',
      day: file,
      night: file,
      cooldown: [cdMin, cdMax],
      volume,
    });
  }
  return out;
}

export function loadZoneSounds(eqDir: string, zone: string): ZoneSounds | null {
  const files: string[] = [];
  let emitters: SoundEmitter[] = [];
  let skippedMidi = 0;
  const eff = join(eqDir, `${zone}_sounds.eff`);
  const bnk = join(eqDir, `${zone}_sndbnk.eff`);
  if (existsSync(eff) && existsSync(bnk)) {
    const parsed = parseSoundsEff(readFileSync(eff), parseSoundBank(readFileSync(bnk, 'latin1')));
    emitters = emitters.concat(parsed.emitters);
    skippedMidi += parsed.skippedMidi;
    files.push(`${zone}_sounds.eff`, `${zone}_sndbnk.eff`);
  }
  const emt = join(eqDir, `${zone}.emt`);
  if (existsSync(emt)) {
    emitters = emitters.concat(parseEmt(readFileSync(emt, 'latin1')));
    files.push(`${zone}.emt`);
  }
  if (!files.length) return null;
  return { emitters, files, skippedMidi };
}

const indexes = new Map<string, Map<string, string>>();

/** Which snd<n>.pfs archive holds a WAV file (index built once per install). */
export function soundArchiveFor(eqDir: string, file: string): string | undefined {
  let idx = indexes.get(eqDir);
  if (!idx) {
    idx = new Map();
    for (const f of readdirSync(eqDir).filter((n) => /^snd\d+\.pfs$/i.test(n)).sort()) {
      try {
        for (const name of PfsArchive.open(join(eqDir, f)).names()) if (!idx.has(name)) idx.set(name, f);
      } catch {
        /* skip unreadable archives */
      }
    }
    indexes.set(eqDir, idx);
    console.log(`[sound] indexed ${idx.size} files in the sound archives`);
  }
  return idx.get(file.toLowerCase());
}

export function isSafeSoundName(name: string): boolean {
  return /^[a-z0-9_\-. ]+\.(wav|mp3)$/i.test(name) && !name.includes('..');
}
