// Browser viewer: zone list, GLB loading, free-fly camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Fast raycasts against zone geometry (walk mode, "Go to /loc").
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface ZoneInfo {
  name: string;
  kind: 's3d' | 'eqg';
  longName: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const statusEl = $('status');
const statsEl = $('stats');
const warningsEl = $('warnings');
const hintEl = $('hint');
const listEl = $<HTMLUListElement>('zone-list');
const filterEl = $<HTMLInputElement>('filter');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const SKY = new THREE.Color(0x8fb4d9);
scene.background = SKY;
const camera = new THREE.PerspectiveCamera(70, 1, 1, 30000);
const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x6b5a3a, 1.1);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.4, 1, 0.3);
scene.add(hemi, sun);

const eqUniforms = {
  eqAmbient: { value: 0.85 },
  eqLightScale: { value: 1.0 },
  eqVertexEnabled: { value: 1.0 },
};

let zoneRoot: THREE.Group | null = null;
let currentZone: ZoneInfo | null = null;
let zones: ZoneInfo[] = [];
let start: { position: number[]; target: number[] } | null = null;
let zoneBounds: { min: number[]; max: number[] } | null = null;
const animated: { material: THREE.Material & { map: THREE.Texture | null }; frames: THREE.Texture[]; delay: number; t: number; i: number }[] = [];
let unlitMaterials = new Map<THREE.Material, THREE.Material>();
let litMaterials = new Map<THREE.Material, THREE.Material>();

// ---------- UI ----------
const opts = {
  objects: $<HTMLInputElement>('opt-objects'),
  lit: $<HTMLInputElement>('opt-lit'),
  fog: $<HTMLInputElement>('opt-fog'),
  wireframe: $<HTMLInputElement>('opt-wireframe'),
  cull: $<HTMLInputElement>('opt-cull'),
  vcolor: $<HTMLInputElement>('opt-vcolor'),
  walk: $<HTMLInputElement>('opt-walk'),
  ambient: $<HTMLInputElement>('opt-ambient'),
  speed: $<HTMLInputElement>('opt-speed'),
  fov: $<HTMLInputElement>('opt-fov'),
};

function setStatus(s: string): void {
  statusEl.textContent = s;
}

async function loadZoneList(): Promise<void> {
  const res = await fetch('/api/zones');
  zones = await res.json();
  renderList();
}

function renderList(): void {
  const q = filterEl.value.trim().toLowerCase();
  listEl.innerHTML = '';
  let n = 0;
  for (const z of zones) {
    if (q && !z.name.includes(q) && !z.longName.toLowerCase().includes(q)) continue;
    n++;
    const li = document.createElement('li');
    li.dataset.name = z.name;
    if (currentZone?.name === z.name) li.classList.add('active');
    const left = document.createElement('span');
    left.textContent = z.longName;
    const right = document.createElement('span');
    right.className = 'short';
    right.textContent = z.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = z.kind;
    right.appendChild(kind);
    li.append(left, right);
    li.addEventListener('click', () => loadZone(z));
    listEl.appendChild(li);
  }
  $('zone-count').textContent = `${n} of ${zones.length} zones`;
}

filterEl.addEventListener('input', renderList);

// ---------- Materials ----------
function patchMaterial(mat: THREE.Material, mode: string): void {
  const m = mat as THREE.Material & { onBeforeCompile: any; customProgramCacheKey: any; userData: any };
  m.userData.eqColorMode = mode;
  m.customProgramCacheKey = () => `eq-${mode}`;
  m.onBeforeCompile = (shader: any) => {
    shader.uniforms.eqAmbient = eqUniforms.eqAmbient;
    shader.uniforms.eqLightScale = eqUniforms.eqLightScale;
    shader.uniforms.eqVertexEnabled = eqUniforms.eqVertexEnabled;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float eqAmbient;\nuniform float eqLightScale;\nuniform float eqVertexEnabled;')
      .replace(
        '#include <color_fragment>',
        mode === 'add'
          ? `#if defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix(vec3(1.0), clamp(vec3(eqAmbient) + vColor.rgb * eqLightScale, 0.0, 1.0), eqVertexEnabled);
#elif defined( USE_COLOR )
  diffuseColor.rgb *= mix(vec3(1.0), clamp(vec3(eqAmbient) + vColor * eqLightScale, 0.0, 1.0), eqVertexEnabled);
#else
  diffuseColor.rgb *= mix(vec3(1.0), vec3(clamp(eqAmbient + 0.5 * eqLightScale, 0.0, 1.0)), eqVertexEnabled);
#endif`
          : `#if defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix(vec3(1.0), clamp(vColor.rgb * 2.0 * (0.4 + 0.6 * eqAmbient), 0.0, 1.0), eqVertexEnabled);
#elif defined( USE_COLOR )
  diffuseColor.rgb *= mix(vec3(1.0), clamp(vColor * 2.0 * (0.4 + 0.6 * eqAmbient), 0.0, 1.0), eqVertexEnabled);
#else
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.4 + 0.6 * eqAmbient), eqVertexEnabled);
#endif`,
      );
  };
  m.needsUpdate = true;
}

