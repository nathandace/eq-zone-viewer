// Placed zone lights (torches, lamps, braziers) for the shaded-lighting mode: the nearest few become
// three.js point lights and follow the camera around.
import * as THREE from 'three';
import type { ViewerCtx } from './context.ts';

const POOL = 8;

interface ZoneLight {
  p: THREE.Vector3;
  color: THREE.Color;
  radius: number;
}

export function initLights(ctx: ViewerCtx): void {
  const { $, scene, camera } = ctx;
  const optLit = $<HTMLInputElement>('opt-lit');
  const pool = Array.from({ length: POOL }, () => {
    const l = new THREE.PointLight(0xffffff, 0, 0, 2);
    l.visible = false;
    scene.add(l);
    return l;
  });
  let lights: ZoneLight[] = [];
  let acc = 1;

  function hideAll(): void {
    for (const l of pool) l.visible = false;
  }

  ctx.events.on('zoneLoaded', (_zone, extras) => {
    lights = ((extras?.lights ?? []) as { position: number[]; color: number[]; radius: number }[]).map((l) => ({
      p: new THREE.Vector3(l.position[0], l.position[1], l.position[2]),
      color: new THREE.Color(l.color[0], l.color[1], l.color[2]),
      radius: l.radius,
    }));
    acc = 1;
    if (lights.length) console.log(`[lights] ${lights.length} placed lights`);
  });
  ctx.events.on('zoneCleared', () => {
    lights = [];
    hideAll();
  });
  ctx.events.on('frame', (dt) => {
    acc += dt;
    if (acc < 0.25) return;
    acc = 0;
    if (!optLit.checked || !lights.length) {
      hideAll();
      return;
    }
    const cam = camera.position;
    const nearest = lights
      .map((l) => ({ l, d: l.p.distanceTo(cam) - l.radius }))
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL);
    pool.forEach((pl, i) => {
      const n = nearest[i];
      if (!n) {
        pl.visible = false;
        return;
      }
      pl.position.copy(n.l.p);
      pl.color.copy(n.l.color);
      pl.distance = n.l.radius * 1.6;
      pl.intensity = n.l.radius * 6;
      pl.visible = true;
    });
  });
  optLit.addEventListener('change', () => {
    acc = 1;
    if (!optLit.checked) hideAll();
  });
}
