// In-game map overlay: the lines and labels from the client's maps/ folder drawn in the world, a points-of-interest
// list in the sidebar, and travel through zone-line labels ("to Crushbone") into the matching spot of the next zone.
import * as THREE from 'three';
import type { ViewerCtx } from './context.ts';

interface MapLabel {
  p: [number, number, number];
  color: [number, number, number];
  size: number;
  text: string;
  target?: string;
}

interface ZoneMap {
  lines: number[];
  colors: number[];
  labels: MapLabel[];
  files: string[];
}

const LABEL_RANGE = 3000; // labels farther than this from the camera are hidden to keep the view readable
const EYE = 6;

function labelTexture(text: string, color: [number, number, number], size: number): { texture: THREE.CanvasTexture; width: number; height: number } {
  const px = size >= 3 ? 20 : size === 2 ? 17 : 14;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = `600 ${px}px system-ui, "Segoe UI", sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 16;
  const h = px + 12;
  c.width = w * 2;
  c.height = h * 2;
  g.scale(2, 2);
  g.font = `600 ${px}px system-ui, "Segoe UI", sans-serif`;
  g.fillStyle = 'rgba(16, 18, 24, 0.8)';
  g.beginPath();
  g.roundRect(0, 0, w, h, 6);
  g.fill();
  const bright = color[0] + color[1] + color[2] > 200 ? `rgb(${color.join(',')})` : '#f0e6c8';
  g.fillStyle = bright;
  g.textBaseline = 'middle';
  g.fillText(text, 8, h / 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return { texture, width: w, height: h };
}

export function initMaps(ctx: ViewerCtx): void {
  const { $, scene, camera } = ctx;
  const optLines = $<HTMLInputElement>('opt-maplines');
  const optLabels = $<HTMLInputElement>('opt-maplabels');
  const poiList = $<HTMLUListElement>('poi-list');
  const poiFilter = $<HTMLInputElement>('poi-filter');
  const poiCount = $('poi-count');

  let group: THREE.Group | null = null;
  let lines: THREE.LineSegments | null = null;
  let labelsGroup: THREE.Group | null = null;
  let labels: { sprite: THREE.Sprite; width: number; height: number; label: MapLabel }[] = [];
  let current: ZoneMap | null = null;
  let arriveFrom: string | null = null;
  let arriveWalking = false;
  let frameCount = 0;

  function clear(): void {
    if (group) {
      scene.remove(group);
      group.traverse((o) => {
        const s = o as THREE.Sprite;
        if (s.isSprite) {
          s.material.map?.dispose();
          s.material.dispose();
        }
        const l = o as THREE.LineSegments;
        if (l.isLineSegments) {
          l.geometry.dispose();
          (l.material as THREE.Material).dispose();
        }
      });
    }
    group = lines = labelsGroup = null;
    labels = [];
    current = null;
    poiList.innerHTML = '';
    poiCount.textContent = '';
  }

  function build(map: ZoneMap): void {
    group = new THREE.Group();
    group.name = 'map';
    if (map.lines.length) {
      const pos = new Float32Array(map.lines.length);
      const col = new Float32Array(map.lines.length);
      for (let i = 0; i < map.lines.length; i += 3) {
        pos[i] = map.lines[i];
        pos[i + 1] = map.lines[i + 1] + 0.6; // sit just above the floor the line was drawn on
        pos[i + 2] = map.lines[i + 2];
      }
      for (let s = 0; s < map.colors.length / 3; s++) {
        let r = map.colors[s * 3] / 255;
        let g = map.colors[s * 3 + 1] / 255;
        let b = map.colors[s * 3 + 2] / 255;
        if (r + g + b < 0.6) {
          // Black and dark grey lines (the in-game default) vanish against dark ground; draw them parchment-coloured.
          r = 0.92;
          g = 0.88;
          b = 0.72;
        }
        for (let v = 0; v < 2; v++) {
          const o = (s * 2 + v) * 3;
          col[o] = r;
          col[o + 1] = g;
          col[o + 2] = b;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
      lines.name = 'map-lines';
      lines.raycast = () => undefined; // never part of collision or picking
      lines.frustumCulled = false;
      lines.visible = optLines.checked;
      group.add(lines);
    }
    labelsGroup = new THREE.Group();
    labelsGroup.visible = optLabels.checked;
    for (const label of map.labels) {
      const { texture, width, height } = labelTexture(label.target ? `→ ${label.text}` : label.text, label.color, label.size);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
      sprite.position.set(label.p[0], label.p[1] + 4, label.p[2]);
      sprite.center.set(0.5, 0);
      sprite.layers.set(ctx.layers.labels);
      sprite.raycast = () => undefined;
      sprite.renderOrder = 1000;
      labelsGroup.add(sprite);
      labels.push({ sprite, width, height, label });
    }
    group.add(labelsGroup);
    scene.add(group);
    updateLabels(true);
    console.log(`[map] ${map.files.join(', ')}: ${map.lines.length / 6} lines, ${map.labels.length} labels, ${map.labels.filter((l) => l.target).length} zone lines`);
  }

  /** Screen-constant label size and distance culling (called a few times a second). */
  function updateLabels(force = false): void {
    if (!labels.length || (!force && frameCount % 6 !== 0)) return;
    const h = ctx.canvas.clientHeight || 1;
    const k = (2 * Math.tan((camera.fov * Math.PI) / 360)) / h;
    const cam = camera.position;
    for (const { sprite, width, height } of labels) {
      const d = sprite.position.distanceTo(cam);
      sprite.visible = d < LABEL_RANGE;
      if (sprite.visible) sprite.scale.set(width * k, height * k, 1);
    }
  }

  function goToLabel(label: MapLabel): void {
    ctx.goTo(label.p[0], label.p[1] + EYE, label.p[2], { ground: true });
  }

  async function travel(label: MapLabel): Promise<void> {
    if (!label.target) return;
    const from = ctx.zone()?.name ?? null;
    ctx.setStatus(`Travelling to ${label.text.replace(/^to\s+/i, '')}…`);
    arriveFrom = from;
    arriveWalking = ctx.walking(); // keep walking when crossing a zone line on foot
    const ok = await ctx.loadZone(label.target);
    if (!ok) arriveFrom = null;
  }

  function renderPoi(): void {
    poiList.innerHTML = '';
    if (!current) {
      poiCount.textContent = 'No map file for this zone';
      return;
    }
    const q = poiFilter.value.trim().toLowerCase();
    const sorted = [...current.labels].sort((a, b) => Number(!!b.target) - Number(!!a.target) || a.text.localeCompare(b.text));
    let n = 0;
    for (const label of sorted) {
      if (q && !label.text.toLowerCase().includes(q)) continue;
      n++;
      const li = document.createElement('li');
      li.textContent = label.text;
      if (label.target) {
        li.classList.add('zoneline');
        const targetZone = ctx.zones().find((z) => z.name === label.target);
        li.title = `Travel to ${targetZone?.longName ?? label.target}`;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'zone line';
        li.appendChild(tag);
        li.addEventListener('click', () => void travel(label));
      } else {
        li.title = `Go to ${label.text}`;
        li.addEventListener('click', () => goToLabel(label));
      }
      poiList.appendChild(li);
    }
    poiCount.textContent = `${n} of ${current.labels.length} points · ${current.lines.length / 6} map lines`;
  }

  async function load(zoneName: string): Promise<void> {
    try {
      const res = await fetch(`/api/zone/${zoneName}/map.json`);
      if (ctx.zone()?.name !== zoneName) return;
      if (!res.ok) {
        current = null;
        renderPoi();
        return;
      }
      const map = (await res.json()) as ZoneMap;
      if (ctx.zone()?.name !== zoneName) return;
      current = map;
      build(map);
      renderPoi();
      if (arriveFrom) {
        const from = arriveFrom;
        arriveFrom = null;
        const entry = map.labels.find((l) => l.target === from);
        if (entry) {
          goToLabel(entry);
          ctx.setStatus(`${ctx.zone()?.longName}  (arrived from ${ctx.zones().find((z) => z.name === from)?.longName ?? from})`);
        }
        if (arriveWalking) {
          arriveWalking = false;
          ctx.setWalkMode(true);
        }
      }
    } catch (e) {
      console.warn('[map] failed to load', e);
    }
  }

  ctx.events.on('zoneCleared', clear);
  ctx.events.on('zoneLoaded', (z) => {
    clear();
    void load(z.name);
  });
  ctx.events.on('frame', () => {
    frameCount++;
    updateLabels();
  });
  optLines.addEventListener('change', () => {
    if (lines) lines.visible = optLines.checked;
  });
  optLabels.addEventListener('change', () => {
    if (labelsGroup) labelsGroup.visible = optLabels.checked;
  });
  poiFilter.addEventListener('input', renderPoi);
}