function makeLit(unlit: THREE.MeshBasicMaterial): THREE.Material {
  const lit = new THREE.MeshLambertMaterial({
    map: unlit.map,
    color: unlit.color.clone(),
    transparent: unlit.transparent,
    opacity: unlit.opacity,
    alphaTest: unlit.alphaTest,
    side: unlit.side,
    vertexColors: unlit.vertexColors,
    blending: unlit.blending,
    depthWrite: unlit.depthWrite,
    wireframe: unlit.wireframe,
  });
  lit.userData = { ...unlit.userData };
  patchMaterial(lit, unlit.userData.eqColorMode || 'add');
  return lit;
}

function applyMaterialOptions(): void {
  if (!zoneRoot) return;
  const useLit = opts.lit.checked;
  zoneRoot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((m) => {
      const base = unlitMaterials.get(m) ?? m;
      let target: THREE.Material = base;
      if (useLit) {
        let lit = litMaterials.get(base);
        if (!lit) {
          lit = makeLit(base as THREE.MeshBasicMaterial);
          litMaterials.set(base, lit);
          unlitMaterials.set(lit, base);
        }
        target = lit;
      }
      const t = target as THREE.MeshBasicMaterial;
      t.wireframe = opts.wireframe.checked;
      t.side = opts.cull.checked ? THREE.FrontSide : THREE.DoubleSide;
      t.needsUpdate = true;
      return target;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
  eqUniforms.eqVertexEnabled.value = opts.vcolor.checked ? 1 : 0;
}

function applyFog(): void {
  if (!zoneBounds) return;
  const size = Math.max(zoneBounds.max[0] - zoneBounds.min[0], zoneBounds.max[2] - zoneBounds.min[2], 500);
  scene.fog = opts.fog.checked ? new THREE.Fog(SKY, size * 0.6, size * 1.6) : null;
}

// ---------- Loading ----------
const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
let loadToken = 0;

async function loadZone(z: ZoneInfo): Promise<void> {
  const token = ++loadToken;
  currentZone = z;
  if (walk.enabled) setWalkMode(false); // walk mode is per zone: a new zone starts in free flight
  if (!location.hash.includes(`zone=${z.name}`)) location.hash = `zone=${z.name}`;
  renderList();
  setStatus(`Loading ${z.longName}… (first load builds the zone, this can take a few seconds)`);
  statsEl.textContent = '';
  warningsEl.classList.add('hidden');
  ($('btn-export') as HTMLAnchorElement).href = `/api/zone/${z.name}/scene.glb`;
  ($('btn-export') as HTMLAnchorElement).setAttribute('download', `${z.name}.glb`);
  try {
    const url = `/api/zone/${z.name}/scene.glb`;
    const head = await fetch(url);
    if (!head.ok) {
      const err = await head.json().catch(() => ({ error: head.statusText }));
      throw new Error(err.error || head.statusText);
    }
    const buf = await head.arrayBuffer();
    if (token !== loadToken) return;
    setStatus(`Loading textures for ${z.longName}…`);
    loader.setPath(`/api/zone/${z.name}/`);
    const gltf = await loader.parseAsync(buf, `/api/zone/${z.name}/`);
    if (token !== loadToken) return;
    clearZone();
    zoneRoot = gltf.scene;
    const extras = (gltf.parser.json as any).extras || {};
    start = extras.start || null;
    zoneBounds = extras.bounds || null;
    setupMaterials(gltf);
    scene.add(zoneRoot);
    applyMaterialOptions();
    applyFog();
    resetCamera();
    applyHashCamera();
    setStatus(`${z.longName}  (${z.name})`);
    showWarnings(extras);
  } catch (e: any) {
    console.error(e);
    setStatus(`Failed to load ${z.name}: ${e.message}`);
  }
}

function clearZone(): void {
  if (zoneRoot) {
    scene.remove(zoneRoot);
    zoneRoot.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
  for (const [, m] of unlitMaterials) m.dispose();
  for (const [, m] of litMaterials) m.dispose();
  unlitMaterials = new Map();
  litMaterials = new Map();
  animated.length = 0;
  walk.ready = false;
  zoneRoot = null;
}

function setupMaterials(gltf: any): void {
  const isEqg = currentZone?.kind === 'eqg';
  const seen = new Set<THREE.Material>();
  gltf.scene.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      const mb = m as THREE.MeshBasicMaterial;
      const extras = (mb.userData || {}) as any;
      if (extras.eqMode === 'additive') {
        mb.blending = THREE.AdditiveBlending;
        mb.transparent = true;
        mb.depthWrite = false;
      }
      if (extras.eqMode === 'blend') {
        mb.depthWrite = false;
      }
      if (mb.map) {
        mb.map.anisotropy = 8;
      }
      patchMaterial(mb, isEqg ? 'mul2' : 'add');
      if (extras.eqAnim && Array.isArray(extras.eqAnim.frames)) {
        const frames = extras.eqAnim.frames.map((uri: string) => {
          const t = texLoader.load(`/api/zone/${currentZone!.name}/${uri}`);
          t.flipY = false;
          t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 8;
          return t;
        });
        animated.push({ material: mb, frames, delay: Math.max(50, extras.eqAnim.delayMs || 100), t: 0, i: 0 });
      }
    }
  });
}

