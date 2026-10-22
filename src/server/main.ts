// HTTP server: serves the viewer, the zone list, built zone GLBs and decoded textures.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { dirname, extname, join, resolve } from 'node:path';
import sea from 'node:sea';
import { PfsArchive } from './pfs.ts';
import { discoverZones, type ZoneInfo } from './zones.ts';
import type { BuildFailure, BuildRequest, BuildResult } from './build-worker.ts';
import { decodeTexture, encodePng, downsample } from './textures.ts';
import { loadZoneMap } from './maps.ts';
import { isSafeSoundName, loadZoneSounds, soundArchiveFor } from './sounds.ts';
import { buildCharacterScene, modelCodeFor } from './characters.ts';
import { importSpawns } from './spawns.ts';
import { buildSkyScene } from './build-s3d.ts';
import { buildGlb } from './gltf.ts';
import { APP_DIR, CONFIG_PATH, candidateEqDirs, loadConfig, looksLikeEqDir, saveEqDir } from './config.ts';

/** Bump when the parsers or the GLB layout change so cached zone builds are discarded. */
const BUILD_VERSION = 3;
const PUBLIC_DIR = join(APP_DIR, 'public');
const CACHE_ROOT = join(APP_DIR, 'cache', `v${BUILD_VERSION}`);
const MAX_TEXTURE_SIZE = 2048;
const VERSION = process.env.EQZV_VERSION || readVersion();

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version || 'dev';
  } catch {
    return 'dev';
  }
}

const config = loadConfig();
let cacheDir = CACHE_ROOT;
let zones: ZoneInfo[] = [];
const zoneByName = new Map<string, ZoneInfo>();
const archiveCache = new Map<string, PfsArchive>();
const building = new Map<string, Promise<Buffer>>();

/** Each EverQuest install gets its own cache folder: the same zone name can hold different data in different installs. */
function cacheDirFor(eqDir: string): string {
  const key = createHash('sha1').update(resolve(eqDir).toLowerCase()).digest('hex').slice(0, 8);
  return join(CACHE_ROOT, key);
}

function setEqDir(dir: string | undefined): void {
  config.eqDir = dir;
  archiveCache.clear();
  if (dir) {
    cacheDir = cacheDirFor(dir);
    mkdirSync(cacheDir, { recursive: true });
  }
  refreshZones();
}

function refreshZones(): void {
  try {
    zones = config.eqDir ? discoverZones(config.eqDir, cacheDir) : [];
  } catch (e: any) {
    console.error(`[zones] could not scan ${config.eqDir}: ${e.message}`);
    zones = [];
  }
  zoneByName.clear();
  for (const z of zones) zoneByName.set(z.name, z);
}

function openArchive(file: string): PfsArchive | undefined {
  if (!config.eqDir) return undefined;
  const key = file.toLowerCase();
  const hit = archiveCache.get(key);
  if (hit) return hit;
  const p = join(config.eqDir, file);
  if (!existsSync(p)) return undefined;
  const a = PfsArchive.open(p);
  if (archiveCache.size > 40) {
    const first = archiveCache.keys().next().value;
    if (first) archiveCache.delete(first);
  }
  archiveCache.set(key, a);
  return a;
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9_.\-]/gi, '_');
}

async function buildZone(name: string): Promise<Buffer> {
  const info = zoneByName.get(name);
  const eqDir = config.eqDir;
  if (!info || !eqDir) throw new Error(`unknown zone ${name}`);
  const glbPath = join(cacheDir, 'glb', `${sanitize(name)}.glb`);
  if (existsSync(glbPath)) return readFileSync(glbPath);
  const pending = building.get(name);
  if (pending) return pending;
  const p = (async () => {
    const t0 = Date.now();
    console.log(`[build] ${name} (${info.kind})`);
    const result = await buildInWorker({ eqDir, name, kind: info.kind as 's3d' | 'eqg' });
    const glb = Buffer.from(result.glb);
    mkdirSync(dirname(glbPath), { recursive: true });
    writeFileSync(glbPath, glb);
    writeFileSync(glbPath.replace(/\.glb$/, '.json'), JSON.stringify({ stats: result.stats, warnings: result.warnings, bounds: result.bounds }, null, 1));
    console.log(`[build] ${name} done in ${Date.now() - t0}ms: ${JSON.stringify(result.stats)} warnings=${result.warnings.length}`);
    return glb;
  })();
  building.set(name, p);
  try {
    return await p;
  } finally {
    building.delete(name);
  }
}

