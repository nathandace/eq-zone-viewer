// Locating the EverQuest install and the viewer's own files (config.json, cache/).
//
// The EverQuest directory is resolved in this order:
//   1. a directory passed on the command line        eq-zone-viewer.exe "D:\Games\EverQuest"
//   2. the EQ_DIR environment variable
//   3. "eqDir" in config.json next to the app
//   4. well-known install locations (see candidateEqDirs)
// If none of those point at a folder that contains zone archives the server still starts and the
// browser shows a setup page where the folder can be typed in; that is saved to config.json.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';

export interface AppConfig {
  /** Directory of the EverQuest install, or undefined when none is known. */
  eqDir?: string;
  /** Where the directory came from, for messages. */
  eqDirSource?: 'arg' | 'env' | 'config' | 'auto';
  port: number;
  /** Open the default browser once the server is listening. */
  openBrowser: boolean;
  /** `--import-spawns <dump.sql>`: import NPC spawn data and exit instead of serving. */
  importSpawns?: string;
}

/** Directory that holds config.json and cache/: next to the executable in a release build, else the project root. */
export const APP_DIR: string = sea.isSea()
  ? dirname(process.execPath)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATH: string = join(APP_DIR, 'config.json');

/** True when the directory contains EverQuest zone archives (.s3d / .eqg). */
export function looksLikeEqDir(dir: string | undefined): dir is string {
  if (!dir) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
    return readdirSync(dir).some((f) => /\.(s3d|eqg)$/i.test(f));
  } catch {
    return false;
  }
}

/** Places EverQuest is commonly installed, in the order they are tried. Only existing zone folders are returned. */
export function candidateEqDirs(): string[] {
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase()) && looksLikeEqDir(p)) out.push(p);
  };
  const addChildren = (parent: string) => {
    try {
      for (const name of readdirSync(parent)) add(join(parent, name));
    } catch {
      /* missing parent */
    }
  };
  if (process.platform === 'win32') {
    const drives = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
    for (const d of drives) {
      // Daybreak launcher installs: "...\Installed Games\EverQuest", "...\EverQuest Legends", test servers, etc.
      addChildren(`${d}\\Users\\Public\\Daybreak Game Company\\Installed Games`);
      addChildren(`${d}\\Users\\Public\\Sony Online Entertainment\\Installed Games`);
      add(`${d}\\Program Files (x86)\\Steam\\steamapps\\common\\EverQuest`);
      add(`${d}\\Program Files\\Steam\\steamapps\\common\\EverQuest`);
      add(`${d}\\SteamLibrary\\steamapps\\common\\EverQuest`);
      add(`${d}\\Steam\\steamapps\\common\\EverQuest`);
      add(`${d}\\Program Files (x86)\\Sony\\EverQuest`);
      add(`${d}\\Program Files\\Sony\\EverQuest`);
      add(`${d}\\Program Files (x86)\\Daybreak Game Company\\EverQuest`);
      add(`${d}\\Program Files (x86)\\EverQuest`);
      add(`${d}\\EverQuest`);
      add(`${d}\\Games\\EverQuest`);
      add(`${d}\\Games\\EverQuest Project 1999`);
      add(`${d}\\EQ`);
    }
  } else {
    const home = homedir();
    add(join(home, '.steam', 'steam', 'steamapps', 'common', 'EverQuest'));
    add(join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'EverQuest'));
    add(join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'EverQuest'));
    add(join(home, 'EverQuest'));
    add(join(home, 'Games', 'EverQuest'));
  }
  return out;
}

function readConfigFile(): { eqDir?: string; port?: number } {
  try {
    return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  } catch (e: any) {
    console.warn(`[config] could not read ${CONFIG_PATH}: ${e.message}`);
    return {};
  }
}

/** Command-line arguments after the program name (Node and single-executable builds differ in argv layout). */
export function userArgs(): string[] {
  const args = process.argv.slice(1);
  // In a plain `node script.ts` run argv[1] is the script; in a single executable it is the exe again (or absent).
  if (args.length && (/\.(ts|js|cjs|mjs)$/i.test(args[0]) || resolve(args[0]).toLowerCase() === process.execPath.toLowerCase())) args.shift();
  return args;
}

/**
 * Find the EverQuest directory: an explicit path (command line) wins, then EQ_DIR, then config.json,
 * then the well-known locations. Paths that do not contain zone archives are reported and skipped.
 */
export function resolveEqDir(explicit?: string): { eqDir?: string; source?: AppConfig['eqDirSource'] } {
  const tried: [string, NonNullable<AppConfig['eqDirSource']>][] = [];
  if (explicit) tried.push([resolve(explicit), 'arg']);
  if (process.env.EQ_DIR) tried.push([resolve(process.env.EQ_DIR), 'env']);
  const file = readConfigFile();
  if (file.eqDir) tried.push([resolve(file.eqDir), 'config']);
  for (const [dir, source] of tried) {
    if (looksLikeEqDir(dir)) return { eqDir: dir, source };
    console.warn(`[config] "${dir}" (from ${source}) does not contain EverQuest zone files (.s3d/.eqg); ignoring it.`);
  }
  const auto = candidateEqDirs()[0];
  return auto ? { eqDir: auto, source: 'auto' } : {};
}

export function loadConfig(): AppConfig {
  const args = userArgs();
  let importSpawns: string | undefined;
  const importAt = args.indexOf('--import-spawns');
  if (importAt >= 0) {
    importSpawns = args[importAt + 1] ? resolve(args[importAt + 1]) : '';
    args.splice(importAt, 2);
  }
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const file = readConfigFile();
  const { eqDir, source } = resolveEqDir(positional[0]);
  const port = Number(process.env.PORT || file.port || 3080);
  const openBrowser = flags.has('--open') || (sea.isSea() && !flags.has('--no-open'));
  return { eqDir, eqDirSource: source, port, openBrowser, importSpawns };
}

/** Persist the EverQuest directory to config.json (keeping any other settings in it) so the choice survives restarts. */
export function saveEqDir(eqDir: string): void {
  const file = readConfigFile();
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...file, eqDir }, null, 2) + '\n');
}
