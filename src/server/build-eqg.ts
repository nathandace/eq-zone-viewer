// Builds a ZoneScene from EQG archives: binary ZON (v1/v2) + TER, or text ZON (v4) + DAT heightmap terrain.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PfsArchive } from './pfs.ts';
import {
  isTextZon,
  matProp,
  parseEco,
  parseMds,
  parseTerMod,
  parseTog,
  parseV4Terrain,
  parseZonBinary,
  parseZonV4,
  tokenize,
  type EqgGeometry,
  type EqgMaterial,
  type V4Tile,
  type ZonV4,
} from './eqg.ts';
import {
  Bounds,
  MaterialTable,
  MeshMerger,
  composeTransform,
  eqToGl,
  quatFromEqEuler,
  transformEqToGl,
  type Instance,
  type MeshNode,
  type SceneMaterial,
  type SceneMesh,
  type Transform,
  type Vec3,
  type ZoneScene,
} from './scene.ts';

const DEG = Math.PI / 180;
// EQ stores rotations for a row-vector (Direct3D) convention; negate for column-vector math.
const ROT_SIGN = -1;
// v4 terrain placeables live in a frame whose x/y are swapped relative to the world; that mirror flips rotation sense back.
const V4_ROT_SIGN = 1;
const SKIP_FLAGGED_QUADS = true;

interface ArchiveEntry {
  file: string;
  archive: PfsArchive;
  names: Set<string>;
}

export class EqgBuilder {
  readonly eqDir: string;
  readonly zone: string;
  readonly materials = new MaterialTable();
  readonly meshes: SceneMesh[] = [];
  readonly nodes: MeshNode[] = [];
  readonly warnings: string[] = [];
  private archives: ArchiveEntry[] = [];
  private geometryCache = new Map<string, number>(); // model file -> mesh index (-1 = failed)
  private matCache = new Map<string, number>();
  private missing = new Map<string, number>();
  private bounds = new Bounds();
  private triangles = 0;
  private instanceCount = 0;

  constructor(eqDir: string, zone: string) {
    this.eqDir = eqDir;
    this.zone = zone;
  }

  private warn(s: string): void {
    if (this.warnings.length < 500) this.warnings.push(s);
  }

  private openArchives(): void {
    const files: string[] = [`${this.zone}.eqg`];
    const assetsTxt = join(this.eqDir, `${this.zone}_assets.txt`);
    if (existsSync(assetsTxt)) {
      for (const line of readFileSync(assetsTxt, 'latin1').split(/\r?\n/)) {
        const t = line.trim().toLowerCase();
        if (/\.(eqg|s3d)$/.test(t) && !files.includes(t)) files.push(t);
      }
    }
    const prefix = `${this.zone}_`;
    for (const f of readdirSync(this.eqDir)) {
      const l = f.toLowerCase();
      if (l.startsWith(prefix) && l.endsWith('.eqg') && !files.includes(l)) files.push(l);
    }
    for (const f of files) {
      const p = join(this.eqDir, f);
      if (!existsSync(p)) continue;
      try {
        const archive = PfsArchive.open(p);
        this.archives.push({ file: f, archive, names: new Set(archive.names()) });
      } catch (e: any) {
        this.warn(`cannot open ${f}: ${e.message}`);
      }
    }
  }

  private find(name: string): { entry: ArchiveEntry; buf: Buffer } | undefined {
    const n = name.toLowerCase();
    for (const entry of this.archives) {
      if (entry.names.has(n)) {
        const buf = entry.archive.get(n);
        if (buf) return { entry, buf };
      }
    }
    return undefined;
  }

  private findTexture(name: string, preferred: ArchiveEntry): { archive: string; file: string } | undefined {
    const n = name.toLowerCase();
    if (preferred.names.has(n)) return { archive: preferred.file, file: n };
    const stem = n.replace(/\.[^.]+$/, '');
    for (const entry of this.archives) {
      for (const c of [n, `${stem}.dds`, `${stem}.bmp`, `${stem}.tga`]) {
        if (entry.names.has(c)) return { archive: entry.file, file: c };
      }
    }
    return undefined;
  }