function showWarnings(extras: any): void {
  const stats = extras.stats || {};
  const w: string[] = extras.warnings || [];
  const lines = Object.entries(stats).map(([k, v]) => `<b>${k}</b>: ${v}`);
  if (w.length) lines.push(`<b>warnings (${w.length})</b>`, ...w.slice(0, 40).map((s) => `· ${s}`));
  warningsEl.innerHTML = lines.join('<br>');
  warningsEl.classList.toggle('hidden', lines.length === 0);
}

// ---------- Camera / controls ----------
const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let speed = 180;
const velocity = new THREE.Vector3();
let pointerLocked = false;

// ---------- Walk mode (gravity + collision) ----------
const EYE_HEIGHT = 6; // EverQuest units; the camera sits at a character's eye level
const STEP_HEIGHT = 3; // ledges lower than this are stepped over instead of blocking
const BODY_RADIUS = 1.5;
const GRAVITY = 60;
const JUMP_SPEED = 20;
const WALK_SPEED = 45;
const walk = { enabled: false, vy: 0, grounded: false, ready: false };
const walkRay = new THREE.Raycaster();
walkRay.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** Water and sky surfaces, and hidden objects, do not block movement. */
function isCollidable(obj: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    if (!o.visible) return false;
    const k = o.userData?.eqKind;
    if (k === 'water' || k === 'sky') return false;
  }
  return true;
}

/** Build BVH trees for every geometry in the zone the first time walk mode needs them. */
function prepareCollision(): void {
  if (!zoneRoot || walk.ready) return;
  const t0 = performance.now();
  const seen = new Set<THREE.BufferGeometry>();
  zoneRoot.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || seen.has(m.geometry)) return;
    seen.add(m.geometry);
    if (!m.geometry.boundsTree) m.geometry.computeBoundsTree();
  });
  walk.ready = true;
  console.log(`[walk] collision ready: ${seen.size} geometries in ${(performance.now() - t0).toFixed(0)}ms`);
}

