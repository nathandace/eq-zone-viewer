// EverQuest in-game map files: maps/<zone>.txt plus the optional layers <zone>_1.txt .. <zone>_3.txt.
// Each line is either a segment  "L x1, y1, z1, x2, y2, z2, r, g, b"  or a label  "P x, y, z, r, g, b, size, text".
// Map coordinates are (-locX, -locY, locZ); the viewer uses glTF space (x = north = locY, y = up, z = east = -locX).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZoneInfo } from './zones.ts';

export interface MapLabel {
  /** Position in viewer space. */
  p: [number, number, number];
  color: [number, number, number];
  size: number;
  text: string;
  /** Short name of the zone this label leads to, for "to_<zone>" labels. */
  target?: string;
}

export interface ZoneMap {
  /** Flat x,y,z pairs per segment (6 numbers per segment), viewer space. */
  lines: number[];
  /** r,g,b (0..255) per segment. */
  colors: number[];
  labels: MapLabel[];
  files: string[];
}

function toViewer(mx: number, my: number, mz: number): [number, number, number] {
  return [-my, mz, mx];
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(northern|southern|eastern|western)\b/g, (w) => w.slice(0, -3))
    .replace(/\bmtns?\b/g, 'mountains')
    .trim();

/** Match "to_Lesser_Faydark" style labels to a known zone. */
export function resolveTarget(text: string, zones: ZoneInfo[]): string | undefined {
  let t = norm(text);
  const m = /^(?:zone ?line ?)?(?:to|zone to|exit to|portal to|enter) (.+)$/.exec(t);
  if (!m) return undefined;
  t = m[1].replace(/\b(zone|zoneline|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const compact = t.replace(/ /g, '');
  let best: { zone: ZoneInfo; score: number } | undefined;
  for (const z of zones) {
    const long = norm(z.longName).replace(/\bthe\b/g, '').replace(/\s+/g, ' ').trim();
    const longCompact = long.replace(/ /g, '');
    let score = 0;
    if (z.name === compact || longCompact === compact) score = 100;
    else if (longCompact.startsWith(compact) || longCompact.endsWith(compact)) score = 80 - (longCompact.length - compact.length) / 10;
    else if (longCompact.includes(compact) && compact.length >= 4) score = 60 - (longCompact.length - compact.length) / 10;
    else if (compact.includes(longCompact) && longCompact.length >= 4) score = 40;
    if (score > 0 && (!best || score > best.score)) best = { zone: z, score };
  }
  return best?.zone.name;
}

export function loadZoneMap(eqDir: string, zone: string, zones: ZoneInfo[]): ZoneMap | null {
  const dir = join(eqDir, 'maps');
  if (!existsSync(dir)) return null;
  const wanted = new Set([`${zone}.txt`, `${zone}_1.txt`, `${zone}_2.txt`, `${zone}_3.txt`]);
  const files = readdirSync(dir).filter((f) => wanted.has(f.toLowerCase())).sort();
  if (!files.length) return null;
  const map: ZoneMap = { lines: [], colors: [], labels: [], files };
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'latin1');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const kind = line[0].toUpperCase();
      const parts = line.slice(1).split(',').map((s) => s.trim());
      if (kind === 'L' && parts.length >= 9) {
        const v = parts.slice(0, 9).map(Number);
        if (v.some((n) => !Number.isFinite(n))) continue;
        map.lines.push(...toViewer(v[0], v[1], v[2]), ...toViewer(v[3], v[4], v[5]));
        map.colors.push(v[6], v[7], v[8]);
      } else if (kind === 'P' && parts.length >= 8) {
        const v = parts.slice(0, 7).map(Number);
        if (v.some((n) => !Number.isFinite(n))) continue;
        const labelText = parts.slice(7).join(',').replace(/_/g, ' ').trim();
        if (!labelText) continue;
        const label: MapLabel = { p: toViewer(v[0], v[1], v[2]), color: [v[3], v[4], v[5]], size: v[6], text: labelText };
        const target = resolveTarget(labelText, zones);
        if (target && target !== zone) label.target = target;
        map.labels.push(label);
      }
    }
  }
  return map;
}
