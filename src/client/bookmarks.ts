// Per-zone bookmarks (saved in the browser), "copy link to this view", and the screenshot button.
import type { ViewerCtx } from './context.ts';

interface Bookmark {
  name: string;
  cam: [number, number, number, number, number];
  walk: boolean;
}

const KEY = 'eqzv.bookmarks';

function readAll(): Record<string, Bookmark[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Bookmark[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function initBookmarks(ctx: ViewerCtx): void {
  const { $, camera } = ctx;
  const list = $<HTMLUListElement>('bm-list');
  const nameInput = $<HTMLInputElement>('bm-name');

  function render(): void {
    list.innerHTML = '';
    const zone = ctx.zone();
    const items = zone ? readAll()[zone.name] ?? [] : [];
    for (const [i, bm] of items.entries()) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = bm.name;
      label.title = `/loc ${bm.cam[0].toFixed(0)}, ${(-bm.cam[2]).toFixed(0)}, ${bm.cam[1].toFixed(0)}`;
      label.addEventListener('click', () => {
        ctx.goTo(bm.cam[0], bm.cam[1], bm.cam[2]);
        ctx.setView(bm.cam[3], bm.cam[4]);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Remove bookmark';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const all = readAll();
        all[zone!.name].splice(i, 1);
        if (!all[zone!.name].length) delete all[zone!.name];
        writeAll(all);
        render();
      });
      li.append(label, del);
      list.appendChild(li);
    }
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'muted empty';
      li.textContent = zone ? 'No bookmarks in this zone yet' : 'Load a zone first';
      list.appendChild(li);
    }
  }

  function add(): void {
    const zone = ctx.zone();
    if (!zone) return;
    const p = camera.position;
    const name = nameInput.value.trim() || `/loc ${p.x.toFixed(0)}, ${(-p.z).toFixed(0)}, ${p.y.toFixed(0)}`;
    const all = readAll();
    (all[zone.name] ??= []).push({ name, cam: [p.x, p.y, p.z, ctx.yaw(), ctx.pitch()], walk: ctx.walking() });
    writeAll(all);
    nameInput.value = '';
    render();
  }

  $('bm-add').addEventListener('click', add);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });

  $('btn-link').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}${ctx.viewLink()}`;
    try {
      await navigator.clipboard.writeText(link);
      ctx.setStatus('Link copied to the clipboard');
    } catch {
      prompt('Copy this link', link);
    }
    setTimeout(() => {
      const z = ctx.zone();
      if (z) ctx.setStatus(`${z.longName}  (${z.name})`);
    }, 2000);
  });

  $('btn-shot').addEventListener('click', () => {
    const zone = ctx.zone();
    if (!zone) return;
    ctx.renderer.render(ctx.scene, camera);
    ctx.canvas.toBlob((blob) => {
      if (!blob) return;
      const p = camera.position;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${zone.name} ${p.x.toFixed(0)},${(-p.z).toFixed(0)},${p.y.toFixed(0)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  });

  ctx.events.on('zoneLoaded', render);
  ctx.events.on('zoneCleared', render);
  render();
}