/** Nearest collidable surface along a ray within `far` units, or null. */
function castRay(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null {
  if (!zoneRoot) return null;
  walkRay.set(origin, dir);
  walkRay.near = 0;
  walkRay.far = far;
  for (const hit of walkRay.intersectObject(zoneRoot, true)) if (isCollidable(hit.object)) return hit;
  return null;
}

/** World-space surface normal of a hit, facing against the ray. */
function hitNormal(hit: THREE.Intersection, dir: THREE.Vector3): THREE.Vector3 {
  const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : dir.clone().negate();
  if (n.dot(dir) > 0) n.negate();
  return n;
}

/** Lowest collidable surface under a point (so a forest canopy or a bridge is not mistaken for the ground). */
function groundBelow(x: number, y: number, z: number): THREE.Intersection | null {
  if (!zoneRoot) return null;
  walkRay.firstHitOnly = false;
  walkRay.set(new THREE.Vector3(x, y, z), DOWN);
  walkRay.near = 0;
  walkRay.far = 1e6;
  let lowest: THREE.Intersection | null = null;
  for (const hit of walkRay.intersectObject(zoneRoot, true)) {
    if (isCollidable(hit.object) && (!lowest || hit.distance > lowest.distance)) lowest = hit;
  }
  walkRay.firstHitOnly = true;
  return lowest;
}

/** Put the camera at eye height on the ground (walk mode switch-on, zone load, respawn). */
function settleOnGround(): void {
  const p = camera.position;
  let hit = castRay(new THREE.Vector3(p.x, p.y + STEP_HEIGHT, p.z), DOWN, 1e6);
  if (!hit && zoneBounds) {
    // Nothing under the camera: the start view usually floats outside the map, so drop in at the point it looks at.
    const t = start ? start.target : [(zoneBounds.min[0] + zoneBounds.max[0]) / 2, 0, (zoneBounds.min[2] + zoneBounds.max[2]) / 2];
    hit = groundBelow(t[0], zoneBounds.max[1] + 10, t[2]);
    if (hit) {
      p.x = t[0];
      p.z = t[2];
    }
  }
  if (hit) p.y = hit.point.y + EYE_HEIGHT;
  walk.vy = 0;
  walk.grounded = !!hit;
}

function setWalkMode(on: boolean): void {
  walk.enabled = on;
  opts.walk.checked = on;
  const btn = $('btn-walk');
  btn.classList.toggle('on', on);
  btn.textContent = on ? 'Walk mode: on' : 'Walk mode: off';
  if (on && zoneRoot) {
    prepareCollision();
    settleOnGround();
    // Look at the horizon rather than straight down at the map.
    pitch = Math.max(pitch, -0.1);
    updateCameraRotation();
  }
}

/** Back to the zone's start point: the overview in free flight, standing on the ground in walk mode. */
function returnToStart(): void {
  resetCamera();
  if (walk.enabled && zoneRoot) {
    settleOnGround();
    pitch = Math.max(pitch, -0.1);
    updateCameraRotation();
  }
}

/** One frame of character-style movement: walls block and slide, small ledges are stepped over, gravity and jumping apply. */
function walkStep(dt: number): void {
  const p = camera.position;
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const move = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
  if (move.lengthSq() > 0) {
    let s = WALK_SPEED;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) s *= 2;
    if (keys.has('ControlLeft') || keys.has('ControlRight')) s *= 0.4;
    move.normalize().multiplyScalar(s * dt);
    // Walls: probe at knee and eye height; slide along whatever is hit (twice, for corners).
    for (let i = 0; i < 2 && move.lengthSq() > 1e-8; i++) {
      const dir = move.clone().normalize();
      const reach = move.length() + BODY_RADIUS;
      const knee = new THREE.Vector3(p.x, p.y - EYE_HEIGHT + STEP_HEIGHT, p.z);
      const hit = castRay(knee, dir, reach) ?? castRay(p, dir, reach);
      if (!hit) break;
      const n = hitNormal(hit, dir);
      n.y = 0;
      if (n.lengthSq() < 1e-6) break;
      n.normalize();
      move.sub(n.multiplyScalar(move.dot(n)));
    }
    p.add(move);
  }
  // Vertical: jump, gravity, head bumps, landing.
  if ((keys.has('Space') || keys.has('KeyE')) && walk.grounded) {
    walk.vy = JUMP_SPEED;
    walk.grounded = false;
  }
  walk.vy = Math.max(walk.vy - GRAVITY * dt, -400);
  const dy = walk.vy * dt;
  const knee = new THREE.Vector3(p.x, p.y - EYE_HEIGHT + STEP_HEIGHT, p.z);
  if (dy < 0) {
    // Look down from knee height so steps and slopes under STEP_HEIGHT are climbed and we never tunnel through a floor.
    const ground = castRay(knee, DOWN, STEP_HEIGHT - dy + (walk.grounded ? 1.5 : 0.1));
    if (ground) {
      p.y = ground.point.y + EYE_HEIGHT;
      walk.vy = 0;
      walk.grounded = true;
    } else {
      p.y += dy;
      walk.grounded = false;
    }
  } else {
    if (castRay(p, UP, dy + 1)) walk.vy = 0;
    else p.y += dy;
    walk.grounded = false;
  }
  // Fell out of the world: back to the zone's start point.
  if (p.y < (zoneBounds ? zoneBounds.min[1] - 500 : -10000)) {
    resetCamera();
    settleOnGround();
  }
}

