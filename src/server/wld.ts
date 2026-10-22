// WLD (classic EverQuest zone / object / character geometry) parser.
// Only the fragment types needed for rendering are decoded.
import { Reader } from './binary.ts';

const KEY = [0x95, 0x3a, 0xc5, 0x2a, 0x95, 0x7a, 0x95, 0x6a];

export function decodeWldString(b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i] ^ KEY[i & 7];
  return out;
}

export interface Frag {
  index: number; // 0-based
  type: number;
  nameRef: number;
  name: string;
  data: Buffer; // full fragment contents (nameRef at offset 0)
}

export interface BitmapName {
  names: string[]; // lowercase file names, e.g. "kbark.bmp"
}

export interface BitmapInfo {
  animated: boolean;
  delayMs: number;
  refs: number[]; // 1-based refs to 0x03
}

export interface MaterialFrag {
  flags: number;
  params: number;
  type: number; // params & 0x7fffffff
  pen: [number, number, number, number];
  brightness: number;
  scaledAmbient: number;
  bitmapInfoRef: number; // 1-based ref to 0x05, or 0
}

export interface MaterialList {
  refs: number[]; // 1-based refs to 0x30
}

export interface MeshFrag {
  flags: number;
  materialListRef: number;
  animRef: number;
  center: [number, number, number];
  positions: Float32Array; // EQ coordinates, center already added
  uvs: Float32Array;
  normals?: Float32Array;
  colors?: Uint8Array; // RGBA
  indices: Uint32Array; // 3 per polygon
  polyFlags: Uint16Array;
  materialGroups: { count: number; materialIndex: number }[];
  vertexPieces: { count: number; bone: number }[];
  vertexCount: number;
}

export interface ActorDef {
  callbackName: string;
  flags: number;
  componentRefs: number[]; // refs to 0x2D (mesh ref) or 0x11 (skeleton ref)
}

export interface ObjectInstance {
  actorName: string; // lowercase, _ACTORDEF stripped (when referenced by name)
  actorRef: number; // positive fragment ref, or 0
  flags: number;
  position: [number, number, number];
  rotation: [number, number, number]; // raw values (units of 512 per turn)
  scale: [number, number, number];
  colorsRef: number; // 1-based ref to 0x33 or 0
}

export interface SkeletonBone {
  name: string;
  flags: number;
  trackRef: number; // 1-based ref to 0x13
  meshRef: number; // 1-based ref to 0x2D or 0
  children: number[];
}

export interface Skeleton {
  flags: number;
  bones: SkeletonBone[];
  meshRefs: number[]; // 1-based refs to 0x2D
  boundingRadius: number;
}

export interface BoneTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion x,y,z,w (normalized)
  scale: number;
}

export interface TrackDef {
  frames: BoneTransform[];
}

export interface VertexColors {
  colors: Uint8Array; // RGBA
}

export interface PointLight {
  lightRef: number;
  flags: number;
  position: [number, number, number];
  radius: number;
}

export class Wld {
  readonly version: number;
  readonly isNew: boolean;
  readonly frags: Frag[] = [];
  readonly strings: Buffer;
  readonly fileName: string;
  private parsed = new Map<number, unknown>();
  private byTypeCache = new Map<number, Frag[]>();

  constructor(buf: Buffer, fileName = '') {
    this.fileName = fileName;
    const r = new Reader(buf);
    const magic = r.u32();
    if (magic !== 0x54503d02) throw new Error(`Not a WLD file: ${fileName}`);
    this.version = r.u32();
    this.isNew = this.version === 0x1000c800;
    if (!this.isNew && this.version !== 0x00015500) {
      throw new Error(`Unknown WLD version 0x${this.version.toString(16)} in ${fileName}`);
    }
    const fragCount = r.u32();
    r.u32(); // bsp region count
    r.u32(); // 0x680D4
    const hashSize = r.u32();
    r.u32();
    this.strings = decodeWldString(r.bytes(hashSize));
    for (let i = 0; i < fragCount; i++) {
      if (r.remaining < 8) break;
      const size = r.u32();
      const type = r.u32();
      const data = r.bytes(size);
      const nameRef = data.length >= 4 ? data.readInt32LE(0) : 0;
      const name = nameRef < 0 ? this.str(nameRef) : '';
      this.frags.push({ index: i, type, nameRef, name, data });
    }
  }

  /** Resolve a negative string reference (or 0) to a string. */
  str(ref: number): string {
    const off = -ref;
    if (off < 0 || off >= this.strings.length) return '';
    let end = off;
    while (end < this.strings.length && this.strings[end] !== 0) end++;
    return this.strings.toString('latin1', off, end);
  }

