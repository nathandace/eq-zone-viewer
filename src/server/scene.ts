// Intermediate scene representation shared by the S3D and EQG builders, plus small math helpers.
// All geometry in a ZoneScene is already converted to glTF / three.js space (right-handed, +Y up).

export type MaterialMode = 'opaque' | 'mask' | 'blend' | 'additive' | 'invisible';

export interface TextureRef {
  archive: string; // archive file name, e.g. "gfaydark.s3d"
  file: string; // file inside the archive, e.g. "gfaydark_kbark.dds"
  mask: boolean; // palette index 0 / key color becomes transparent
}

export interface SceneMaterial {
  key: string;
  name: string;
  mode: MaterialMode;
  opacity: number;
  unlit: boolean;
  doubleSided: boolean;
  texture?: TextureRef;
  frames?: TextureRef[]; // animated texture frames (first frame == texture)
  animDelayMs?: number;
  color?: [number, number, number]; // untextured fallback color (0..1)
  noFog?: boolean; // drawn without distance fog (sky domes)
}

export interface MeshGroup {
  material: number;
  indices: Uint32Array;
}

export interface SceneMesh {
  name: string;
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  colors?: Uint8Array; // RGB, 3 bytes per vertex
  groups: MeshGroup[];
}

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Instance {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  color?: Vec3; // 0..1 multiplier
}

export interface MeshNode {
  name: string;
  kind: 'zone' | 'object' | 'terrain' | 'water' | 'sky';
  mesh: number;
  instances: Instance[];
}