  private materialFor(entry: ArchiveEntry, modelName: string, m: EqgMaterial): number {
    const diffuse = (matProp(m, 'e_TextureDiffuse0')?.value as string | undefined) ?? '';
    const key = `${entry.file}#${m.name}#${diffuse.toLowerCase()}#${m.shader}`;
    const hit = this.matCache.get(key);
    if (hit !== undefined) return hit;
    const shader = m.shader.toLowerCase();
    let mode: SceneMaterial['mode'] = 'opaque';
    if (shader.startsWith('chroma')) mode = 'mask';
    else if (shader.startsWith('alpha')) mode = 'blend';
    else if (shader.startsWith('add')) mode = 'additive';
    let texture: SceneMaterial['texture'];
    if (diffuse) {
      const t = this.findTexture(diffuse, entry);
      if (t) texture = { archive: t.archive, file: t.file, mask: false };
      else if (!this.missing.has(`tex:${diffuse}`)) {
        this.missing.set(`tex:${diffuse}`, 1);
        this.warn(`missing texture ${diffuse} for ${modelName}/${m.name}`);
      }
    }
    const mat: SceneMaterial = {
      key,
      name: m.name,
      mode,
      opacity: 1,
      unlit: false,
      doubleSided: true,
      texture,
      color: texture ? undefined : [0.6, 0.6, 0.6],
    };
    const idx = this.materials.add(mat);
    this.matCache.set(key, idx);
    return idx;
  }