/** Convert a zone on a worker thread. From source the worker is the .ts file; in a release build it is an embedded bundle. */
function buildInWorker(req: BuildRequest): Promise<BuildResult> {
  return new Promise((resolveBuild, reject) => {
    const worker = sea.isSea()
      ? new Worker(Buffer.from(sea.getAsset('build-worker.cjs')).toString('utf8'), { eval: true, workerData: req })
      : new Worker(new URL('./build-worker.ts', import.meta.url), { workerData: req });
    let settled = false;
    worker.once('message', (m: BuildResult | BuildFailure) => {
      settled = true;
      if (m.ok) resolveBuild(m);
      else {
        const err = new Error(m.error);
        err.stack = m.stack;
        reject(err);
      }
    });
    worker.once('error', (e) => {
      settled = true;
      reject(e);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`build worker exited with code ${code}`));
    });
  });
}

function texturePng(archiveFile: string, file: string, mask: boolean): Buffer | undefined {
  const cachePath = join(cacheDir, 'tex', sanitize(archiveFile), `${sanitize(file)}${mask ? '.m' : ''}.png`);
  if (existsSync(cachePath)) return readFileSync(cachePath);
  const archive = openArchive(archiveFile);
  if (!archive) return undefined;
  const buf = archive.get(file);
  if (!buf) return undefined;
  let img = decodeTexture(buf, mask);
  if (!img) return undefined;
  const big = Math.max(img.width, img.height);
  if (big > MAX_TEXTURE_SIZE) img = downsample(img, Math.ceil(big / MAX_TEXTURE_SIZE));
  const png = encodePng(img);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, png);
  return png;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** Viewer files: embedded in the executable for release builds, read from public/ when running from source. */
function readStatic(rel: string): Buffer | undefined {
  if (sea.isSea()) {
    try {
      return Buffer.from(sea.getAsset(rel.replace(/^\//, '')));
    } catch {
      return undefined;
    }
  }
  const filePath = resolve(PUBLIC_DIR, '.' + rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) return undefined;
  return readFileSync(filePath);
}

function send(res: ServerResponse, status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error('request body too large'));
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

/** Size of the current install's cache folder. */
function cacheInfo(): { dir: string; bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        bytes += statSync(p).size;
        files++;
      }
    }
  };
  if (existsSync(cacheDir)) walk(cacheDir);
  return { dir: cacheDir, bytes, files };
}