function resetCamera(): void {
  if (start) {
    camera.position.set(start.position[0], start.position[1], start.position[2]);
    const t = new THREE.Vector3(start.target[0], start.target[1], start.target[2]);
    const d = t.clone().sub(camera.position).normalize();
    yaw = Math.atan2(-d.x, -d.z);
    pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
  } else {
    camera.position.set(0, 100, 300);
    yaw = 0;
    pitch = -0.2;
  }
  if (zoneBounds) {
    const size = Math.max(zoneBounds.max[0] - zoneBounds.min[0], zoneBounds.max[2] - zoneBounds.min[2], 200);
    speed = Math.max(60, Math.min(600, size / 12));
    opts.speed.value = String(Math.round(Math.log(speed / 10) / Math.log(200) * 100));
    camera.far = Math.max(5000, size * 4);
    camera.updateProjectionMatrix();
  }
  updateCameraRotation();
}

/** Optional URL parameters: #zone=name&cam=x,y,z,yaw,pitch (glTF space, radians) or &view=top, &amb=0..1, &objects=0 */
function applyHashCamera(): void {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const cam = params.get('cam');
  if (cam) {
    const v = cam.split(',').map(Number);
    if (v.length >= 3 && v.every((n) => Number.isFinite(n))) {
      camera.position.set(v[0], v[1], v[2]);
      if (v.length >= 5) {
        yaw = v[3];
        pitch = v[4];
        updateCameraRotation();
      }
    }
  }
  if (params.get('view') === 'top') topView();
  const yawP = params.get('yaw');
  const pitchP = params.get('pitch');
  if (yawP !== null || pitchP !== null) {
    if (yawP !== null) yaw = Number(yawP);
    if (pitchP !== null) pitch = Number(pitchP);
    updateCameraRotation();
  }
  const loc = params.get('loc');
  if (loc) {
    const v = loc.split(',').map(Number);
    if (v.length >= 2 && v.every((n) => Number.isFinite(n))) goToLoc(v[0], v[1], v.length >= 3 ? v[2] : undefined);
  }
  const amb = params.get('amb');
  if (amb !== null) {
    opts.ambient.value = String(Math.round(Number(amb) * 100));
    opts.ambient.dispatchEvent(new Event('input'));
  }
  if (params.get('objects') === '0') {
    opts.objects.checked = false;
    applyVisibility();
  }
  if (params.get('lit') === '1') {
    opts.lit.checked = true;
    applyMaterialOptions();
  }
  if (params.get('walk') === '1') setWalkMode(true);
  if (params.get('fog') === '0') {
    opts.fog.checked = false;
    applyFog();
  }
}

/** Move the camera to an EverQuest /loc (Y, X, Z). Without Z the ground under that point is found by raycast. */
function goToLoc(locY: number, locX: number, locZ?: number): void {
  const gx = locY;
  const gz = -locX;
  let gy = locZ;
  if (gy === undefined && zoneRoot) {
    const ray = new THREE.Raycaster(new THREE.Vector3(gx, 20000, gz), new THREE.Vector3(0, -1, 0), 0, 40000);
    const hits = ray.intersectObject(zoneRoot, true).filter((h) => h.object.userData?.eqKind !== 'object');
    // Use the lowest surface so indoor zones land on the floor rather than the roof.
    gy = hits.length ? hits[hits.length - 1].point.y + 6 : 50;
  }
  camera.position.set(gx, gy ?? 50, gz);
  pitch = Math.max(Math.min(pitch, 0), -0.15);
  updateCameraRotation();
}

