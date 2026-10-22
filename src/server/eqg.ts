// EQG-era format parsers: ZON (binary v1/v2 and text v4), TER/MOD/MDS geometry, v4 terrain DAT, TOG, ECO.
import { Reader, cstrAt } from './binary.ts';

export interface EqgMaterialProp {
  name: string;
  type: number;
  value: number | string;
}

export interface EqgMaterial {
  id: number;
  name: string;
  shader: string;
  props: EqgMaterialProp[];
}

export interface EqgGeometry {
  kind: 'ter' | 'mod' | 'mds';
  name: string;
  version: number;
  materials: EqgMaterial[];
  positions: Float32Array; // EQ coordinates
  normals: Float32Array;
  uvs: Float32Array;
  uvs2?: Float32Array;
  colors?: Uint8Array; // RGBA, only when present in file
  indices: Uint32Array; // 3 per face
  faceMaterial: Int32Array; // per face material index (-1 = none)
  faceFlags: Uint32Array;
  boneCount: number;
}

function readMaterials(r: Reader, strings: Buffer, count: number): EqgMaterial[] {
  const mats: EqgMaterial[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.i32();
    const name = cstrAt(strings, r.i32());
    const shader = cstrAt(strings, r.i32());
    const propCount = r.u32();
    const props: EqgMaterialProp[] = [];
    for (let j = 0; j < propCount; j++) {
      const pname = cstrAt(strings, r.i32());
      const type = r.u32();
      let value: number | string;
      if (type === 0) value = r.f32();
      else {
        const v = r.i32();
        value = type === 2 ? cstrAt(strings, v) : v >>> 0;
      }
      props.push({ name: pname, type, value });
    }
    mats.push({ id, name, shader, props });
  }
  return mats;
}

interface VertexBlock {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  uvs2?: Float32Array;
  colors?: Uint8Array;
}

function readVertices(r: Reader, count: number, version: number): VertexBlock {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const uvs2 = version >= 3 ? new Float32Array(count * 2) : undefined;
  const colors = version >= 3 ? new Uint8Array(count * 4) : undefined;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = r.f32();
    positions[i * 3 + 1] = r.f32();
    positions[i * 3 + 2] = r.f32();
    normals[i * 3] = r.f32();
    normals[i * 3 + 1] = r.f32();
    normals[i * 3 + 2] = r.f32();
    if (version >= 3) {
      // Stored as BGRA
      const b = r.u8();
      const g = r.u8();
      const rr = r.u8();
      const a = r.u8();
      colors![i * 4] = rr;
      colors![i * 4 + 1] = g;
      colors![i * 4 + 2] = b;
      colors![i * 4 + 3] = a;
    }
    uvs[i * 2] = r.f32();
    uvs[i * 2 + 1] = r.f32();
    if (version >= 3) {
      uvs2![i * 2] = r.f32();
      uvs2![i * 2 + 1] = r.f32();
    }
  }
  return { positions, normals, uvs, uvs2, colors };
}

function readFaces(r: Reader, count: number): { indices: Uint32Array; faceMaterial: Int32Array; faceFlags: Uint32Array } {
  const indices = new Uint32Array(count * 3);
  const faceMaterial = new Int32Array(count);
  const faceFlags = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    indices[i * 3] = r.u32();
    indices[i * 3 + 1] = r.u32();
    indices[i * 3 + 2] = r.u32();
    faceMaterial[i] = r.i32();
    faceFlags[i] = r.u32();
  }
  return { indices, faceMaterial, faceFlags };
}

