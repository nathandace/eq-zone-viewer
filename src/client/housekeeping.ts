// Cache size and clearing, and a once-a-day check for a newer release on GitHub.
import type { ViewerCtx } from './context.ts';

const RELEASES_API = 'https://api.github.com/repos/nathandace/eq-zone-viewer/releases/latest';
const RELEASES_PAGE = 'https://github.com/nathandace/eq-zone-viewer/releases';

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/** Compare dotted version strings: positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function initHousekeeping(ctx: ViewerCtx, version: string): void {
  const { $ } = ctx;
  const btn = $<HTMLButtonElement>('btn-cache');
  let armed = false;
  let armTimer = 0;

  async function refresh(): Promise<void> {
    try {
      const info = await (await fetch('/api/cache')).json();
      btn.textContent = `Cache ${fmtBytes(info.bytes)}`;
      btn.title = `Converted zones and textures in ${info.dir} (${info.files} files). Click twice to clear.`;
    } catch {
      btn.textContent = 'Cache';
    }
    armed = false;
    btn.classList.remove('armed');
  }

  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = 'Clear cache?';
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => void refresh(), 4000);
      return;
    }
    clearTimeout(armTimer);
    btn.textContent = 'Clearing…';
    try {
      await fetch('/api/cache/clear', { method: 'POST' });
      ctx.setStatus('Cache cleared; zones convert again on their next visit');
    } catch (e: any) {
      ctx.setStatus(`Could not clear the cache: ${e.message}`);
    }
    await refresh();
  });
  ctx.events.on('zoneLoaded', () => void refresh());
  void refresh();

  // Update check (at most once a day; silent on failure or offline).
  const update = $<HTMLAnchorElement>('update');
  void (async () => {
    try {
      const last = Number(localStorage.getItem('eqzv.updateCheck') || 0);
      let latest = localStorage.getItem('eqzv.latestVersion') || '';
      if (Date.now() - last > 24 * 3600 * 1000 || !latest) {
        const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) return;
        const rel = await res.json();
        latest = String(rel.tag_name || '');
        localStorage.setItem('eqzv.updateCheck', String(Date.now()));
        localStorage.setItem('eqzv.latestVersion', latest);
      }
      if (latest && version && compareVersions(latest, version) > 0) {
        update.textContent = `${latest} available`;
        update.href = RELEASES_PAGE;
        update.classList.remove('hidden');
      }
    } catch {
      /* offline or storage unavailable */
    }
  })();
}