  /** 1-based fragment reference. */
  frag(ref: number): Frag | undefined {
    if (ref <= 0 || ref > this.frags.length) return undefined;
    return this.frags[ref - 1];
  }

  byType(type: number): Frag[] {
    let list = this.byTypeCache.get(type);
    if (!list) {
      list = this.frags.filter((f) => f.type === type);
      this.byTypeCache.set(type, list);
    }
    return list;
  }

  byName(name: string): Frag | undefined {
    return this.frags.find((f) => f.name === name);
  }

  private cached<T>(f: Frag, fn: (r: Reader) => T): T {
    const hit = this.parsed.get(f.index);
    if (hit !== undefined) return hit as T;
    const v = fn(new Reader(f.data, 4));
    this.parsed.set(f.index, v);
    return v;
  }

  bitmapName(f: Frag): BitmapName {
    return this.cached(f, (r) => {
      r.i32(); // count (number of names - 1 or 1; read while bytes remain)
      const names: string[] = [];
      while (r.remaining >= 2) {
        const len = r.u16();
        if (len <= 0 || len > r.remaining) break;
        let s = decodeWldString(r.bytes(len)).toString('latin1');
        const nul = s.indexOf('\0');
        if (nul >= 0) s = s.slice(0, nul);
        names.push(s.toLowerCase());
      }
      return { names };
    });
  }

  bitmapInfo(f: Frag): BitmapInfo {
    return this.cached(f, (r) => {
      const flags = r.i32();
      const count = r.i32();
      const animated = (flags & 0x08) !== 0;
      let delayMs = 0;
      if (animated) delayMs = r.i32();
      const refs: number[] = [];
      for (let i = 0; i < count && r.remaining >= 4; i++) refs.push(r.i32());
      return { animated, delayMs, refs };
    });
  }

  bitmapInfoRef(f: Frag): number {
    return this.cached(f, (r) => r.i32());
  }

  material(f: Frag): MaterialFrag {
    return this.cached(f, (r) => {
      const flags = r.i32();
      const params = r.u32();
      const pen: [number, number, number, number] = [r.u8(), r.u8(), r.u8(), r.u8()];
      const brightness = r.f32();
      const scaledAmbient = r.f32();
      const bitmapInfoRef = r.remaining >= 4 ? r.i32() : 0;
      return { flags, params, type: params & 0x7fffffff, pen, brightness, scaledAmbient, bitmapInfoRef };
    });
  }

  materialList(f: Frag): MaterialList {
    return this.cached(f, (r) => {
      r.i32(); // flags
      const count = r.i32();
      const refs: number[] = [];
      for (let i = 0; i < count && r.remaining >= 4; i++) refs.push(r.i32());
      return { refs };
    });
  }

  meshRef(f: Frag): number {
    return this.cached(f, (r) => r.i32());
  }