/** Parse a TER or MOD file. */
export function parseTerMod(buf: Buffer, name: string): EqgGeometry {
  const r = new Reader(buf);
  const magic = r.fixed(4);
  if (magic !== 'EQGT' && magic !== 'EQGM') throw new Error(`Not a TER/MOD file: ${name} (${magic})`);
  const kind = magic === 'EQGT' ? 'ter' : 'mod';
  const version = r.u32();
  const listLength = r.u32();
  const materialCount = r.u32();
  const vertexCount = r.u32();
  const faceCount = r.u32();
  const boneCount = kind === 'mod' ? r.u32() : 0;
  const strings = r.bytes(listLength);
  const materials = readMaterials(r, strings, materialCount);
  const vb = readVertices(r, vertexCount, version);
  const fb = readFaces(r, faceCount);
  return { kind, name, version, materials, ...vb, ...fb, boneCount };
}

/** Parse an MDS file (skinned model with sub-models). All sub-models are merged. */
export function parseMds(buf: Buffer, name: string): EqgGeometry {
  const r = new Reader(buf);
  const magic = r.fixed(4);
  if (magic !== 'EQGS') throw new Error(`Not an MDS file: ${name}`);
  const version = r.u32();
  const listLength = r.u32();
  const materialCount = r.u32();
  const boneCount = r.u32();
  const modelCount = r.u32();
  const strings = r.bytes(listLength);
  const materials = readMaterials(r, strings, materialCount);
  r.skip(boneCount * 56);
  const parts: { vb: VertexBlock; fb: ReturnType<typeof readFaces>; count: number }[] = [];
  for (let m = 0; m < modelCount; m++) {
    r.u32(); // main piece
    r.i32(); // name
    const vcount = r.u32();
    const fcount = r.u32();
    r.u32(); // bone assignment count
    const vb = readVertices(r, vcount, version);
    const fb = readFaces(r, fcount);
    if (boneCount > 0) r.skip(vcount * 36);
    parts.push({ vb, fb, count: vcount });
  }
  const totalV = parts.reduce((a, p) => a + p.count, 0);
  const totalF = parts.reduce((a, p) => a + p.fb.faceMaterial.length, 0);
  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const colors = version >= 3 ? new Uint8Array(totalV * 4) : undefined;
  const indices = new Uint32Array(totalF * 3);
  const faceMaterial = new Int32Array(totalF);
  const faceFlags = new Uint32Array(totalF);
  let vo = 0;
  let fo = 0;
  for (const p of parts) {
    positions.set(p.vb.positions, vo * 3);
    normals.set(p.vb.normals, vo * 3);
    uvs.set(p.vb.uvs, vo * 2);
    if (colors && p.vb.colors) colors.set(p.vb.colors, vo * 4);
    for (let i = 0; i < p.fb.indices.length; i++) indices[fo * 3 + i] = p.fb.indices[i] + vo;
    faceMaterial.set(p.fb.faceMaterial, fo);
    faceFlags.set(p.fb.faceFlags, fo);
    vo += p.count;
    fo += p.fb.faceMaterial.length;
  }
  return { kind: 'mds', name, version, materials, positions, normals, uvs, colors, indices, faceMaterial, faceFlags, boneCount };
}

export interface ZonPlaceable {
  modelName: string; // e.g. "obj_tree.mod"
  instanceName: string;
  position: [number, number, number];
  rotation: [number, number, number]; // radians (x, y, z)
  scale: number;
}

export interface ZonRegion {
  name: string;
  center: [number, number, number];
  rotation: number;
  extents: [number, number, number];
}

export interface ZonLight {
  name: string;
  position: [number, number, number];
  color: [number, number, number];
  radius: number;
}

export interface ZonBinary {
  kind: 'binary';
  version: number;
  models: string[];
  placeables: ZonPlaceable[];
  regions: ZonRegion[];
  lights: ZonLight[];
}

export interface ZonV4 {
  kind: 'v4';
  name: string;
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
  minExtents: [number, number, number];
  maxExtents: [number, number, number];
  unitsPerVert: number;
  quadsPerTile: number;
  coverMapInputSize: number;
  layeringMapInputSize: number;
  version: number;
}

export function isTextZon(buf: Buffer): boolean {
  return buf.toString('latin1', 0, 5) === 'EQTZP';
}