function configInfo(): Record<string, unknown> {
  return {
    eqDir: config.eqDir,
    source: config.eqDirSource,
    ok: looksLikeEqDir(config.eqDir),
    candidates: candidateEqDirs(),
    configPath: CONFIG_PATH,
    zones: zones.length,
    version: VERSION,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  if (path === '/api/config') {
    if (req.method === 'POST') {
      let body: any;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e: any) {
        sendJson(res, 400, { ok: false, error: `bad request: ${e.message}` });
        return;
      }
      const eqDir = typeof body.eqDir === 'string' ? resolve(body.eqDir.trim().replace(/^"|"$/g, '')) : '';
      if (!eqDir || !looksLikeEqDir(eqDir)) {
        const reason = !eqDir ? 'no folder given' : !existsSync(eqDir) ? 'that folder does not exist' : 'that folder contains no .s3d / .eqg zone archives';
        sendJson(res, 400, { ok: false, error: `Not an EverQuest folder: ${reason}.` });
        return;
      }
      setEqDir(eqDir);
      config.eqDirSource = 'config';
      try {
        saveEqDir(eqDir);
      } catch (e: any) {
        console.warn(`[config] could not write ${CONFIG_PATH}: ${e.message}`);
      }
      console.log(`EverQuest dir: ${eqDir} (set from the browser), zones found: ${zones.length}`);
      sendJson(res, 200, configInfo());
      return;
    }
    sendJson(res, 200, configInfo());
    return;
  }
  if (path === '/api/cache') {
    sendJson(res, 200, cacheInfo());
    return;
  }
  if (path === '/api/cache/clear' && req.method === 'POST') {
    for (const pending of building.values()) await pending.catch(() => undefined);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    console.log(`[cache] cleared ${cacheDir}`);
    sendJson(res, 200, cacheInfo());
    return;
  }
  if (path === '/api/zones') {
    if (url.searchParams.has('refresh')) refreshZones();
    sendJson(res, 200, zones);
    return;
  }
  let m = /^\/api\/zone\/([^/]+)\/scene\.glb$/.exec(path);
  if (m) {
    const name = m[1].toLowerCase();
    if (!zoneByName.has(name)) {
      sendJson(res, 404, { error: `unknown zone ${name}` });
      return;
    }
    try {
      const glb = await buildZone(name);
      send(res, 200, glb, 'model/gltf-binary', { 'Content-Disposition': `inline; filename="${sanitize(name)}.glb"` });
    } catch (e: any) {
      console.error(`[build] ${name} failed:`, e);
      sendJson(res, 500, { error: `build failed: ${e.message}`, stack: String(e.stack || '').split('\n').slice(0, 6) });
    }
    return;
  }
  if (path === '/api/sky/scene.glb') {
    if (!config.eqDir) {
      sendJson(res, 404, { error: 'no EverQuest directory' });
      return;
    }
    const skyPath = join(cacheDir, 'sky.glb');
    try {
      if (!existsSync(skyPath)) writeFileSync(skyPath, buildGlb(buildSkyScene(config.eqDir)));
      send(res, 200, readFileSync(skyPath), 'model/gltf-binary');
    } catch (e: any) {
      console.error('[sky] failed:', e.message);
      sendJson(res, 500, { error: `sky build failed: ${e.message}` });
    }
    return;
  }
  if (path === '/api/spawns/index.json') {
    const p = join(APP_DIR, 'spawns', 'index.json');
    if (!existsSync(p)) sendJson(res, 404, { error: 'no spawn data imported; see README (tools/import-spawns.ts)' });
    else send(res, 200, readFileSync(p), 'application/json; charset=utf-8');
    return;
  }
  m = /^\/api\/zone\/([^/]+)\/spawns\.json$/.exec(path);
  if (m) {
    const p = join(APP_DIR, 'spawns', `${sanitize(m[1].toLowerCase())}.json`);
    if (!existsSync(p)) sendJson(res, 404, { error: 'no spawn data for this zone' });
    else send(res, 200, readFileSync(p), 'application/json; charset=utf-8');
    return;
  }
  m = /^\/api\/zone\/([^/]+)\/npc-model\/(\d+)-(\d+)\.glb$/.exec(path);
  if (m) {
    const zone = m[1].toLowerCase();
    const code = modelCodeFor(Number(m[2]), Number(m[3]));
    if (!config.eqDir || !code) {
      sendJson(res, 404, { error: 'no model for this race' });
      return;
    }
    const modelPath = join(cacheDir, 'models', `${sanitize(zone)}_${code}.glb`);
    try {
      if (!existsSync(modelPath)) {
        const scene = buildCharacterScene(config.eqDir, zone, code);
        if (!scene) {
          sendJson(res, 404, { error: `model ${code} not found in the character archives` });
          return;
        }
        mkdirSync(dirname(modelPath), { recursive: true });
        writeFileSync(modelPath, buildGlb(scene));
      }
      send(res, 200, readFileSync(modelPath), 'model/gltf-binary', { 'Cache-Control': 'public, max-age=86400' });
    } catch (e: any) {
      console.error(`[model] ${code} failed:`, e.message);
      sendJson(res, 500, { error: `model build failed: ${e.message}` });
    }
    return;
  }
  m = /^\/api\/zone\/([^/]+)\/sounds\.json$/.exec(path);
  if (m) {
    const name = m[1].toLowerCase();
    const sounds = config.eqDir && zoneByName.has(name) ? loadZoneSounds(config.eqDir, name) : null;
    if (!sounds) sendJson(res, 404, { error: `no sound placements for ${name}` });
    else sendJson(res, 200, sounds);
    return;
  }
  m = /^\/api\/sound\/([^/]+)$/.exec(path);
  if (m) {
    const file = m[1].toLowerCase();
    if (!config.eqDir || !isSafeSoundName(file)) {
      sendJson(res, 404, { error: 'unknown sound' });
      return;
    }
    let data: Buffer | undefined;
    let type = 'audio/wav';
    if (file.endsWith('.mp3')) {
      const p = join(config.eqDir, file);
      if (existsSync(p)) data = readFileSync(p);
      type = 'audio/mpeg';
    } else {
      const archiveFile = soundArchiveFor(config.eqDir, file);
      data = archiveFile ? openArchive(archiveFile)?.get(file) : undefined;
    }
    if (!data) sendJson(res, 404, { error: `sound ${file} not found` });
    else send(res, 200, data, type, { 'Cache-Control': 'public, max-age=86400' });
    return;
  }
  m = /^\/api\/zone\/([^/]+)\/map\.json$/.exec(path);
  if (m) {
    const name = m[1].toLowerCase();
    const map = config.eqDir && zoneByName.has(name) ? loadZoneMap(config.eqDir, name, zones) : null;
    if (!map) sendJson(res, 404, { error: `no map files for ${name}` });
    else sendJson(res, 200, map);
    return;
  }
  m = /^\/api\/zone\/([^/]+)\/info\.json$/.exec(path);
  if (m) {
    const p = join(cacheDir, 'glb', `${sanitize(m[1].toLowerCase())}.json`);
    if (!existsSync(p)) {
      sendJson(res, 404, { error: 'not built yet' });
      return;
    }
    send(res, 200, readFileSync(p), 'application/json; charset=utf-8');
    return;
  }
  m = /^\/api\/zone\/[^/]+\/tex\/([^/]+)\/(.+?)(\.m)?\.png$/.exec(path);
  if (m) {
    const archiveFile = m[1];
    const file = m[2];
    const mask = m[3] === '.m';
    try {
      const png = texturePng(archiveFile, file, mask);
      if (!png) {
        sendJson(res, 404, { error: `texture ${archiveFile}/${file} not found or unsupported` });
        return;
      }
      send(res, 200, png, 'image/png', { 'Cache-Control': 'public, max-age=86400' });
    } catch (e: any) {
      console.error(`[tex] ${archiveFile}/${file} failed:`, e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  // static viewer files
  const rel = path === '/' ? '/index.html' : path;
  const body = readStatic(rel);
  if (!body) {
    send(res, 404, 'not found', 'text/plain');
    return;
  }
  send(res, 200, body, MIME[extname(rel)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn(`[server] could not open a browser automatically; open ${url} yourself.`);
  });
}

// ---------- startup ----------
console.log(`EQ Zone Viewer ${VERSION}`);

/** `--import-spawns <dump.sql>`: convert a Project EQ dump into spawns/<zone>.json next to the app, then exit. */
async function runSpawnImport(dump: string): Promise<void> {
  if (!dump || !existsSync(dump)) {
    console.error(`Usage: --import-spawns <path to a Project EQ .sql dump>${dump ? ` (not found: ${dump})` : ''}`);
    process.exit(2);
  }
  const outDir = join(APP_DIR, 'spawns');
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const zonesOut = await importSpawns(dump, (msg) => console.log(`[import] ${msg}`));
  const index: Record<string, number> = {};
  for (const [name, data] of zonesOut) {
    writeFileSync(join(outDir, `${sanitize(name)}.json`), JSON.stringify(data));
    index[name] = data.spawns.length;
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify({ importedAt: new Date().toISOString(), source: dump, zones: index }, null, 1));
  console.log(`[import] wrote ${zonesOut.size} zone files to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (config.importSpawns !== undefined) {
  runSpawnImport(config.importSpawns).then(
    () => process.exit(0),
    (e) => {
      console.error(`[import] failed: ${e.message}`);
      process.exit(1);
    },
  );
} else {
  startServer();
}

function startServer(): void {
setEqDir(config.eqDir);
if (config.eqDir) {
  console.log(`EverQuest dir: ${config.eqDir} (${config.eqDirSource})`);
  console.log(`Zones found: ${zones.length} (${zones.filter((z) => z.kind === 's3d').length} s3d, ${zones.filter((z) => z.kind === 'eqg').length} eqg)`);
} else {
  console.log('EverQuest dir: not found. Choose it in the browser, set EQ_DIR, pass it on the command line, or put "eqDir" in config.json.');
}
console.log(`Cache: ${cacheDir}`);

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    try {
      sendJson(res, 500, { error: String(e?.message || e) });
    } catch {
      /* ignore */
    }
  });
});

const HOST = process.env.HOST || '127.0.0.1';

function listen(port: number, retries: number): void {
  server.once('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`[server] port ${port} is already in use, trying ${port + 1}`);
      listen(port + 1, retries - 1);
    } else {
      console.error(`[server] could not listen on ${HOST}:${port}: ${e.message}`);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const shownHost = HOST === '0.0.0.0' || HOST === '::' || HOST === '127.0.0.1' ? 'localhost' : HOST;
    const url = `http://${shownHost}:${port}/`;
    console.log(`EQ Zone Viewer running at ${url}  (close this window or press Ctrl+C to stop)`);
    if (config.openBrowser) openBrowser(url);
  });
}

listen(config.port, 10);
}