function topView(): void {
  if (!zoneBounds) return;
  const cx = (zoneBounds.min[0] + zoneBounds.max[0]) / 2;
  const cz = (zoneBounds.min[2] + zoneBounds.max[2]) / 2;
  const size = Math.max(zoneBounds.max[0] - zoneBounds.min[0], zoneBounds.max[2] - zoneBounds.min[2]);
  camera.position.set(cx, zoneBounds.max[1] + size * 0.8, cz);
  yaw = -Math.PI / 2; // north (+x) up on screen
  pitch = -Math.PI / 2 + 0.001;
  updateCameraRotation();
}

function updateCameraRotation(): void {
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

canvas.addEventListener('click', () => {
  if (!pointerLocked) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  hintEl.classList.toggle('hidden', pointerLocked || !zoneRoot);
});
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  updateCameraRotation();
});
canvas.addEventListener('wheel', (e) => {
  speed *= Math.pow(1.15, -Math.sign(e.deltaY));
  speed = THREE.MathUtils.clamp(speed, 5, 5000);
  opts.speed.value = String(Math.round((Math.log(speed / 10) / Math.log(200)) * 100));
  e.preventDefault();
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.code === 'KeyR') returnToStart();
  if (e.code === 'KeyT') topView();
  if (e.code === 'KeyG') setWalkMode(!walk.enabled);
  if (e.code === 'KeyO') {
    opts.objects.checked = !opts.objects.checked;
    applyVisibility();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function applyVisibility(): void {
  if (!zoneRoot) return;
  zoneRoot.traverse((o) => {
    if (o.userData && o.userData.eqKind === 'object') o.visible = opts.objects.checked;
  });
}

opts.objects.addEventListener('change', applyVisibility);
opts.lit.addEventListener('change', applyMaterialOptions);
opts.wireframe.addEventListener('change', applyMaterialOptions);
opts.cull.addEventListener('change', applyMaterialOptions);
opts.vcolor.addEventListener('change', applyMaterialOptions);
opts.fog.addEventListener('change', applyFog);
opts.walk.addEventListener('change', () => setWalkMode(opts.walk.checked));
opts.ambient.addEventListener('input', () => {
  const v = Number(opts.ambient.value) / 100;
  eqUniforms.eqAmbient.value = v;
  const night = 1 - v;
  scene.background = SKY.clone().lerp(new THREE.Color(0x0a0d18), night * 0.9);
  if (scene.fog) (scene.fog as THREE.Fog).color.copy(scene.background as THREE.Color);
  hemi.intensity = 0.3 + 0.9 * v;
  sun.intensity = 1.4 * v;
});
opts.speed.addEventListener('input', () => {
  speed = 10 * Math.pow(200, Number(opts.speed.value) / 100);
});
opts.fov.addEventListener('input', () => {
  camera.fov = Number(opts.fov.value);
  camera.updateProjectionMatrix();
});
$('btn-reset').addEventListener('click', returnToStart);
$('btn-start').addEventListener('click', returnToStart);
$('btn-walk').addEventListener('click', () => setWalkMode(!walk.enabled));
$('btn-top').addEventListener('click', topView);
$<HTMLInputElement>('goto').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = (e.target as HTMLInputElement).value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n));
  if (v.length >= 2) goToLoc(v[0], v[1], v.length >= 3 ? v[2] : undefined);
});

// ---------- Render loop ----------
const clock = new THREE.Clock();
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 0;

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

function tick(): void {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  resize();
  // movement
  if (walk.enabled && zoneRoot) walkStep(dt);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  velocity.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) velocity.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) velocity.sub(forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) velocity.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) velocity.sub(right);
  if (keys.has('KeyE') || keys.has('Space')) velocity.y += 1;
  if (keys.has('KeyQ') || keys.has('KeyC')) velocity.y -= 1;
  if (velocity.lengthSq() > 0) {
    let s = speed;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) s *= 4;
    if (keys.has('ControlLeft') || keys.has('ControlRight')) s *= 0.25;
    velocity.normalize().multiplyScalar(s * dt);
    if (!walk.enabled || !zoneRoot) camera.position.add(velocity);
  }
  // texture animation
  for (const a of animated) {
    a.t += dt * 1000;
    if (a.t >= a.delay) {
      a.t = 0;
      a.i = (a.i + 1) % a.frames.length;
      a.material.map = a.frames[a.i];
      a.material.needsUpdate = false;
    }
  }
  renderer.render(scene, camera);
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc >= 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
    const p = camera.position;
    const info = renderer.info.render;
    statsEl.textContent = `${fps.toFixed(0)} fps   ${info.calls} draws   ${(info.triangles / 1000).toFixed(0)}k tris
/loc ${p.x.toFixed(1)}, ${(-p.z).toFixed(1)}, ${p.y.toFixed(1)}   heading ${(((-yaw * 180) / Math.PI + 90 + 720) % 360).toFixed(0)}°   speed ${speed.toFixed(0)}`;
  }
}

