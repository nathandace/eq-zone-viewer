// GLB writer for a ZoneScene. Emits KHR_materials_unlit, EXT_mesh_gpu_instancing and a few extras the client reads.
import type { ZoneScene, SceneMaterial, TextureRef } from './scene.ts';

const GL_FLOAT = 5126;
const GL_UNSIGNED_INT = 5125;
const GL_UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

class BinBuilder {
  parts: Buffer[] = [];
  length = 0;
  views: any[] = [];
  accessors: any[] = [];

  addView(data: ArrayBufferView, target?: number, byteStride?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(Buffer.alloc(pad));
      this.length += pad;
    }
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const view: any = { buffer: 0, byteOffset: this.length, byteLength: buf.length };
    if (target !== undefined) view.target = target;
    if (byteStride !== undefined) view.byteStride = byteStride;
    this.parts.push(buf);
    this.length += buf.length;
    this.views.push(view);
    return this.views.length - 1;
  }

  addAccessor(data: ArrayBufferView, componentType: number, type: string, count: number, opts: { target?: number; normalized?: boolean; minmax?: boolean } = {}): number {
    const view = this.addView(data, opts.target);
    const acc: any = { bufferView: view, componentType, count, type };
    if (opts.normalized) acc.normalized = true;
    if (opts.minmax) {
      const n = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : type === 'VEC4' ? 4 : 1;
      const arr = data as unknown as ArrayLike<number>;
      const min = new Array(n).fill(Infinity);
      const max = new Array(n).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < n; k++) {
          const v = arr[i * n + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      acc.min = min;
      acc.max = max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  finish(): Buffer {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) this.parts.push(Buffer.alloc(pad));
    return Buffer.concat(this.parts);
  }
}

export function textureUri(t: TextureRef): string {
  const ext = t.mask ? '.m.png' : '.png';
  return `tex/${encodeURIComponent(t.archive)}/${encodeURIComponent(t.file)}${ext}`;
}

export function buildGlb(scene: ZoneScene): Buffer {
  const bin = new BinBuilder();
  const json: any = {
    asset: { version: '2.0', generator: 'eq-zone-viewer' },
    extensionsUsed: ['KHR_materials_unlit', 'EXT_mesh_gpu_instancing'],
    scene: 0,
    scenes: [{ nodes: [] as number[] }],
    nodes: [] as any[],
    meshes: [] as any[],
    materials: [] as any[],
    textures: [] as any[],
    images: [] as any[],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    bufferViews: bin.views,
    accessors: bin.accessors,
    buffers: [] as any[],
    extras: {
      zone: scene.name,
      bounds: scene.bounds,
      start: scene.start,
      sky: scene.sky,
      stats: scene.stats,
      warnings: scene.warnings.slice(0, 200),
    },
  };

  const imageIndex = new Map<string, number>();
  const textureIndex = new Map<string, number>();
  const texture = (t: TextureRef): number => {
    const uri = textureUri(t);
    const existing = textureIndex.get(uri);
    if (existing !== undefined) return existing;
    let ii: number | undefined = imageIndex.get(uri);
    if (ii === undefined) {
      ii = json.images.length as number;
      json.images.push({ uri, name: t.file });
      imageIndex.set(uri, ii);
    }
    const ti: number = json.textures.length;
    json.textures.push({ source: ii, sampler: 0, name: t.file });
    textureIndex.set(uri, ti);
    return ti;
  };

  const materialIndex = new Map<number, number>();
  const materialFor = (i: number): number => {
    const hit = materialIndex.get(i);
    if (hit !== undefined) return hit;
    const m: SceneMaterial = scene.materials[i];
    const color = m.color ?? [1, 1, 1];
    const mat: any = {
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: [color[0], color[1], color[2], m.mode === 'blend' ? m.opacity : 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: m.doubleSided,
      extensions: { KHR_materials_unlit: {} },
      extras: { eqMode: m.mode, eqUnlit: m.unlit, eqNoFog: m.noFog ? true : undefined },
    };
    if (m.texture) mat.pbrMetallicRoughness.baseColorTexture = { index: texture(m.texture) };
    if (m.mode === 'mask') {
      mat.alphaMode = 'MASK';
      mat.alphaCutoff = 0.5;
    } else if (m.mode === 'blend' || m.mode === 'additive') {
      mat.alphaMode = 'BLEND';
    }
    if (m.frames && m.frames.length > 1) {
      mat.extras.eqAnim = { delayMs: m.animDelayMs ?? 100, frames: m.frames.map((f) => textureUri(f)) };
    }
    const idx = json.materials.length;
    json.materials.push(mat);
    materialIndex.set(i, idx);
    return idx;
  };

  const meshIndex = new Map<number, number>();
  const meshFor = (i: number): number => {
    const hit = meshIndex.get(i);
    if (hit !== undefined) return hit;
    const m = scene.meshes[i];
    const vcount = m.positions.length / 3;
    const pos = bin.addAccessor(m.positions, GL_FLOAT, 'VEC3', vcount, { target: ARRAY_BUFFER, minmax: true });
    const nrm = m.normals ? bin.addAccessor(m.normals, GL_FLOAT, 'VEC3', vcount, { target: ARRAY_BUFFER }) : undefined;
    const uv = m.uvs ? bin.addAccessor(m.uvs, GL_FLOAT, 'VEC2', vcount, { target: ARRAY_BUFFER }) : undefined;
    const col = m.colors ? bin.addAccessor(m.colors, GL_UNSIGNED_BYTE, 'VEC3', vcount, { target: ARRAY_BUFFER, normalized: true }) : undefined;
    const primitives: any[] = [];
    for (const g of m.groups) {
      if (g.indices.length === 0) continue;
      const mat = scene.materials[g.material];
      if (!mat || mat.mode === 'invisible') continue;
      const attributes: any = { POSITION: pos };
      if (nrm !== undefined) attributes.NORMAL = nrm;
      if (uv !== undefined) attributes.TEXCOORD_0 = uv;
      if (col !== undefined) attributes.COLOR_0 = col;
      const idx = bin.addAccessor(g.indices, GL_UNSIGNED_INT, 'SCALAR', g.indices.length, { target: ELEMENT_ARRAY_BUFFER });
      primitives.push({ attributes, indices: idx, material: materialFor(g.material), mode: 4 });
    }
    const idx = json.meshes.length;
    json.meshes.push({ name: m.name, primitives });
    meshIndex.set(i, idx);
    return idx;
  };

  for (const node of scene.nodes) {
    if (node.instances.length === 0) continue;
    const mesh = scene.meshes[node.mesh];
    if (!mesh || mesh.positions.length === 0) continue;
    const gltfMesh = meshFor(node.mesh);
    if (json.meshes[gltfMesh].primitives.length === 0) continue;
    const n: any = { name: node.name, mesh: gltfMesh, extras: { eqKind: node.kind } };
    if (node.instances.length === 1) {
      const inst = node.instances[0];
      n.translation = inst.position;
      n.rotation = inst.rotation;
      n.scale = inst.scale;
    } else {
      const count = node.instances.length;
      const t = new Float32Array(count * 3);
      const r = new Float32Array(count * 4);
      const s = new Float32Array(count * 3);
      const hasColor = node.instances.some((i) => i.color);
      const c = hasColor ? new Float32Array(count * 3) : undefined;
      node.instances.forEach((inst, k) => {
        t.set(inst.position, k * 3);
        r.set(inst.rotation, k * 4);
        s.set(inst.scale, k * 3);
        if (c) c.set(inst.color ?? [1, 1, 1], k * 3);
      });
      const attributes: any = {
        TRANSLATION: bin.addAccessor(t, GL_FLOAT, 'VEC3', count, { minmax: true }),
        ROTATION: bin.addAccessor(r, GL_FLOAT, 'VEC4', count),
        SCALE: bin.addAccessor(s, GL_FLOAT, 'VEC3', count),
      };
      if (c) attributes._COLOR_0 = bin.addAccessor(c, GL_FLOAT, 'VEC3', count);
      n.extensions = { EXT_mesh_gpu_instancing: { attributes } };
      n.extras.instanceCount = count;
    }
    json.scenes[0].nodes.push(json.nodes.length);
    json.nodes.push(n);
  }

  const binBuf = bin.finish();
  json.buffers.push({ byteLength: binBuf.length });
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4 !== 0) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const jsonChunk = Buffer.alloc(8);
  jsonChunk.writeUInt32LE(jsonBuf.length, 0);
  jsonChunk.write('JSON', 4, 'latin1');
  const binChunk = Buffer.alloc(8);
  binChunk.writeUInt32LE(binBuf.length, 0);
  binChunk.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonChunk, jsonBuf, binChunk, binBuf]);
}
