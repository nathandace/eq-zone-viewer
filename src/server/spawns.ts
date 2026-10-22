// Spawn data import from an EverQuest Emulator (Project EQ) MySQL dump.
// The client has no NPC placements; the community database has them in spawn2 (points), spawngroup /
// spawnentry (which NPCs appear at a point) and npc_types (name, level, race, gender, texture, size).
// The importer streams the dump once and writes one compact JSON per zone.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface SpawnNpc {
  id: number;
  name: string;
  level: number;
  race: number;
  gender: number;
  texture: number;
  helm: number;
  size: number;
  class: number;
  chance: number;
}

export interface SpawnPoint {
  /** EverQuest coordinates as stored by the emulator (x, y, z) and heading (0..512). */
  x: number;
  y: number;
  z: number;
  h: number;
  version: number;
  respawn: number;
  npcs: SpawnNpc[];
}

export interface ZoneSpawns {
  zone: string;
  spawns: SpawnPoint[];
}

type Row = (string | number | null)[];

/** Split the VALUES part of an INSERT statement into rows of scalar values. */
export function parseValues(text: string): Row[] {
  const rows: Row[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text[i] !== '(') i++;
    if (i >= n) break;
    i++;
    const row: Row = [];
    for (;;) {
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      if (i >= n) break;
      const c = text[i];
      if (c === "'") {
        let s = '';
        i++;
        while (i < n) {
          const d = text[i];
          if (d === '\\' && i + 1 < n) {
            const e = text[i + 1];
            s += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === '0' ? '\0' : e;
            i += 2;
          } else if (d === "'") {
            if (text[i + 1] === "'") {
              s += "'";
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            s += d;
            i++;
          }
        }
        row.push(s);
      } else {
        let j = i;
        while (j < n && text[j] !== ',' && text[j] !== ')') j++;
        const raw = text.slice(i, j).trim();
        i = j;
        if (raw === 'NULL') row.push(null);
        else if (raw === '' ) row.push(null);
        else {
          const num = Number(raw);
          row.push(Number.isFinite(num) ? num : raw);
        }
      }
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ')') {
        i++;
        break;
      }
      break;
    }
    rows.push(row);
  }
  return rows;
}

const WANTED = new Set(['spawn2', 'spawnentry', 'npc_types']);

/** Column orders used when the dump has no CREATE TABLE statements (Project EQ layout, first columns). */
const DEFAULT_COLUMNS: Record<string, string[]> = {
  spawn2: ['id', 'spawngroupID', 'zone', 'version', 'x', 'y', 'z', 'heading', 'respawntime', 'variance', 'pathgrid', '_condition', 'cond_value', 'enabled', 'animation'],
  spawnentry: ['spawngroupID', 'npcID', 'chance'],
  npc_types: ['id', 'name', 'lastname', 'level', 'race', 'class', 'bodytype', 'hp', 'mana', 'gender', 'texture', 'helmtexture', 'herosforgemodel', 'size'],
};

/**
 * Stream a MySQL dump and collect spawn points per zone. Handles both `INSERT INTO t VALUES (...)` and
 * `INSERT INTO t (cols) VALUES (...)`, with column order taken from CREATE TABLE when present.
 */
export async function importSpawns(dumpPath: string, onProgress?: (msg: string) => void): Promise<Map<string, ZoneSpawns>> {
  const columns = new Map<string, string[]>(Object.entries(DEFAULT_COLUMNS));
  let creating: string | null = null;
  let created: string[] = [];
  const spawn2: { zone: string; group: number; x: number; y: number; z: number; h: number; version: number; respawn: number }[] = [];
  const entries = new Map<number, { npc: number; chance: number }[]>();
  const npcs = new Map<number, Omit<SpawnNpc, 'chance'>>();
  let lines = 0;

  const handleInsert = (table: string, cols: string[], values: string) => {
    const idx = (name: string) => cols.indexOf(name);
    for (const row of parseValues(values)) {
      const get = (name: string) => row[idx(name)];
      if (table === 'spawn2') {
        const zone = String(get('zone') ?? '').toLowerCase();
        if (!zone) continue;
        spawn2.push({
          zone,
          group: Number(get('spawngroupID') ?? 0),
          x: Number(get('x') ?? 0),
          y: Number(get('y') ?? 0),
          z: Number(get('z') ?? 0),
          h: Number(get('heading') ?? 0),
          version: Number(get('version') ?? 0),
          respawn: Number(get('respawntime') ?? 0),
        });
      } else if (table === 'spawnentry') {
        const g = Number(get('spawngroupID') ?? 0);
        (entries.get(g) ?? entries.set(g, []).get(g)!).push({ npc: Number(get('npcID') ?? 0), chance: Number(get('chance') ?? 0) });
      } else if (table === 'npc_types') {
        const id = Number(get('id') ?? 0);
        npcs.set(id, {
          id,
          name: String(get('name') ?? ''),
          level: Number(get('level') ?? 0),
          race: Number(get('race') ?? 0),
          gender: Number(get('gender') ?? 0),
          texture: Number(get('texture') ?? 0),
          helm: Number(get('helmtexture') ?? 0),
          size: Number(get('size') ?? 0),
          class: Number(get('class') ?? 0),
        });
      }
    }
  };

  const rl = createInterface({ input: createReadStream(dumpPath), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (lines % 200000 === 0) onProgress?.(`${lines} lines, ${spawn2.length} spawn points, ${npcs.size} NPC types`);
    if (creating) {
      const m = /^\s*`([^`]+)`\s/.exec(line);
      if (m) created.push(m[1]);
      else if (/^\s*\)/.test(line)) {
        columns.set(creating, created);
        creating = null;
      }
      continue;
    }
    const ct = /^CREATE TABLE `?(\w+)`?\s*\(/i.exec(line);
    if (ct) {
      if (WANTED.has(ct[1].toLowerCase())) {
        creating = ct[1].toLowerCase();
        created = [];
      }
      continue;
    }
    const ins = /^INSERT INTO `?(\w+)`?\s*(\(([^)]*)\))?\s*VALUES\s*/i.exec(line);
    if (!ins) continue;
    const table = ins[1].toLowerCase();
    if (!WANTED.has(table)) continue;
    const cols = ins[3] ? ins[3].split(',').map((c) => c.trim().replace(/`/g, '')) : (columns.get(table) ?? []);
    handleInsert(table, cols, line.slice(ins[0].length));
  }

  const out = new Map<string, ZoneSpawns>();
  for (const s of spawn2) {
    const list = (entries.get(s.group) ?? [])
      .map((e) => {
        const t = npcs.get(e.npc);
        return t ? { ...t, chance: e.chance } : null;
      })
      .filter((x): x is SpawnNpc => !!x)
      .sort((a, b) => b.chance - a.chance);
    if (!list.length) continue;
    const zs = out.get(s.zone) ?? out.set(s.zone, { zone: s.zone, spawns: [] }).get(s.zone)!;
    zs.spawns.push({ x: s.x, y: s.y, z: s.z, h: s.h, version: s.version, respawn: s.respawn, npcs: list });
  }
  onProgress?.(`${lines} lines read: ${spawn2.length} spawn points, ${npcs.size} NPC types, ${out.size} zones`);
  return out;
}

/** Display form of an emulator NPC name: underscores become spaces, trailing instance digits go. */
export function displayName(name: string): string {
  return name
    .replace(/[_]+/g, ' ')
    .replace(/\s*\d+$/, '')
    .replace(/#/g, '')
    .trim();
}