  mesh(f: Frag): MeshFrag {
    return this.cached(f, (r) => {
      const flags = r.i32();
      const materialListRef = r.i32();
      const animRef = r.i32();
      r.i32();
      r.i32();
      const center: [number, number, number] = [r.f32(), r.f32(), r.f32()];
      r.i32();
      r.i32();
      r.i32();
      r.f32(); // max distance
      r.skip(24); // min/max
      const vertexCount = r.u16();
      const uvCount = r.u16();
      const normalCount = r.u16();
      const colorCount = r.u16();
      const polyCount = r.u16();
      const vertexPieceCount = r.u16();
      const polyTexCount = r.u16();
      const vertexTexCount = r.u16();
      r.u16(); // size9
      const scale = 1 / (1 << r.u16());
      const positions = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        positions[i * 3] = r.i16() * scale + center[0];
        positions[i * 3 + 1] = r.i16() * scale + center[1];
        positions[i * 3 + 2] = r.i16() * scale + center[2];
      }
      const uvs = new Float32Array(vertexCount * 2);
      for (let i = 0; i < uvCount; i++) {
        let u: number;
        let v: number;
        if (this.isNew) {
          u = r.f32();
          v = r.f32();
        } else {
          u = r.i16() / 256;
          v = r.i16() / 256;
        }
        if (i < vertexCount) {
          uvs[i * 2] = u;
          uvs[i * 2 + 1] = v;
        }
      }
      let normals: Float32Array | undefined;
      if (normalCount > 0) {
        normals = new Float32Array(vertexCount * 3);
        for (let i = 0; i < normalCount; i++) {
          const x = r.i8() / 127;
          const y = r.i8() / 127;
          const z = r.i8() / 127;
          if (i < vertexCount) {
            normals[i * 3] = x;
            normals[i * 3 + 1] = y;
            normals[i * 3 + 2] = z;
          }
        }
      }
      let colors: Uint8Array | undefined;
      if (colorCount > 0) {
        colors = new Uint8Array(vertexCount * 4);
        for (let i = 0; i < colorCount; i++) {
          const b = r.u8();
          const g = r.u8();
          const rr = r.u8();
          const a = r.u8();
          if (i < vertexCount) {
            colors[i * 4] = rr;
            colors[i * 4 + 1] = g;
            colors[i * 4 + 2] = b;
            colors[i * 4 + 3] = a;
          }
        }
      }
      const indices = new Uint32Array(polyCount * 3);
      const polyFlags = new Uint16Array(polyCount);
      for (let i = 0; i < polyCount; i++) {
        polyFlags[i] = r.u16();
        indices[i * 3] = r.u16();
        indices[i * 3 + 1] = r.u16();
        indices[i * 3 + 2] = r.u16();
      }
      const vertexPieces: { count: number; bone: number }[] = [];
      for (let i = 0; i < vertexPieceCount; i++) {
        vertexPieces.push({ count: r.u16(), bone: r.u16() });
      }
      const materialGroups: { count: number; materialIndex: number }[] = [];
      for (let i = 0; i < polyTexCount; i++) {
        materialGroups.push({ count: r.u16(), materialIndex: r.u16() });
      }
      // vertexTex entries and size9 entries are not needed.
      return {
        flags,
        materialListRef,
        animRef,
        center,
        positions,
        uvs,
        normals,
        colors,
        indices,
        polyFlags,
        materialGroups,
        vertexPieces,
        vertexCount,
      };
    });
  }

  actorDef(f: Frag): ActorDef {
    return this.cached(f, (r) => {
      const flags = r.i32();
      const callbackRef = r.i32();
      const callbackName = this.str(callbackRef);
      const size1 = r.i32();
      const componentCount = r.i32();
      r.i32(); // fragment2
      if (flags & 0x01) r.i32();
      if (flags & 0x02) r.skip(7 * 4);
      for (let i = 0; i < size1; i++) {
        const pairCount = r.i32();
        r.skip(pairCount * 8);
      }
      const componentRefs: number[] = [];
      for (let i = 0; i < componentCount && r.remaining >= 4; i++) componentRefs.push(r.i32());
      // Sanity check: components must be mesh refs (0x2D) or skeleton refs (0x11) or others.
      const ok = componentRefs.every((ref) => {
        const t = this.frag(ref)?.type;
        return t === 0x2d || t === 0x11 || t === 0x09 || t === 0x27 || t === 0x07;
      });
      if (!ok) {
        // Fallback: scan for plausible refs
        const scan: number[] = [];
        const rr = new Reader(f.data, 4);
        while (rr.remaining >= 4) {
          const v = rr.i32();
          const t = this.frag(v)?.type;
          if (v > 0 && (t === 0x2d || t === 0x11)) scan.push(v);
        }
        return { callbackName, flags, componentRefs: scan };
      }
      return { callbackName, flags, componentRefs };
    });
  }

  objectInstance(f: Frag): ObjectInstance {
    return this.cached(f, (r) => {
      const ref = r.i32();
      let actorName = '';
      let actorRef = 0;
      if (ref < 0) actorName = this.str(ref).replace(/_ACTORDEF$/i, '').toLowerCase();
      else actorRef = ref;
      const flags = r.i32();
      r.i32();
      const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
      const rotation: [number, number, number] = [r.f32(), r.f32(), r.f32()];
      const scale: [number, number, number] = [r.f32(), r.f32(), r.f32()];
      const colorsRef = r.remaining >= 4 ? r.i32() : 0;
      return { actorName, actorRef, flags, position, rotation, scale, colorsRef };
    });
  }

  skeleton(f: Frag): Skeleton {
    return this.cached(f, (r) => {
      const flags = r.i32();
      const boneCount = r.i32();
      r.i32(); // polyhedron ref
      if (flags & 0x01) r.skip(12);
      let boundingRadius = 0;
      if (flags & 0x02) boundingRadius = r.f32();
      const bones: SkeletonBone[] = [];
      for (let i = 0; i < boneCount; i++) {
        const nameRef = r.i32();
        const bflags = r.i32();
        const trackRef = r.i32();
        const meshRef = r.i32();
        const childCount = r.i32();
        const children: number[] = [];
        for (let j = 0; j < childCount; j++) children.push(r.i32());
        bones.push({ name: this.str(nameRef), flags: bflags, trackRef, meshRef: meshRef > 0 ? meshRef : 0, children });
      }
      const meshRefs: number[] = [];
      if (flags & 0x200) {
        const n = r.i32();
        for (let i = 0; i < n; i++) meshRefs.push(r.i32());
      }
      return { flags, bones, meshRefs, boundingRadius };
    });
  }

  skeletonRef(f: Frag): number {
    return this.cached(f, (r) => r.i32());
  }

  trackDef(f: Frag): TrackDef {
    return this.cached(f, (r) => {
      const flags = r.i32();
      const frameCount = r.i32();
      const frames: BoneTransform[] = [];
      const isInt = (flags & 0x08) !== 0;
      for (let i = 0; i < frameCount; i++) {
        if (isInt) {
          const rotDenom = r.i16();
          const rx = r.i16();
          const ry = r.i16();
          const rz = r.i16();
          const sx = r.i16();
          const sy = r.i16();
          const sz = r.i16();
          const shiftDenom = r.i16();
          const translation: [number, number, number] =
            shiftDenom !== 0 ? [sx / 256, sy / 256, sz / 256] : [0, 0, 0];
          const scale = shiftDenom !== 0 ? shiftDenom / 256 : 1;
          frames.push({ translation, rotation: normQuat(rx, ry, rz, rotDenom), scale });
        } else {
          const shiftDenom = r.f32();
          const sx = r.f32();
          const sy = r.f32();
          const sz = r.f32();
          const rw = r.f32();
          const rx = r.f32();
          const ry = r.f32();
          const rz = r.f32();
          frames.push({ translation: [sx, sy, sz], rotation: normQuat(rx, ry, rz, rw), scale: shiftDenom || 1 });
        }
      }
      return { frames };
    });
  }

  trackRef(f: Frag): number {
    return this.cached(f, (r) => r.i32());
  }

  vertexColors(f: Frag): VertexColors {
    return this.cached(f, (r) => {
      r.i32();
      const count = r.i32();
      r.i32();
      r.i32();
      r.i32();
      const colors = new Uint8Array(count * 4);
      for (let i = 0; i < count && r.remaining >= 4; i++) {
        const b = r.u8();
        const g = r.u8();
        const rr = r.u8();
        const a = r.u8();
        colors[i * 4] = rr;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
        colors[i * 4 + 3] = a;
      }
      return { colors };
    });
  }

  vertexColorsRef(f: Frag): number {
    return this.cached(f, (r) => r.i32());
  }

  pointLight(f: Frag): PointLight {
    return this.cached(f, (r) => {
      const lightRef = r.i32();
      const flags = r.i32();
      const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
      const radius = r.f32();
      return { lightRef, flags, position, radius };
    });
  }
}

function normQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
  const len = Math.hypot(x, y, z, w);
  if (len === 0) return [0, 0, 0, 1];
  return [x / len, y / len, z / len, w / len];
}

/** Material render mode derived from the 0x30 material type. */
export type MaterialMode = 'opaque' | 'mask' | 'blend' | 'additive' | 'invisible';

export function wldMaterialMode(type: number, hasTexture: boolean): { mode: MaterialMode; opacity: number; unlit: boolean } {
  switch (type) {
    case 0x00:
    case 0x53:
    case 0x4b:
    case 0x03:
      return { mode: 'invisible', opacity: 1, unlit: false };
    case 0x01:
    case 0x02:
    case 0x14:
    case 0x15:
    case 0x553:
    case 0x1a:
    case 0x12:
    case 0x31:
    case 0x07:
    case 0x0d:
      return { mode: 'opaque', opacity: 1, unlit: false };
    case 0x05:
      return { mode: 'blend', opacity: 0.5, unlit: false };
    case 0x09:
      return { mode: 'blend', opacity: 0.25, unlit: false };
    case 0x0a:
    case 0x0f:
      return { mode: 'blend', opacity: 0.75, unlit: false };
    case 0x17:
      return { mode: 'additive', opacity: 1, unlit: false };
    case 0x0b:
    case 0x10:
      return { mode: 'additive', opacity: 1, unlit: true };
    case 0x13:
    case 0x19:
      return { mode: 'mask', opacity: 1, unlit: false };
    default:
      return hasTexture ? { mode: 'opaque', opacity: 1, unlit: false } : { mode: 'invisible', opacity: 1, unlit: false };
  }
}
