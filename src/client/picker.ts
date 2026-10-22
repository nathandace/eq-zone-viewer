// Click-to-identify: a plain click (not a drag) on the view shows what was hit (object, material, /loc),
// and the Textures panel lists the textures of the loaded zone.
import * as THREE from 'three';
import type { ViewerCtx } from './context.ts';

export function initPicker(ctx: ViewerCtx): void {
  const { $, camera, canvas } = ctx;
  const tip = $('pick');
  const texList = $<HTMLUListElement>('tex-list');
  const texDetails = $<HTMLDetailsElement>('textures');
  const texCount = $('tex-count');
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  let downAt: { x: number; y: number; t: number } | null = null;
  let hideTimer = 0;
  let gltfJson: any = null;
  let texRendered = false;

  function kindOf(o: THREE.Object3D | null): string {
    for (let p = o; p; p = p.parent) if (p.userData?.eqKind) return p.userData.eqKind;
    return '?';
  }

  function nameOf(o: THREE.Object3D): string {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name && !/^(zone|water|instanced)/.test(p.name)) return p.name;
    return o.name || '(unnamed)';
  }

  function hide(): void {
    tip.classList.add('hidden');
  }

  function pick(clientX: number, clientY: number): void {
    const root = ctx.zoneRoot();
    if (!root) return;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    ray.setFromCamera(ndc, camera);
    ray.far = camera.far;
    const hit = ray.intersectObject(root, true).find((h) => {
      for (let p: THREE.Object3D | null = h.object; p; p = p.parent) if (!p.visible) return false;
      return true;
    });
    if (!hit) {
      hide();
      return;
    }
    const mesh = hit.object as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat = (hit.face && Array.isArray(mesh.material) ? mats[Math.min(hit.face.materialIndex, mats.length - 1)] : mats[0]) as THREE.MeshBasicMaterial;
    const kind = kindOf(mesh);
    const p = hit.point;
    const lines = [
      `<b>${kind === 'object' ? nameOf(mesh) : kind}</b>${kind === 'object' ? ' <span class="muted">object</span>' : ''}`,
      `material: ${mat?.name || '(none)'}${mat?.userData?.eqMode ? ` <span class="muted">${mat.userData.eqMode}</span>` : ''}`,
      `/loc ${p.x.toFixed(1)}, ${(-p.z).toFixed(1)}, ${p.y.toFixed(1)} · ${hit.distance.toFixed(0)} units away`,
    ];
    tip.innerHTML = lines.join('<br>');
    tip.style.left = `${Math.min(clientX - r.left + 14, r.width - 320)}px`;
    tip.style.top = `${Math.min(clientY - r.top + 14, r.height - 80)}px`;
    tip.classList.remove('hidden');
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 8000);
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 400;
    downAt = null;
    if (moved < 4 && quick) pick(e.clientX, e.clientY);
  });

  function renderTextures(): void {
    texList.innerHTML = '';
    const zone = ctx.zone();
    if (!gltfJson || !zone) {
      texCount.textContent = 'Load a zone first';
      return;
    }
    const seen = new Set<string>();
    const items: { name: string; uri: string }[] = [];
    for (const m of gltfJson.materials ?? []) {
      const texIndex = m.pbrMetallicRoughness?.baseColorTexture?.index;
      if (texIndex === undefined) continue;
      const src = gltfJson.textures?.[texIndex]?.source;
      const uri = gltfJson.images?.[src]?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      items.push({ name: m.name || uri.split('/').pop(), uri: `/api/zone/${zone.name}/${uri}` });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = it.uri;
      img.alt = it.name;
      const span = document.createElement('span');
      span.textContent = it.name;
      li.append(img, span);
      li.title = `Open ${it.uri}`;
      li.addEventListener('click', () => window.open(it.uri, '_blank'));
      texList.appendChild(li);
    }
    texCount.textContent = `${items.length} textures`;
    texRendered = true;
  }

  ctx.events.on('zoneLoaded', (_z, _extras, json) => {
    gltfJson = json ?? null;
    texRendered = false;
    hide();
    if (texDetails.open) renderTextures();
  });
  ctx.events.on('zoneCleared', () => {
    gltfJson = null;
    texRendered = false;
    texList.innerHTML = '';
    hide();
  });
  texDetails.addEventListener('toggle', () => {
    if (texDetails.open && !texRendered) renderTextures();
  });
}