export function parseZonBinary(buf: Buffer): ZonBinary {
  const r = new Reader(buf);
  const magic = r.fixed(4);
  if (magic !== 'EQGZ') throw new Error('Not a binary ZON file');
  const version = r.u32();
  const listLength = r.u32();
  const modelCount = r.u32();
  const objectCount = r.u32();
  const regionCount = r.u32();
  const lightCount = r.u32();
  const strings = r.bytes(listLength);
  const models: string[] = [];
  for (let i = 0; i < modelCount; i++) models.push(cstrAt(strings, r.i32()).toLowerCase());
  const placeables: ZonPlaceable[] = [];
  for (let i = 0; i < objectCount; i++) {
    const id = r.i32();
    const loc = r.i32();
    const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const rotation: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const scale = r.f32();
    if (version > 1) {
      const n = r.u32();
      r.skip(n * 4);
    }
    placeables.push({
      modelName: id >= 0 && id < models.length ? models[id] : '',
      instanceName: cstrAt(strings, loc),
      position,
      rotation,
      scale,
    });
  }
  const regions: ZonRegion[] = [];
  for (let i = 0; i < regionCount; i++) {
    const name = cstrAt(strings, r.i32());
    const center: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const rotation = r.f32();
    r.u32();
    r.u32();
    const extents: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    regions.push({ name, center, rotation, extents });
  }
  const lights: ZonLight[] = [];
  for (let i = 0; i < lightCount; i++) {
    const name = cstrAt(strings, r.i32());
    const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const color: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const radius = r.f32();
    lights.push({ name, position, color, radius });
  }
  return { kind: 'binary', version, models, placeables, regions, lights };
}

export function tokenize(text: string): string[] {
  return text.split(/[\s]+/).filter((t) => t.length > 0);
}

export function parseZonV4(buf: Buffer): ZonV4 {
  const t = tokenize(buf.toString('latin1'));
  const z: ZonV4 = {
    kind: 'v4',
    name: '',
    minLng: 0,
    maxLng: 0,
    minLat: 0,
    maxLat: 0,
    minExtents: [0, 0, 0],
    maxExtents: [0, 0, 0],
    unitsPerVert: 12,
    quadsPerTile: 16,
    coverMapInputSize: 32,
    layeringMapInputSize: 2048,
    version: 0,
  };
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    const n = (j: number) => parseFloat(t[i + j]);
    switch (k) {
      case '*NAME':
        z.name = t[++i] ?? '';
        break;
      case '*MINLNG':
        z.minLng = n(1);
        i++;
        break;
      case '*MAXLNG':
        z.maxLng = n(1);
        i++;
        break;
      case '*MINLAT':
        z.minLat = n(1);
        i++;
        break;
      case '*MAXLAT':
        z.maxLat = n(1);
        i++;
        break;
      case '*MIN_EXTENTS':
        z.minExtents = [n(1), n(2), n(3)];
        i += 3;
        break;
      case '*MAX_EXTENTS':
        z.maxExtents = [n(1), n(2), n(3)];
        i += 3;
        break;
      case '*UNITSPERVERT':
        z.unitsPerVert = n(1);
        i++;
        break;
      case '*QUADSPERTILE':
        z.quadsPerTile = n(1);
        i++;
        break;
      case '*COVERMAPINPUTSIZE':
        z.coverMapInputSize = n(1);
        i++;
        break;
      case '*LAYERINGMAPINPUTSIZE':
        z.layeringMapInputSize = n(1);
        i++;
        break;
      case '*VERSION':
        z.version = n(1);
        i++;
        break;
      default:
        break;
    }
  }
  return z;
}

export interface V4Placeable {
  modelName: string;
  instanceName: string;
  position: [number, number, number]; // relative to tile origin (see builder)
  rotation: [number, number, number]; // degrees
  scale: [number, number, number];
}

export interface V4TogRef {
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  zAdjust: number;
}

