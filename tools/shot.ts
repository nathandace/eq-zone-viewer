// Headless screenshot of the running viewer, driven over the Chrome DevTools protocol in real time.
// Usage: node tools/shot.ts "<hash params>" out.png [--port 3081] [--width 1280] [--height 720] [--wait 1500] [--timeout 60000] [--eval "<js>"]
// Example: node tools/shot.ts "zone=gfaydark&walk=1" gfay.png --wait 2000
//          node tools/shot.ts "zone=gfaydark" travel.png --eval "document.querySelector('#poi-list li.zoneline').click()" --wait 8000
// Waits until the viewer reports the zone as loaded (window.eqViewer.state().loaded), then `--wait` ms more,
// takes the screenshot, and prints the page's console messages. Exit code 1 if the zone never loads.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const hash = args[0] || '';
const out = args[1] || 'shot.png';
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const port = opt('port', process.env.PORT || '3080');
const width = Number(opt('width', '1280'));
const height = Number(opt('height', '720'));
const settle = Number(opt('wait', '1500'));
const timeout = Number(opt('timeout', '60000'));
const evalJs = opt('eval', ''); // JavaScript to run in the page once the zone is loaded, before the settle wait
const url = `http://localhost:${port}/#${hash}`;

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = process.env.CHROME || candidates.find((c) => existsSync(c));
if (!browser) {
  console.error('No Chrome or Edge found; set CHROME=<path to browser executable>');
  process.exit(2);
}

const chrome = spawn(browser, [
  '--headless=new',
  '--remote-debugging-port=0',
  '--disable-gpu-sandbox',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  `--window-size=${width},${height}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-sync',
  `--user-data-dir=${process.env.TEMP || '/tmp'}/eqzv-shot-${process.pid}`,
  'about:blank',
]);

const wsUrl: string = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d.toString();
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', (code) => reject(new Error(`browser exited early (${code})`)));
  setTimeout(() => reject(new Error('browser did not start')), 20000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const consoleLines: string[] = [];
let sessionId = '';
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(`${msg.params.type}: ${msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`EXCEPTION: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  }
});
function send(method: string, params: Record<string, unknown> = {}, withSession = true): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(withSession && sessionId ? { sessionId } : {}) }));
  });
}

const { result: target } = await send('Target.createTarget', { url: 'about:blank' }, false);
const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false);
sessionId = attach.result.sessionId;
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

const t0 = Date.now();
let loaded = false;
while (Date.now() - t0 < timeout) {
  const r = await send('Runtime.evaluate', { expression: 'window.eqViewer ? JSON.stringify(window.eqViewer.state()) : "null"', returnByValue: true });
  const state = r.result?.result?.value ? JSON.parse(r.result.result.value) : null;
  if (state?.loaded && (!hash.includes('walk=1') || state.walk?.ready)) {
    loaded = true;
    break;
  }
  await new Promise((r2) => setTimeout(r2, 250));
}
if (loaded && evalJs) {
  const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
  console.log(`eval: ${JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null)}`);
}
if (loaded) await new Promise((r) => setTimeout(r, settle));
const stateR = await send('Runtime.evaluate', { expression: 'window.eqViewer ? JSON.stringify(window.eqViewer.state()) : "null"', returnByValue: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
await send('Browser.close', {}, false).catch(() => undefined);
chrome.kill();

console.log(`${loaded ? 'loaded' : 'NOT LOADED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
console.log(`state: ${stateR.result?.result?.value}`);
for (const line of consoleLines) console.log(`  ${line}`);
process.exit(loaded ? 0 : 1);
