// Builds a self-contained release: one executable that embeds the server, the viewer and its assets,
// using Node's single-executable-application support. The Node binary that runs this script is the one
// that gets shipped, so run it with the Node version you want users to have.
//
// Usage: npm run release
// Output: release/eq-zone-viewer-<version>-<os>-<arch>/   and   release/eq-zone-viewer-<version>-<os>-<arch>.zip
import { build } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform;
const NAME = `eq-zone-viewer-${pkg.version}-${os}-${process.arch}`;
const RELEASE = join(ROOT, 'release');
const BUILD = join(RELEASE, 'build');
const OUT = join(RELEASE, NAME);
const EXE = join(OUT, process.platform === 'win32' ? 'eq-zone-viewer.exe' : 'eq-zone-viewer');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const { inject } = createRequire(import.meta.url)('postject') as {
  inject: (file: string, resource: string, data: Buffer, opts: { sentinelFuse: string; machoSegmentName?: string }) => Promise<void>;
};

function step(msg: string): void {
  console.log(`\n== ${msg}`);
}

function run(cmd: string, args: string[], cwd = BUILD): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

rmSync(BUILD, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });

step('Bundling the viewer (browser)');
await build({
  entryPoints: [join(ROOT, 'src/client/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outfile: join(BUILD, 'bundle.js'),
  logLevel: 'warning',
});

step('Bundling the server (CommonJS, as single executables require)');
await build({
  entryPoints: [join(ROOT, 'src/server/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(BUILD, 'server.cjs'),
  define: { 'process.env.EQZV_VERSION': JSON.stringify(pkg.version) },
  // import.meta.url is only evaluated when not running as a single executable (see src/server/config.ts).
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
});

step('Bundling the zone build worker');
await build({
  entryPoints: [join(ROOT, 'src/server/build-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(BUILD, 'build-worker.cjs'),
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
});

step('Preparing the single-executable blob');
const seaConfig = {
  main: 'server.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets: {
    'index.html': join(ROOT, 'public', 'index.html'),
    'style.css': join(ROOT, 'public', 'style.css'),
    'bundle.js': join(BUILD, 'bundle.js'),
    'build-worker.cjs': join(BUILD, 'build-worker.cjs'),
  },
};
writeFileSync(join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

step(`Creating ${EXE} from ${process.execPath} (Node ${process.version})`);
copyFileSync(process.execPath, EXE);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', EXE]);
await inject(EXE, 'NODE_SEA_BLOB', readFileSync(join(BUILD, 'sea-prep.blob')), {
  sentinelFuse: SENTINEL_FUSE,
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (process.platform === 'darwin') run('codesign', ['--sign', '-', EXE]);
if (process.platform !== 'win32') chmodSync(EXE, 0o755);

step('Adding documentation');
copyFileSync(join(ROOT, 'README.md'), join(OUT, 'README.md'));
if (existsSync(join(ROOT, 'docs'))) cpSync(join(ROOT, 'docs'), join(OUT, 'docs'), { recursive: true });
if (existsSync(join(ROOT, 'LICENSE'))) copyFileSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'));
copyFileSync(join(ROOT, 'config.example.json'), join(OUT, 'config.example.json'));
writeFileSync(
  join(OUT, 'README.txt'),
  [
    `EQ Zone Viewer ${pkg.version}`,
    '',
    'Browse EverQuest zones in 3D, read straight from your own EverQuest install.',
    '',
    'This download contains NO EverQuest game files. You need EverQuest installed on this',
    'computer; the viewer reads the zone archives (.s3d / .eqg) from that folder and never',
    'changes them.',
    '',
    'How to use',
    `  1. Run ${process.platform === 'win32' ? 'eq-zone-viewer.exe' : './eq-zone-viewer'}. A console window opens and your browser opens the viewer.`,
    '  2. If the viewer could not find EverQuest on its own, it asks for the game folder',
    '     (the one with eqgame.exe in it). The choice is saved to config.json next to the app.',
    '  3. Click a zone in the list. The first visit converts the zone (a few seconds); after',
    '     that it loads from the cache folder next to the app.',
    '  4. Close the console window (or press Ctrl+C in it) to stop the viewer.',
    '',
    'Options',
    '  eq-zone-viewer.exe "D:\\Games\\EverQuest"   use that game folder for this run',
    '  eq-zone-viewer.exe --no-open               do not open a browser automatically',
    '  set PORT=3090                              use another port (default 3080)',
    '  set EQ_DIR=...                             game folder from the environment',
    '',
    'Controls, settings and troubleshooting are described in README.md.',
    `Source code and updates: ${pkg.homepage}`,
    '',
  ].join('\n'),
);

step('Zipping');
const zip = `${OUT}.zip`;
rmSync(zip, { force: true });
if (process.platform === 'win32') {
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`], RELEASE);
} else {
  run('zip', ['-r', '-q', zip, NAME], RELEASE);
}
console.log(`\nDone: ${zip}`);