export interface V4Tile {
  lng: number;
  lat: number;
  startX: number; // EQ x (lat axis)
  startY: number; // EQ y (lng axis)
  heights: Float32Array;
  colors: Uint32Array;
  colors2: Uint32Array;
  flags: Uint8Array;
  baseWaterLevel: number;
  baseMaterial: string;
  layers: { material: string; dim: number; mask: Uint8Array }[];
  placeables: V4Placeable[];
  togRefs: V4TogRef[];
  allFlat: boolean;
}

export interface V4Terrain {
  version: number;
  flags: number;
  baseTileTexture: string;
  tiles: V4Tile[];
}

/** Parse the zone .dat terrain file for v4 zones. */
export function parseV4Terrain(buf: Buffer, zon: ZonV4): V4Terrain {
  const attempt = (extraPlaceableDword: boolean, oddBlock: boolean): V4Terrain => {
    const r = new Reader(buf);
    const version = r.u32();
    const flags = r.u32();
    r.u32();
    const baseTileTexture = r.cstr();
    const tileCount = r.u32();
    if (tileCount > 100000) throw new Error('bad tile count');
    const qpt = zon.quadsPerTile;
    const upv = zon.unitsPerVert;
    const quadCount = qpt * qpt;
    const vertCount = (qpt + 1) * (qpt + 1);
    const zoneMinX = zon.minLat * qpt * upv;
    const zoneMinY = zon.minLng * qpt * upv;
    const tiles: V4Tile[] = [];
    for (let i = 0; i < tileCount; i++) {
      const lng = r.i32();
      const lat = r.i32();
      r.i32();
      const startY = zoneMinY + (lng - 100000 - zon.minLng) * upv * qpt;
      const startX = zoneMinX + (lat - 100000 - zon.minLat) * upv * qpt;
      const heights = new Float32Array(vertCount);
      let allFlat = true;
      for (let j = 0; j < vertCount; j++) {
        heights[j] = r.f32();
        if (j > 0 && heights[j] !== heights[0]) allFlat = false;
      }
      const colors = new Uint32Array(vertCount);
      for (let j = 0; j < vertCount; j++) colors[j] = r.u32();
      const colors2 = new Uint32Array(vertCount);
      for (let j = 0; j < vertCount; j++) colors2[j] = r.u32();
      const tflags = new Uint8Array(r.bytes(quadCount));
      const baseWaterLevel = r.f32();
      const unk = r.i32();
      if (oddBlock) {
        if (unk > 0) {
          const b = r.i8();
          if (b > 0) r.skip(16);
          r.f32();
        }
      }
      const layerCount = r.u32();
      if (layerCount > 1000) throw new Error('bad layer count');
      let baseMaterial = '';
      const layers: V4Tile['layers'] = [];
      if (layerCount > 0) {
        baseMaterial = r.cstr();
        for (let l = 1; l < layerCount; l++) {
          const material = r.cstr();
          const dim = r.u32();
          if (dim > 4096) throw new Error('bad mask dim');
          const mask = new Uint8Array(r.bytes(dim * dim));
          layers.push({ material, dim, mask });
        }
      }
      const placeableCount = r.u32();
      if (placeableCount > 100000) throw new Error('bad placeable count');
      const placeables: V4Placeable[] = [];
      for (let j = 0; j < placeableCount; j++) {
        const modelName = r.cstr().toLowerCase();
        const instanceName = r.cstr();
        r.u32();
        r.u32();
        const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        const rotation: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        const scale: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        r.u8();
        if (extraPlaceableDword) r.u32();
        placeables.push({ modelName, instanceName, position, rotation, scale });
      }
      const areaCount = r.u32();
      if (areaCount > 100000) throw new Error('bad area count');
      for (let j = 0; j < areaCount; j++) {
        r.cstr();
        r.i32();
        r.cstr();
        r.skip(8 + 12 * 4);
      }
      const lightCount = r.u32();
      if (lightCount > 100000) throw new Error('bad light count');
      for (let j = 0; j < lightCount; j++) {
        r.cstr();
        r.cstr();
        r.u8();
        r.skip(8 + 10 * 4);
      }
      const togCount = r.u32();
      if (togCount > 100000) throw new Error('bad tog count');
      const togRefs: V4TogRef[] = [];
      for (let j = 0; j < togCount; j++) {
        const name = r.cstr();
        r.u32();
        r.u32();
        const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        const rotation: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        const scale: [number, number, number] = [r.f32(), r.f32(), r.f32()];
        const zAdjust = r.f32();
        togRefs.push({ name, position, rotation, scale, zAdjust });
      }
      tiles.push({ lng, lat, startX, startY, heights, colors, colors2, flags: tflags, baseWaterLevel, baseMaterial, layers, placeables, togRefs, allFlat });
    }
    if (r.remaining > 8) throw new Error(`terrain parse left ${r.remaining} bytes`);
    return { version, flags, baseTileTexture, tiles };
  };
  const errors: string[] = [];
  const first = buf.readUInt32LE(0);
  const second = buf.readUInt32LE(4);
  const guesses: [boolean, boolean][] = [
    [(first & 2) !== 0, true],
    [(second & 2) !== 0, true],
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ];
  for (const [extra, odd] of guesses) {
    try {
      return attempt(extra, odd);
    } catch (e: any) {
      errors.push(`extra=${extra} odd=${odd}: ${e.message}`);
    }
  }
  throw new Error(`Unable to parse v4 terrain: ${errors.join('; ')}`);
}

