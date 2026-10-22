// Corner minimap (a top-down render of the zone with the camera marker), compass rose, and the
// high-resolution top-down map export.
import * as THREE from 'three';
import type { ViewerCtx } from './context.ts';

const MINIMAP_RES = 1024;

export function initMinimap(ctx: ViewerCtx): void {
  const { $, scene, renderer, camera } = ctx;
  const mapCanvas = $<HTMLCanvasElement>('minimap');
  const compassCanvas = $<HTMLCanvasElement>('compass');
  const g2 = mapCanvas.getContext('2d')!;
  const cg = compassCanvas.getContext('2d')!;
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
  ortho.layers.set(0);
  let image: HTMLCanvasElement | null = null;
  let zoom = 1;
  let renderTimes: number[] = [];
  let drawAcc = 0;
  let loadedAt = 0;

  /** Point the orthographic camera straight down at the whole zone, north (+x) up. */
  function frameZone(): boolean {
    const b = ctx.bounds();
    if (!b) return false;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const half = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2 + 20;
    ortho.left = -half;
    ortho.right = half;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.near = 1;
    ortho.far = b.max[1] - b.min[1] + 2000;
    ortho.position.set(cx, b.max[1] + 1000, cz);
    ortho.up.set(1, 0, 0);
    ortho.lookAt(cx, b.min[1], cz);
    ortho.updateProjectionMatrix();
    ortho.updateMatrixWorld();
    return true;
  }

  /** Render the zone from above into a canvas of the given size. */
  function renderTopDown(size: number): HTMLCanvasElement | null {
    if (!frameZone() || !ctx.zoneRoot()) return null;
    const max = renderer.capabilities.maxTextureSize;
    size = Math.min(size, max);
    const rt = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace });
    const fog = scene.fog;
    scene.fog = null;
    renderer.setRenderTarget(rt);
    renderer.render(scene, ortho);
    renderer.setRenderTarget(null);
    scene.fog = fog;
    const pixels = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);
    rt.dispose();
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const img = c.getContext('2d')!.createImageData(size, size);
    // WebGL rows are bottom-up.
    for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c;
  }

  /** Map a world position to minimap image pixels. */
  function toImage(x: number, z: number, size: number): [number, number] {
    const v = new THREE.Vector3(x, ortho.position.y - 10, z).project(ortho);
    return [((v.x + 1) / 2) * size, ((1 - v.y) / 2) * size];
  }

  function fromImage(px: number, py: number, size: number): [number, number] {
    const v = new THREE.Vector3((px / size) * 2 - 1, 1 - (py / size) * 2, 0).unproject(ortho);
    return [v.x, v.z];
  }

  /** Visible portion of the map image: the whole zone, or a window around the camera when zoomed. */
  function viewRect(): { sx: number; sy: number; sw: number } {
    const size = image?.width ?? MINIMAP_RES;
    const sw = size / zoom;
    if (zoom === 1) return { sx: 0, sy: 0, sw };
    const [px, py] = toImage(camera.position.x, camera.position.z, size);
    return { sx: Math.max(0, Math.min(size - sw, px - sw / 2)), sy: Math.max(0, Math.min(size - sw, py - sw / 2)), sw };
  }

  function draw(): void {
    const W = mapCanvas.width;
    g2.clearRect(0, 0, W, W);
    if (!image) {
      g2.fillStyle = 'rgba(20, 22, 28, 0.6)';
      g2.fillRect(0, 0, W, W);
      return;
    }
    const { sx, sy, sw } = viewRect();
    g2.drawImage(image, sx, sy, sw, sw, 0, 0, W, W);
    // camera marker
    const [px, py] = toImage(camera.position.x, camera.position.z, image.width);
    const mx = ((px - sx) / sw) * W;
    const my = ((py - sy) / sw) * W;
    const a = (ctx.heading() * Math.PI) / 180; // 0 = north = up, clockwise
    g2.save();
    g2.translate(mx, my);
    g2.rotate(a);
    g2.beginPath();
    g2.moveTo(0, -11);
    g2.lineTo(7, 8);
    g2.lineTo(0, 4);
    g2.lineTo(-7, 8);
    g2.closePath();
    g2.fillStyle = '#ffd24d';
    g2.strokeStyle = '#1a1407';
    g2.lineWidth = 2;
    g2.fill();
    g2.stroke();
    g2.restore();
    if (zoom > 1) {
      g2.fillStyle = 'rgba(255,255,255,0.8)';
      g2.font = '600 22px system-ui, sans-serif';
      g2.fillText(`${zoom}×`, 10, 28);
    }
  }

  function drawCompass(): void {
    const S = compassCanvas.width;
    const c = S / 2;
    cg.clearRect(0, 0, S, S);
    cg.save();
    cg.translate(c, c);
    cg.beginPath();
    cg.arc(0, 0, c - 3, 0, Math.PI * 2);
    cg.fillStyle = 'rgba(20, 22, 28, 0.82)';
    cg.fill();
    cg.strokeStyle = '#353a45';
    cg.lineWidth = 2;
    cg.stroke();
    cg.rotate((-ctx.heading() * Math.PI) / 180);
    const names = ['N', 'E', 'S', 'W'];
    cg.font = `700 ${Math.round(S * 0.22)}px system-ui, sans-serif`;
    cg.textAlign = 'center';
    cg.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2;
      const x = Math.sin(ang) * (c - 18);
      const y = -Math.cos(ang) * (c - 18);
      cg.fillStyle = i === 0 ? '#ff5a4a' : '#e6e8ee';
      cg.fillText(names[i], x, y + 1);
    }
    cg.restore();
    // fixed pointer at the top: the direction you are facing
    cg.beginPath();
    cg.moveTo(c, 2);
    cg.lineTo(c - 6, 12);
    cg.lineTo(c + 6, 12);
    cg.closePath();
    cg.fillStyle = '#ffd24d';
    cg.fill();
  }

  function refreshImage(): void {
    image = renderTopDown(MINIMAP_RES);
  }

  ctx.events.on('zoneLoaded', () => {
    image = null;
    zoom = 1;
    loadedAt = performance.now();
    // Textures arrive over the first seconds, so re-render the thumbnail a few times after the load.
    renderTimes = [200, 1500, 4000, 10000, 25000];
  });
  ctx.events.on('zoneCleared', () => {
    image = null;
    renderTimes = [];
    draw();
  });
  ctx.events.on('frame', (dt) => {
    if (renderTimes.length && performance.now() - loadedAt >= renderTimes[0]) {
      renderTimes.shift();
      refreshImage();
    }
    drawAcc += dt;
    if (drawAcc > 0.1) {
      drawAcc = 0;
      draw();
      drawCompass();
    }
  });

  mapCanvas.addEventListener('click', (e) => {
    if (!image) return;
    const r = mapCanvas.getBoundingClientRect();
    const { sx, sy, sw } = viewRect();
    const px = sx + ((e.clientX - r.left) / r.width) * sw;
    const py = sy + ((e.clientY - r.top) / r.height) * sw;
    const [x, z] = fromImage(px, py, image.width);
    const b = ctx.bounds();
    ctx.goTo(x, (b ? b.max[1] : 0) + 10, z, { ground: true });
  });
  mapCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom = e.deltaY < 0 ? Math.min(8, zoom * 2) : Math.max(1, zoom / 2);
    draw();
  });
  mapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  $('btn-topdown').addEventListener('click', () => {
    const zone = ctx.zone();
    if (!zone) return;
    ctx.setStatus('Rendering top-down map…');
    setTimeout(() => {
      const c = renderTopDown(4096);
      ctx.setStatus(`${zone.longName}  (${zone.name})`);
      if (!c) return;
      c.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${zone.name}-map.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }, 'image/png');
    }, 30);
  });

  draw();
  drawCompass();
}