  private convertGeometry(entry: ArchiveEntry, g: EqgGeometry): SceneMesh {
    const merger = new MeshMerger(g.name);
    const n = g.positions.length / 3;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    // The first uv set is the diffuse mapping; fall back to the second set when the first is unused.
    const srcUv = isDegenerateUv(g.uvs) && g.uvs2 && !isDegenerateUv(g.uvs2) ? g.uvs2 : g.uvs;
    for (let i = 0; i < n; i++) {
      const p = eqToGl(g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]);
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
      const nm = eqToGl(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]);
      normals[i * 3] = nm[0];
      normals[i * 3 + 1] = nm[1];
      normals[i * 3 + 2] = nm[2];
      uvs[i * 2] = srcUv[i * 2];
      uvs[i * 2 + 1] = srcUv[i * 2 + 1];
    }
    let colors: Uint8Array | undefined;
    if (g.colors) {
      colors = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        colors[i * 3] = g.colors[i * 4];
        colors[i * 3 + 1] = g.colors[i * 4 + 1];
        colors[i * 3 + 2] = g.colors[i * 4 + 2];
      }
    }
    const base = merger.addVertices(positions, normals, uvs, colors);
    const matIndex = new Map<number, number>();
    const faces = g.faceMaterial.length;
    const byMat = new Map<number, number[]>();
    for (let f = 0; f < faces; f++) {
      const mi = g.faceMaterial[f];
      if (mi < 0 || mi >= g.materials.length) continue;
      let sm = matIndex.get(mi);
      if (sm === undefined) {
        sm = this.materialFor(entry, g.name, g.materials[mi]);
        matIndex.set(mi, sm);
      }
      let list = byMat.get(sm);
      if (!list) {
        list = [];
        byMat.set(sm, list);
      }
      list.push(g.indices[f * 3], g.indices[f * 3 + 1], g.indices[f * 3 + 2]);
    }
    for (const [sm, list] of byMat) merger.addTriangles(sm, list, base);
    return merger.build();
  }

  /** Mesh index for a model file name (e.g. "obj_tree.mod"); -1 if unavailable. */
  private modelMesh(name: string): number {
    const n = name.toLowerCase();
    const hit = this.geometryCache.get(n);
    if (hit !== undefined) return hit;
    const candidates = /\.(mod|mds|ter)$/.test(n) ? [n] : [`${n}.mod`, `${n}.mds`, `${n}.ter`, n];
    let found: { entry: ArchiveEntry; buf: Buffer; file: string } | undefined;
    for (const c of candidates) {
      const r = this.find(c);
      if (r) {
        found = { ...r, file: c };
        break;
      }
    }
    let idx = -1;
    if (!found) {
      this.missing.set(n, (this.missing.get(n) || 0) + 1);
    } else {
      try {
        const g = found.file.endsWith('.mds') ? parseMds(found.buf, found.file) : parseTerMod(found.buf, found.file);
        const mesh = this.convertGeometry(found.entry, g);
        if (mesh.groups.length) {
          this.meshes.push(mesh);
          idx = this.meshes.length - 1;
        }
      } catch (e: any) {
        this.warn(`model ${found.file}: ${e.message}`);
      }
    }
    this.geometryCache.set(n, idx);
    return idx;
  }

  private nodeInstances = new Map<number, { node: MeshNode; kind: MeshNode['kind'] }>();

  private addInstance(meshIdx: number, t: Transform, kind: MeshNode['kind'], name: string): void {
    if (meshIdx < 0) return;
    const g = transformEqToGl(t);
    const inst: Instance = { position: g.position, rotation: g.rotation, scale: g.scale };
    let rec = this.nodeInstances.get(meshIdx);
    if (!rec) {
      const node: MeshNode = { name, kind, mesh: meshIdx, instances: [] };
      this.nodes.push(node);
      rec = { node, kind };
      this.nodeInstances.set(meshIdx, rec);
    }
    rec.node.instances.push(inst);
    this.instanceCount++;
    this.triangles += this.meshes[meshIdx].groups.reduce((s, gr) => s + gr.indices.length / 3, 0);
    this.bounds.addPoint(g.position[0], g.position[1], g.position[2]);
  }

  private buildBinaryZon(zonBuf: Buffer): void {
    const zon = parseZonBinary(zonBuf);
    let terPlaced = false;
    for (const p of zon.placeables) {
      if (!p.modelName) continue;
      const meshIdx = this.modelMesh(p.modelName);
      if (meshIdx < 0) continue;
      const isTer = p.modelName.endsWith('.ter');
      if (isTer) {
        // The terrain's own placement entry is editor metadata; the client renders the TER in zone space as-is.
        terPlaced = true;
        this.addInstance(meshIdx, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, 'zone', p.modelName);
        continue;
      }
      // Binary ZON stores rotations in (z, y, x) order.
      const rot = quatFromEqEuler(p.rotation[2] * ROT_SIGN, p.rotation[1] * ROT_SIGN, p.rotation[0] * ROT_SIGN);
      const s = p.scale || 1;
      this.addInstance(meshIdx, { position: p.position, rotation: rot, scale: [s, s, s] }, 'object', p.modelName);
    }
    if (!terPlaced) {
      // Older zones may not place the terrain explicitly.
      for (const entry of this.archives) {
        for (const n of entry.names) {
          if (n.endsWith('.ter')) {
            const meshIdx = this.modelMesh(n);
            this.addInstance(meshIdx, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, 'zone', n);
          }
        }
        break;
      }
    }
    for (const [name, count] of this.missing) if (!name.startsWith('tex:')) this.warn(`missing model ${name} (${count} placements)`);
  }

  private ecoMaterial(name: string): { material: number; repeat: number } {
    const key = `eco:${name.toLowerCase()}`;
    const hit = this.matCache.get(key);
    const repeatKey = `${key}#repeat`;
    if (hit !== undefined) return { material: hit, repeat: Number(this.matCache.get(repeatKey) ?? 16) };
    let texture: SceneMaterial['texture'];
    let repeat = 16;
    const eco = this.find(`${name.toLowerCase()}.eco`);
    if (eco) {
      const layers = parseEco(eco.buf);
      const layer = layers[0];
      if (layer?.detailMap) {
        const t = this.findTexture(layer.detailMap, eco.entry);
        if (t) texture = { archive: t.archive, file: t.file, mask: false };
        else this.warn(`missing terrain texture ${layer.detailMap} (eco ${name})`);
        if (layer.detailRepeat > 0) repeat = layer.detailRepeat;
      }
    } else {
      this.warn(`missing eco ${name}`);
    }
    const idx = this.materials.add({
      key,
      name: `terrain:${name}`,
      mode: 'opaque',
      opacity: 1,
      unlit: false,
      doubleSided: true,
      texture,
      color: texture ? undefined : [0.35, 0.45, 0.25],
    });
    this.matCache.set(key, idx);
    this.matCache.set(repeatKey, repeat);
    return { material: idx, repeat };
  }

  private sampleHeight(tile: V4Tile, fx: number, fy: number, zon: ZonV4): number {
    const qpt = zon.quadsPerTile;
    const upv = zon.unitsPerVert;
    const row = Math.min(Math.max(fy / upv, 0), qpt);
    const col = Math.min(Math.max(fx / upv, 0), qpt);
    const r0 = Math.min(Math.floor(row), qpt - 1);
    const c0 = Math.min(Math.floor(col), qpt - 1);
    const fr = row - r0;
    const fc = col - c0;
    const w = qpt + 1;
    const h00 = tile.heights[r0 * w + c0];
    const h10 = tile.heights[(r0 + 1) * w + c0];
    const h01 = tile.heights[r0 * w + c0 + 1];
    const h11 = tile.heights[(r0 + 1) * w + c0 + 1];
    return (h00 * (1 - fr) + h10 * fr) * (1 - fc) + (h01 * (1 - fr) + h11 * fr) * fc;
  }

  private buildV4(zonBuf: Buffer): void {
    const zon = parseZonV4(zonBuf);
    const datName = `${(zon.name || this.zone).toLowerCase()}.dat`;
    const dat = this.find(datName) ?? this.find(`${this.zone}.dat`);
    if (!dat) throw new Error(`v4 zone has no terrain file ${datName}`);
    const terrain = parseV4Terrain(dat.buf, zon);
    const qpt = zon.quadsPerTile;
    const upv = zon.unitsPerVert;
    const w = qpt + 1;
    const merger = new MeshMerger('terrain');
    let lastBase = '';
    for (const tile of terrain.tiles) {
      const baseName = tile.baseMaterial || lastBase;
      if (baseName) lastBase = baseName;
      const { material, repeat } = this.ecoMaterial(baseName || 'default');
      const positions = new Float32Array(w * w * 3);
      const uvs = new Float32Array(w * w * 2);
      const colors = new Uint8Array(w * w * 3);
      for (let r = 0; r < w; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          const p = eqToGl(tile.startX + r * upv, tile.startY + c * upv, tile.heights[i]);
          positions[i * 3] = p[0];
          positions[i * 3 + 1] = p[1];
          positions[i * 3 + 2] = p[2];
          uvs[i * 2] = (c / qpt) * repeat;
          uvs[i * 2 + 1] = (r / qpt) * repeat;
          const col = tile.colors[i];
          colors[i * 3] = (col >>> 16) & 255;
          colors[i * 3 + 1] = (col >>> 8) & 255;
          colors[i * 3 + 2] = col & 255;
        }
      }
      const base = merger.addVertices(positions, undefined, uvs, colors);
      const idx: number[] = [];
      for (let r = 0; r < qpt; r++) {
        for (let c = 0; c < qpt; c++) {
          if (SKIP_FLAGGED_QUADS && tile.flags[r * qpt + c] & 0x01) continue;
          const v00 = r * w + c;
          const v10 = (r + 1) * w + c;
          const v11 = (r + 1) * w + c + 1;
          const v01 = r * w + c + 1;
          idx.push(v00, v10, v11, v00, v11, v01);
        }
      }
      merger.addTriangles(material, idx, base);
    }
    if (!merger.isEmpty) {
      const mesh = merger.build();
      this.meshes.push(mesh);
      const meshIdx = this.meshes.length - 1;
      this.nodes.push({ name: 'terrain', kind: 'terrain', mesh: meshIdx, instances: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] });
      this.bounds.addPositions(mesh.positions);
      this.triangles += mesh.groups.reduce((s, g) => s + g.indices.length / 3, 0);
    }

    // Placeables and object groups
    const togCache = new Map<string, ReturnType<typeof parseTog> | null>();
    for (const tile of terrain.tiles) {
      for (const p of tile.placeables) {
        const meshIdx = this.modelMesh(p.modelName);
        if (meshIdx < 0) continue;
        const z = p.position[2] + this.sampleHeight(tile, p.position[0], p.position[1], zon);
        const pos: Vec3 = [tile.startX + p.position[1], tile.startY + p.position[0], z];
        const rot = quatFromEqEuler(p.rotation[0] * DEG * V4_ROT_SIGN, p.rotation[1] * DEG * V4_ROT_SIGN, p.rotation[2] * DEG * V4_ROT_SIGN);
        const sc: Vec3 = [p.scale[0] || 1, p.scale[1] || 1, p.scale[2] || 1];
        this.addInstance(meshIdx, { position: pos, rotation: rot, scale: sc }, 'object', p.modelName);
      }
      for (const tr of tile.togRefs) {
        let tog = togCache.get(tr.name.toLowerCase());
        if (tog === undefined) {
          const f = this.find(`${tr.name.toLowerCase()}.tog`);
          tog = f ? parseTog(f.buf) : null;
          if (!tog) this.warn(`missing tog ${tr.name}`);
          togCache.set(tr.name.toLowerCase(), tog);
        }
        if (!tog) continue;
        const group: Transform = {
          position: [tile.startX + tr.position[1], tile.startY + tr.position[0], tr.position[2] + tr.scale[2] * tr.zAdjust],
          rotation: quatFromEqEuler(tr.rotation[0] * DEG * V4_ROT_SIGN, tr.rotation[1] * DEG * V4_ROT_SIGN, tr.rotation[2] * DEG * V4_ROT_SIGN),
          scale: [tr.scale[0] || 1, tr.scale[1] || 1, tr.scale[2] || 1],
        };
        for (const tp of tog) {
          const meshIdx = this.modelMesh(tp.modelName);
          if (meshIdx < 0) continue;
          const local: Transform = {
            position: [tp.position[1], tp.position[0], tp.position[2]],
            rotation: quatFromEqEuler(tp.rotation[0] * DEG * V4_ROT_SIGN, tp.rotation[1] * DEG * V4_ROT_SIGN, tp.rotation[2] * DEG * V4_ROT_SIGN),
            scale: [tp.scale || 1, tp.scale || 1, tp.scale || 1],
          };
          this.addInstance(meshIdx, composeTransform(group, local), 'object', tp.modelName);
        }
      }
    }
    this.buildWater();
    for (const [name, count] of this.missing) if (!name.startsWith('tex:')) this.warn(`missing model ${name} (${count} placements)`);
  }

  private buildWater(): void {
    const wat = this.find('water.dat');
    if (!wat) return;
    const t = tokenize(wat.buf.toString('latin1'));
    const merger = new MeshMerger('water');
    const mat = this.materials.add({ key: 'water', name: 'water', mode: 'blend', opacity: 0.45, unlit: true, doubleSided: true, color: [0.15, 0.35, 0.6] });
    let cur: { minX?: number; maxX?: number; minY?: number; maxY?: number; z?: number } | null = null;
    const flush = () => {
      if (cur && cur.minX !== undefined && cur.maxX !== undefined && cur.minY !== undefined && cur.maxY !== undefined && cur.z !== undefined) {
        const pts = [
          eqToGl(cur.minX, cur.minY, cur.z),
          eqToGl(cur.maxX, cur.minY, cur.z),
          eqToGl(cur.maxX, cur.maxY, cur.z),
          eqToGl(cur.minX, cur.maxY, cur.z),
        ];
        const pos = new Float32Array(pts.flat());
        const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        const base = merger.addVertices(pos, undefined, uv, undefined);
        merger.addTriangles(mat, [0, 1, 2, 0, 2, 3], base);
      }
      cur = null;
    };
    for (let i = 0; i < t.length; i++) {
      const k = t[i];
      if (k === '*WATERSHEET') {
        flush();
        cur = {};
      } else if (k === '*END_SHEET') flush();
      else if (cur && k === '*MINX') cur.minX = parseFloat(t[++i]);
      else if (cur && k === '*MAXX') cur.maxX = parseFloat(t[++i]);
      else if (cur && k === '*MINY') cur.minY = parseFloat(t[++i]);
      else if (cur && k === '*MAXY') cur.maxY = parseFloat(t[++i]);
      else if (cur && k === '*ZHEIGHT') cur.z = parseFloat(t[++i]);
    }
    flush();
    if (!merger.isEmpty) {
      const mesh = merger.build();
      this.meshes.push(mesh);
      this.nodes.push({ name: 'water', kind: 'water', mesh: this.meshes.length - 1, instances: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] });
    }
  }

  build(): ZoneScene {
    this.openArchives();
    if (!this.archives.length) throw new Error(`no archive for ${this.zone}`);
    const main = this.archives[0];
    let zonBuf: Buffer | undefined;
    const zonName = [...main.names].find((n) => n.endsWith('.zon'));
    if (zonName) zonBuf = main.archive.get(zonName);
    const loose = join(this.eqDir, `${this.zone}.zon`);
    if (!zonBuf && existsSync(loose)) zonBuf = readFileSync(loose);
    let format: string;
    if (zonBuf && isTextZon(zonBuf)) {
      format = 'eqg v4 (heightmap terrain)';
      this.buildV4(zonBuf);
    } else if (zonBuf) {
      format = `eqg zon v${zonBuf.readUInt32LE(4)}`;
      this.buildBinaryZon(zonBuf);
    } else {
      format = 'eqg (ter only)';
      for (const n of main.names) {
        if (n.endsWith('.ter')) {
          const meshIdx = this.modelMesh(n);
          this.addInstance(meshIdx, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, 'zone', n);
        }
      }
    }
    for (const node of this.nodes) {
      if (node.kind === 'zone' || node.kind === 'terrain') {
        const mesh = this.meshes[node.mesh];
        for (const inst of node.instances) {
          const t: Transform = { position: inst.position, rotation: inst.rotation, scale: inst.scale };
          for (let i = 0; i < mesh.positions.length; i += 3) {
            const p = transformPointGl(t, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
            this.bounds.addPoint(p[0], p[1], p[2]);
          }
        }
      }
    }
    const bounds = this.bounds;
    const center = bounds.valid ? bounds.center : ([0, 0, 0] as Vec3);
    const size = bounds.valid ? bounds.size : ([100, 100, 100] as Vec3);
    const extent = Math.max(size[0], size[2]);
    return {
      name: this.zone,
      materials: this.materials.list,
      meshes: this.meshes,
      nodes: this.nodes,
      bounds: { min: bounds.min, max: bounds.max },
      warnings: this.warnings,
      stats: {
        format,
        archives: this.archives.map((a) => a.file).join(', '),
        meshes: this.meshes.length,
        materials: this.materials.list.length,
        objects: this.instanceCount,
        triangles: this.triangles,
      },
      start: {
        position: [center[0] - extent * 0.45, bounds.valid ? bounds.max[1] + extent * 0.35 : 100, center[2]],
        target: center,
      },
    };
  }
}

function isDegenerateUv(uv: Float32Array): boolean {
  for (let i = 0; i < uv.length; i++) if (uv[i] !== 0) return false;
  return true;
}

function transformPointGl(t: Transform, p: Vec3): Vec3 {
  const [qx, qy, qz, qw] = t.rotation;
  const x = p[0] * t.scale[0];
  const y = p[1] * t.scale[1];
  const z = p[2] * t.scale[2];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty) + t.position[0],
    y + qw * ty + (qz * tx - qx * tz) + t.position[1],
    z + qw * tz + (qx * ty - qy * tx) + t.position[2],
  ];
}

export function buildEqgZone(eqDir: string, zone: string): ZoneScene {
  return new EqgBuilder(eqDir, zone).build();
}