export interface TogPlaceable {
  modelName: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

export function parseTog(buf: Buffer): TogPlaceable[] {
  const t = tokenize(buf.toString('latin1'));
  const out: TogPlaceable[] = [];
  let cur: TogPlaceable | null = null;
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    if (k === '*BEGIN_OBJECT') cur = { modelName: '', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
    else if (k === '*NAME' && cur) cur.modelName = (t[++i] ?? '').toLowerCase();
    else if (k === '*POSITION' && cur) {
      cur.position = [parseFloat(t[i + 1]), parseFloat(t[i + 2]), parseFloat(t[i + 3])];
      i += 3;
    } else if (k === '*ROTATION' && cur) {
      cur.rotation = [parseFloat(t[i + 1]), parseFloat(t[i + 2]), parseFloat(t[i + 3])];
      i += 3;
    } else if (k === '*SCALE' && cur) {
      cur.scale = parseFloat(t[++i]);
    } else if (k === '*END_OBJECT' && cur) {
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

export interface EcoTextureLayer {
  name: string;
  detailMap: string;
  normalMap: string;
  detailRepeat: number;
}

export function parseEco(buf: Buffer): EcoTextureLayer[] {
  const t = tokenize(buf.toString('latin1'));
  const layers: EcoTextureLayer[] = [];
  let inTexture = false;
  let cur: EcoTextureLayer | null = null;
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    if (k === '*TEXTUREPART') inTexture = true;
    else if (k === '*END_TEXTUREPART') inTexture = false;
    else if (k === '*LAYER' && inTexture) cur = { name: t[++i] ?? '', detailMap: '', normalMap: '', detailRepeat: 1 };
    else if (k === '*DETAILMAP' && cur) cur.detailMap = t[++i] ?? '';
    else if (k === '*NORMALMAP' && cur) cur.normalMap = t[++i] ?? '';
    else if (k === '*DETAILREPEAT' && cur) cur.detailRepeat = parseFloat(t[++i]);
    else if (k === '*END_LAYER' && cur) {
      if (inTexture) layers.push(cur);
      cur = null;
    }
  }
  return layers;
}

/** Find a material property by (case-insensitive) name. */
export function matProp(m: EqgMaterial, name: string): EqgMaterialProp | undefined {
  const n = name.toLowerCase();
  return m.props.find((p) => p.name.toLowerCase() === n);
}
