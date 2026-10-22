// NPC spawn points from imported emulator data: name labels and markers at every spawn point, character
// models in their default pose where the client has one for the race, and an NPC list in the sidebar.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ViewerCtx } from './context.ts';

interface SpawnNpc {
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

interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  h: number;
  version: number;
  respawn: number;
  npcs: SpawnNpc[];
}

const LABEL_RANGE = 1200;

function displayName(name: string): string {
  return name.replace(/_+/g, ' ').replace(/\s*\d+$/, '').replace(/#/g, '').trim();
}

/** Emulator (x, y, z) -> viewer space: x = north = y, y = up = z, z = east = -x. */
function toViewer(s: SpawnPoint): THREE.Vector3 {
  return new THREE.Vector3(s.y, s.z, -s.x);
}

function labelTexture(text: string, sub: string): { texture: THREE.CanvasTexture; width: number; height: number } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const px = 14;
  g.font = `600 ${px}px system-ui, "Segoe UI", sans-serif`;
  const w = Math.ceil(Math.max(g.measureText(text).width, g.measureText(sub).width * 0.85)) + 16;
  const h = sub ? px * 2 + 12 : px + 12;
  c.width = w * 2;
  c.height = h * 2;
  g.scale(2, 2);
  g.fillStyle = 'rgba(16, 18, 24, 0.8)';
  g.beginPath();
  g.roundRect(0, 0, w, h, 6);
  g.fill();
  g.font = `600 ${px}px system-ui, "Segoe UI", sans-serif`;
  g.fillStyle = '#9fe0ff';
  g.textBaseline = 'top';
  g.fillText(text, 8, 6);
  if (sub) {
    g.font = `${px - 2}px system-ui, "Segoe UI", sans-serif`;
    g.fillStyle = '#c8ccd6';
    g.fillText(sub, 8, 6 + px + 2);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return { texture, width: w, height: h };
}

export function initNpcs(ctx: ViewerCtx): void {
  const { $, scene, camera } = ctx;
  const opt = $<HTMLInputElement>('opt-npcs');
  const list = $<HTMLUListElement>('npc-list');
  const filter = $<HTMLInputElement>('npc-filter');
  const count = $('npc-count');
  let group: THREE.Group | null = null;
  let labels: { sprite: THREE.Sprite; width: number; height: number }[] = [];
  let spawns: SpawnPoint[] = [];
  let frame = 0;
  const modelCache = new Map<string, Promise<THREE.Group | null>>();
  const markerGeo = new THREE.OctahedronGeometry(1.2);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.85, depthWrite: false });

  function clear(): void {
    if (group) {
      scene.remove(group);
      group.traverse((o) => {
        const s = o as THREE.Sprite;
        if (s.isSprite) {
          s.material.map?.dispose();
          s.material.dispose();
        }
      });
    }
    group = null;
    labels = [];
    spawns = [];
    modelCache.clear();
    list.innerHTML = '';
    count.textContent = '';
  }

  function loadModel(zone: string, npc: SpawnNpc): Promise<THREE.Group | null> {
    const key = `${npc.race}-${npc.gender === 1 ? 1 : 0}`;
    let p = modelCache.get(key);
    if (!p) {
      p = (async () => {
        try {
          const loader = new GLTFLoader().setResourcePath(`/api/zone/${zone}/`);
          const gltf = await loader.loadAsync(`/api/zone/${zone}/npc-model/${key}.glb`);
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshBasicMaterial[];
            for (const mat of mats) {
              mat.side = THREE.DoubleSide;
              if (mat.userData?.eqMode === 'mask') mat.alphaTest = Math.max(mat.alphaTest, 0.5);
            }
          });
          return gltf.scene;
        } catch {
          return null;
        }
      })();
      modelCache.set(key, p);
    }
    return p;
  }

  async function build(zone: string): Promise<void> {
    group = new THREE.Group();
    group.name = 'npcs';
    group.userData.eqKind = 'npc';
    scene.add(group);
    const byRace = new Map<string, SpawnPoint[]>();
    for (const s of spawns) {
      const npc = s.npcs[0];
      const p = toViewer(s);
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.copy(p).add(new THREE.Vector3(0, 1.5, 0));
      marker.name = displayName(npc.name);
      marker.userData.eqKind = 'npc';
      group.add(marker);
      const others = s.npcs.length > 1 ? ` +${s.npcs.length - 1}` : '';
      const { texture, width, height } = labelTexture(displayName(npc.name) + others, `level ${npc.level}`);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
      sprite.position.copy(p).add(new THREE.Vector3(0, 7.5, 0));
      sprite.center.set(0.5, 0);
      sprite.layers.set(ctx.layers.labels);
      sprite.raycast = () => undefined;
      sprite.renderOrder = 999;
      group.add(sprite);
      labels.push({ sprite, width, height });
      const key = `${npc.race}-${npc.gender === 1 ? 1 : 0}`;
      (byRace.get(key) ?? byRace.set(key, []).get(key)!).push(s);
    }
    updateLabels(true);
    console.log(`[npc] ${spawns.length} spawn points, ${byRace.size} race/gender models to try`);
    // Models, most common races first; each request is one race in default pose.
    const order = [...byRace.entries()].sort((a, b) => b[1].length - a[1].length);
    let placed = 0;
    for (const [, points] of order) {
      if (ctx.zone()?.name !== zone || !group) return;
      const model = await loadModel(zone, points[0].npcs[0]);
      if (!model || ctx.zone()?.name !== zone || !group) continue;
      for (const s of points) {
        const inst = model.clone();
        inst.position.copy(toViewer(s));
        inst.rotation.y = -(s.h / 512) * Math.PI * 2;
        inst.name = displayName(s.npcs[0].name);
        inst.userData.eqKind = 'npc';
        group.add(inst);
        placed++;
      }
    }
    console.log(`[npc] models placed at ${placed} of ${spawns.length} spawn points`);
  }

  function updateLabels(force = false): void {
    if (!labels.length || (!force && frame % 6 !== 0)) return;
    const h = ctx.canvas.clientHeight || 1;
    const k = (2 * Math.tan((camera.fov * Math.PI) / 360)) / h;
    const cam = camera.position;
    for (const { sprite, width, height } of labels) {
      const d = sprite.position.distanceTo(cam);
      sprite.visible = d < LABEL_RANGE;
      if (sprite.visible) sprite.scale.set(width * k, height * k, 1);
    }
  }

  function renderList(): void {
    list.innerHTML = '';
    if (!spawns.length) return;
    const q = filter.value.trim().toLowerCase();
    const byName = new Map<string, { npc: SpawnNpc; points: SpawnPoint[] }>();
    for (const s of spawns) {
      for (const npc of s.npcs) {
        const name = displayName(npc.name);
        const e = byName.get(name) ?? byName.set(name, { npc, points: [] }).get(name)!;
        e.points.push(s);
      }
    }
    const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
    let n = 0;
    for (const name of names) {
      if (q && !name.toLowerCase().includes(q)) continue;
      n++;
      const { npc, points } = byName.get(name)!;
      const li = document.createElement('li');
      li.textContent = name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `lvl ${npc.level}${points.length > 1 ? ` · ${points.length} spots` : ''}`;
      li.appendChild(tag);
      li.title = 'Go to this spawn point';
      let next = 0;
      li.addEventListener('click', () => {
        const s = points[next++ % points.length];
        const p = toViewer(s);
        ctx.goTo(p.x + 8, p.y + 6, p.z + 8, { ground: true });
      });
      list.appendChild(li);
    }
    count.textContent = `${n} of ${byName.size} NPCs · ${spawns.length} spawn points`;
  }

  async function load(zone: string): Promise<void> {
    try {
      const res = await fetch(`/api/zone/${zone}/spawns.json`);
      if (ctx.zone()?.name !== zone) return;
      if (!res.ok) {
        const idx = await fetch('/api/spawns/index.json');
        count.textContent = idx.ok ? 'No spawn data for this zone' : 'No spawn data imported (see README: tools/import-spawns.ts)';
        return;
      }
      const data = (await res.json()) as { spawns: SpawnPoint[] };
      if (ctx.zone()?.name !== zone) return;
      spawns = data.spawns.filter((s) => s.version === 0 && s.npcs.length);
      if (!spawns.length) spawns = data.spawns.filter((s) => s.npcs.length);
      renderList();
      if (opt.checked) await build(zone);
    } catch (e) {
      console.warn('[npc] failed to load', e);
    }
  }

  ctx.events.on('zoneCleared', clear);
  ctx.events.on('zoneLoaded', (z) => {
    clear();
    void load(z.name);
  });
  ctx.events.on('frame', () => {
    frame++;
    if (group) group.visible = opt.checked;
    updateLabels();
  });
  opt.addEventListener('change', () => {
    const zone = ctx.zone();
    if (opt.checked && !group && spawns.length && zone) void build(zone.name);
  });
  filter.addEventListener('input', renderList);
}