export interface ZoneScene {
  name: string;
  materials: SceneMaterial[];
  meshes: SceneMesh[];
  nodes: MeshNode[];
  bounds: { min: Vec3; max: Vec3 };
  warnings: string[];
  stats: Record<string, number | string>;
  start?: { position: Vec3; target: Vec3 };
  sky?: Vec3; // background / fog colour override (0..1)
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

// EQ (x, y, z-up) -> glTF (x, z, -y): rotation of -90 degrees about X.
export function eqToGl(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

const R_EQ_TO_GL: Quat = quatFromAxisAngle([1, 0, 0], -Math.PI / 2);
const R_EQ_TO_GL_INV: Quat = quatFromAxisAngle([1, 0, 0], Math.PI / 2);

/** Convert a rotation expressed in EQ space to glTF space. */
export function quatEqToGl(q: Quat): Quat {
  return quatMul(quatMul(R_EQ_TO_GL, q), R_EQ_TO_GL_INV);
}

export function scaleEqToGl(s: Vec3): Vec3 {
  return [s[0], s[2], s[1]];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [x, y, z] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  // v + w * t + cross(q.xyz, t)
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

/** Euler rotation in EQ space: rotate about X, then Y, then Z (heading). Angles in radians. */
export function quatFromEqEuler(rx: number, ry: number, rz: number): Quat {
  const qx = quatFromAxisAngle([1, 0, 0], rx);
  const qy = quatFromAxisAngle([0, 1, 0], ry);
  const qz = quatFromAxisAngle([0, 0, 1], rz);
  return quatMul(quatMul(qz, qy), qx);
}

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Compose parent * child transforms (TRS). Non-uniform parent scale is applied to the child's position only. */
export function composeTransform(parent: Transform, child: Transform): Transform {
  const scaled: Vec3 = [child.position[0] * parent.scale[0], child.position[1] * parent.scale[1], child.position[2] * parent.scale[2]];
  const rotated = quatRotate(parent.rotation, scaled);
  return {
    position: [parent.position[0] + rotated[0], parent.position[1] + rotated[1], parent.position[2] + rotated[2]],
    rotation: quatNormalize(quatMul(parent.rotation, child.rotation)),
    scale: [parent.scale[0] * child.scale[0], parent.scale[1] * child.scale[1], parent.scale[2] * child.scale[2]],
  };
}

/** Apply a TRS transform to a point. */
export function transformPoint(t: Transform, p: Vec3): Vec3 {
  const s: Vec3 = [p[0] * t.scale[0], p[1] * t.scale[1], p[2] * t.scale[2]];
  const r = quatRotate(t.rotation, s);
  return [r[0] + t.position[0], r[1] + t.position[1], r[2] + t.position[2]];
}

/** Convert an EQ-space transform to glTF space. */
export function transformEqToGl(t: Transform): Transform {
  return { position: eqToGl(t.position[0], t.position[1], t.position[2]), rotation: quatEqToGl(t.rotation), scale: scaleEqToGl(t.scale) };
}

export class Bounds {
  min: Vec3 = [Infinity, Infinity, Infinity];
  max: Vec3 = [-Infinity, -Infinity, -Infinity];

  addPoint(x: number, y: number, z: number): void {
    if (Math.abs(x) > 20000 || Math.abs(y) > 20000 || Math.abs(z) > 20000) return;
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
  }

  addPositions(p: Float32Array): void {
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      // Ignore stray vertices far outside any playable area (e.g. int16 extremes in unused WLD vertices).
      if (Math.abs(x) > 20000 || Math.abs(y) > 20000 || Math.abs(z) > 20000) continue;
      this.addPoint(x, y, z);
    }
  }

  get valid(): boolean {
    return this.min[0] <= this.max[0];
  }

  get center(): Vec3 {
    return [(this.min[0] + this.max[0]) / 2, (this.min[1] + this.max[1]) / 2, (this.min[2] + this.max[2]) / 2];
  }

  get size(): Vec3 {
    return [this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]];
  }
}

/** Accumulates triangles per material into one merged mesh. */
export class MeshMerger {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private hasNormals = true;
  private hasColors = true;
  private vertexCount = 0;
  private groups = new Map<number, number[]>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /** Append a vertex block already in glTF space; returns the base vertex index. */
  addVertices(positions: Float32Array, normals: Float32Array | undefined, uvs: Float32Array | undefined, colors: Uint8Array | undefined): number {
    const base = this.vertexCount;
    const n = positions.length / 3;
    for (let i = 0; i < positions.length; i++) this.positions.push(positions[i]);
    if (normals && normals.length === positions.length) {
      for (let i = 0; i < normals.length; i++) this.normals.push(normals[i]);
    } else {
      this.hasNormals = false;
    }
    if (uvs && uvs.length === n * 2) {
      for (let i = 0; i < uvs.length; i++) this.uvs.push(uvs[i]);
    } else {
      for (let i = 0; i < n * 2; i++) this.uvs.push(0);
    }
    if (colors && colors.length === n * 3) {
      for (let i = 0; i < colors.length; i++) this.colors.push(colors[i]);
    } else {
      this.hasColors = false;
    }
    this.vertexCount += n;
    return base;
  }

  addTriangles(material: number, indices: ArrayLike<number>, base: number, start = 0, end = indices.length): void {
    let list = this.groups.get(material);
    if (!list) {
      list = [];
      this.groups.set(material, list);
    }
    for (let i = start; i < end; i++) list.push(indices[i] + base);
  }

  get isEmpty(): boolean {
    return this.vertexCount === 0 || this.groups.size === 0;
  }

  build(): SceneMesh {
    const groups: MeshGroup[] = [];
    for (const [material, list] of this.groups) {
      if (list.length) groups.push({ material, indices: Uint32Array.from(list) });
    }
    return {
      name: this.name,
      positions: Float32Array.from(this.positions),
      normals: this.hasNormals && this.normals.length ? Float32Array.from(this.normals) : undefined,
      uvs: Float32Array.from(this.uvs),
      colors: this.hasColors && this.colors.length ? Uint8Array.from(this.colors) : undefined,
      groups,
    };
  }
}

/** Registry that dedupes materials by key. */
export class MaterialTable {
  readonly list: SceneMaterial[] = [];
  private index = new Map<string, number>();

  add(m: SceneMaterial): number {
    const hit = this.index.get(m.key);
    if (hit !== undefined) return hit;
    const i = this.list.length;
    this.list.push(m);
    this.index.set(m.key, i);
    return i;
  }
}
