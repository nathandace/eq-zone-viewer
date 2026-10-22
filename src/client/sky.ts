// Sky dome and cloud layer from the client's sky.s3d. It lives in its own scene that is drawn first each
// frame, so the translucent cloud layer can never be sorted in front of the zone.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ViewerCtx } from './context.ts';

export function initSky(ctx: ViewerCtx): void {
  const { $, scene, camera, renderer } = ctx;
  const opt = $<HTMLInputElement>('opt-sky');
  const ambient = $<HTMLInputElement>('opt-ambient');
  const skyScene = new THREE.Scene();
  let group: THREE.Group | null = null;
  let radius = 1;
  let cloudMaps: THREE.Texture[] = [];
  let materials: THREE.MeshBasicMaterial[] = [];
  let loading = false;
  const dayColor = new THREE.Color(1, 1, 1);
  const nightColor = new THREE.Color(0.12, 0.14, 0.26);

  async function load(): Promise<void> {
    if (group || loading) return;
    loading = true;
    try {
      const loader = new GLTFLoader().setResourcePath('/api/zone/sky/'); // textures come from the zone texture route
      const gltf = await loader.loadAsync('/api/sky/scene.glb');
      const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
      radius = Math.max(1e-6, sphere.radius);
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.frustumCulled = false;
        m.renderOrder = m.name === 'clouds' || m.parent?.name === 'clouds' ? 1 : 0;
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshBasicMaterial[];
        for (const mat of mats) {
          mat.fog = false;
          mat.depthWrite = false;
          mat.depthTest = false;
          mat.side = THREE.DoubleSide;
          materials.push(mat);
          if (m.renderOrder === 1) {
            mat.transparent = true;
            if (mat.map) {
              mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
              cloudMaps.push(mat.map);
            }
          }
        }
      });
      group = gltf.scene;
      group.name = 'sky';
      skyScene.add(group);
      console.log(`[sky] loaded (${materials.length} materials)`);
    } catch (e) {
      console.warn('[sky] not available', e);
    } finally {
      loading = false;
    }
  }

  ctx.events.on('zoneLoaded', () => {
    if (opt.checked) void load();
  });
  ctx.events.on('frame', (dt) => {
    if (!group || !opt.checked || !ctx.zoneRoot() || ctx.underwater()) return;
    group.position.copy(camera.position);
    group.scale.setScalar((camera.far * 0.85) / radius);
    const night = 1 - Number(ambient.value) / 100;
    const c = dayColor.clone().lerp(nightColor, night * 0.9);
    for (const mat of materials) mat.color.copy(c);
    for (const map of cloudMaps) map.offset.x = (map.offset.x + dt * 0.004) % 1;
    // Draw the sky first; the main render then paints the zone over it without clearing.
    skyScene.background = scene.background;
    renderer.autoClear = true;
    renderer.render(skyScene, camera);
    renderer.autoClear = false;
  });
  opt.addEventListener('change', () => {
    if (opt.checked) void load();
  });
}