// ---------- Setup (EverQuest folder) ----------
interface ConfigInfo {
  eqDir?: string;
  source?: string;
  ok: boolean;
  candidates: string[];
  configPath: string;
  zones: number;
  version: string;
}

const setupEl = $('setup');
const setupInput = $<HTMLInputElement>('setup-path');
const setupMsg = $('setup-msg');
const setupCandidates = $('setup-candidates');

async function fetchConfig(): Promise<ConfigInfo> {
  const res = await fetch('/api/config');
  return res.json();
}

function showFolder(cfg: ConfigInfo): void {
  const el = $('eq-folder');
  el.textContent = cfg.eqDir || 'not set';
  el.title = cfg.eqDir ? `${cfg.eqDir} (${cfg.source})` : '';
}

function showSetup(cfg: ConfigInfo): void {
  setupEl.classList.remove('hidden');
  setupInput.value = cfg.eqDir || cfg.candidates[0] || '';
  setupMsg.textContent = cfg.ok
    ? ''
    : 'No EverQuest folder was found automatically. Enter the folder the game is installed in (it contains eqgame.exe and many .s3d / .eqg files).';
  setupCandidates.innerHTML = '';
  if (cfg.candidates.length) {
    const label = document.createElement('div');
    label.className = 'muted';
    label.textContent = 'Found on this computer:';
    setupCandidates.appendChild(label);
    for (const c of cfg.candidates) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c;
      b.addEventListener('click', () => {
        setupInput.value = c;
        setupInput.focus();
      });
      setupCandidates.appendChild(b);
    }
  }
  setupCandidates.classList.toggle('hidden', cfg.candidates.length === 0);
  $('setup-cancel').classList.toggle('hidden', !cfg.ok);
  setupInput.focus();
  setupInput.select();
}

async function submitSetup(): Promise<void> {
  const eqDir = setupInput.value.trim();
  if (!eqDir) return;
  setupMsg.textContent = 'Checking…';
  const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eqDir }) });
  const cfg = await res.json();
  if (!res.ok || !cfg.ok) {
    setupMsg.textContent = cfg.error || 'That folder does not look like an EverQuest install.';
    return;
  }
  setupEl.classList.add('hidden');
  showFolder(cfg);
  clearZone();
  currentZone = null;
  await loadZoneList();
  setStatus(zones.length ? 'Select a zone' : 'No zones were found in that folder');
  bootFromHash();
}

$('setup-ok').addEventListener('click', () => void submitSetup());
setupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitSetup();
});
$('setup-cancel').addEventListener('click', () => setupEl.classList.add('hidden'));
$('btn-folder').addEventListener('click', () => void fetchConfig().then(showSetup));

// ---------- Boot ----------
function bootFromHash(): void {
  const m = /zone=([a-z0-9_\-]+)/i.exec(location.hash);
  if (!m) return;
  const z = zones.find((z) => z.name === m[1].toLowerCase());
  if (z) void loadZone(z);
}

(window as any).eqViewer = { loadZone, zones: () => zones, camera, scene };
fetchConfig()
  .then(async (cfg) => {
    showFolder(cfg);
    if (cfg.ok) {
      await loadZoneList();
      bootFromHash();
    } else {
      setStatus('Choose your EverQuest folder to begin');
    }
    // #setup=1 opens the folder chooser even when a folder is already known.
    if (!cfg.ok || new URLSearchParams(location.hash.slice(1)).has('setup')) showSetup(cfg);
  })
  .catch((e) => setStatus(`Could not reach the server: ${e.message}`));
tick();
