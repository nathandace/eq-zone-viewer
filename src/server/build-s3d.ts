// Builds a ZoneScene from classic S3D/WLD archives.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PfsArchive } from './pfs.ts';
import { Wld, wldMaterialMode, type Frag } from './wld.ts';
import {
  Bounds,
  MaterialTable,
  MeshMerger,
  composeTransform,
  eqToGl,
  quatFromEqEuler,
  transformEqToGl,
  transformPoint,
  type Instance,
  type MeshNode,
  type SceneLight,
  type SceneMaterial,
  type SceneMesh,
  type TextureRef,
  type Transform,
  type Vec3,
  type ZoneScene,
} from './scene.ts';

const TWO_PI_OVER_512 = (2 * Math.PI) / 512;
// EQ stores rotations for a row-vector (Direct3D) convention; negate for column-vector math.
const ROT_SIGN = -1;

interface WldContext {
  wld: Wld;
  archive: PfsArchive;
  archiveFile: string;
  resolve: (name: string) => string | undefined;
  materialCache: Map<number, number>;
}

function makeResolver(archive: PfsArchive, archiveFile: string): (name: string) => string | undefined {
  const names = new Set(archive.names());
  const base = archiveFile.replace(/\.(s3d|eqg)$/i, '');
  return (name: string) => {
    const n = name.toLowerCase();
    const stem = n.replace(/\.[^.]+$/, '');
    const candidates = [n, `${base}_${stem}.dds`, `${stem}.dds`, `${stem}.bmp`, `${base}_${stem}.bmp`, `${stem}.tga`];
    for (const c of candidates) if (names.has(c)) return c;
    return undefined;
  };
}

export class S3dBuilder {
  readonly eqDir: string;
  readonly zone: string;
  readonly materials = new MaterialTable();
  readonly meshes: SceneMesh[] = [];
  readonly nodes: MeshNode[] = [];
  readonly warnings: string[] = [];
  private missingTextures = new Set<string>();
  private contexts: WldContext[] = [];

  constructor(eqDir: string, zone: string) {
    this.eqDir = eqDir;
    this.zone = zone;
  }

  private warn(s: string): void {
    if (this.warnings.length < 500) this.warnings.push(s);
  }

  openContext(archive: PfsArchive, archiveFile: string, wldName: string): WldContext | undefined {
    const buf = archive.get(wldName);
    if (!buf) return undefined;
    const ctx: WldContext = {
      wld: new Wld(buf, wldName),
      archive,
      archiveFile,
      resolve: makeResolver(archive, archiveFile),
      materialCache: new Map(),
    };
    this.contexts.push(ctx);
    return ctx;
  }

  private materialFor(ctx: WldContext, frag: Frag): number {
    const hit = ctx.materialCache.get(frag.index);
    if (hit !== undefined) return hit;
    const { wld } = ctx;
    const m = wld.material(frag);
    const { mode, opacity, unlit } = wldMaterialMode(m.type, m.bitmapInfoRef !== 0);
    let frames: TextureRef[] | undefined;
    let delay = 0;
    if (m.bitmapInfoRef) {
      const f5 = wld.frag(m.bitmapInfoRef);
      if (f5?.type === 0x05) {
        const f4 = wld.frag(wld.bitmapInfoRef(f5));
        if (f4?.type === 0x04) {
          const bi = wld.bitmapInfo(f4);
          frames = [];
          for (const r of bi.refs) {
            const f3 = wld.frag(r);
            if (f3?.type !== 0x03) continue;
            const n = wld.bitmapName(f3).names[0];
            if (!n) continue;
            const file = ctx.resolve(n);
            if (file) frames.push({ archive: ctx.archiveFile, file, mask: mode === 'mask' });
            else if (!this.missingTextures.has(n)) {
              this.missingTextures.add(n);
              this.warn(`missing texture ${n} in ${ctx.archiveFile}`);
            }
          }
          delay = bi.animated ? bi.delayMs : 0;
        }
      }
    }
    const mat: SceneMaterial = {
      key: `${ctx.archiveFile}#${frag.index}`,
      name: frag.name || `material_${frag.index}`,
      mode,
      opacity,
      unlit,
      doubleSided: true,
      texture: frames?.[0],
      frames: frames && frames.length > 1 && delay > 0 ? frames : undefined,
      animDelayMs: delay || undefined,
      color: frames?.[0] ? undefined : [0.6, 0.6, 0.6],
    };
    const idx = this.materials.add(mat);
    ctx.materialCache.set(frag.index, idx);
    return idx;
  }

  /** Append a 0x36 mesh (optionally pre-transformed in EQ space) to a merger. */
  appendMesh(ctx: WldContext, meshFrag: Frag, merger: MeshMerger, transform?: (p: Vec3) => Vec3, boneTransforms?: Transform[], liquidMerger?: MeshMerger): void {
    const { wld } = ctx;
    const m = wld.mesh(meshFrag);
    const listFrag = wld.frag(m.materialListRef);
    const refs = listFrag?.type === 0x31 ? wld.materialList(listFrag).refs : [];
    const n = m.vertexCount;
    const positions = new Float32Array(n * 3);
    const normals = m.normals ? new Float32Array(n * 3) : undefined;
    const uvs = new Float32Array(n * 2);
    const colors = m.colors ? new Uint8Array(n * 3) : undefined;
    // Per-vertex bone transforms (skeleton pose)
    let vertexBone: Int32Array | undefined;
    if (boneTransforms && m.vertexPieces.length) {
      vertexBone = new Int32Array(n).fill(-1);
      let v = 0;
      for (const piece of m.vertexPieces) {
        for (let k = 0; k < piece.count && v < n; k++, v++) vertexBone[v] = piece.bone;
      }
    }
    for (let i = 0; i < n; i++) {
      let p: Vec3 = [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      let nm: Vec3 | undefined = m.normals ? [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]] : undefined;
      if (vertexBone && boneTransforms) {
        const b = vertexBone[i];
        const t = b >= 0 && b < boneTransforms.length ? boneTransforms[b] : undefined;
        if (t) {
          p = transformPoint(t, p);
          if (nm) nm = transformPoint({ position: [0, 0, 0], rotation: t.rotation, scale: [1, 1, 1] }, nm);
        }
      }
      if (transform) {
        p = transform(p);
      }
      const g = eqToGl(p[0], p[1], p[2]);
      positions[i * 3] = g[0];
      positions[i * 3 + 1] = g[1];
      positions[i * 3 + 2] = g[2];
      if (normals && nm) {
        const gn = eqToGl(nm[0], nm[1], nm[2]);
        normals[i * 3] = gn[0];
        normals[i * 3 + 1] = gn[1];
        normals[i * 3 + 2] = gn[2];
      }
      uvs[i * 2] = m.uvs[i * 2];
      uvs[i * 2 + 1] = 1 - m.uvs[i * 2 + 1];
      if (colors && m.colors) {
        colors[i * 3] = m.colors[i * 4];
        colors[i * 3 + 1] = m.colors[i * 4 + 1];
        colors[i * 3 + 2] = m.colors[i * 4 + 2];
      }
    }
    const base = merger.addVertices(positions, normals, uvs, colors);
    // Polygons flagged non-solid (0x10) are the water and lava surfaces: when a liquid merger is given they go
    // there instead, so the viewer can walk through them and swim under them.
    const NON_SOLID = 0x10;
    const hasLiquid = !!liquidMerger && m.polyFlags.some((f) => (f & NON_SOLID) !== 0);
    const liquidBase = hasLiquid ? liquidMerger!.addVertices(positions, normals, uvs, colors) : 0;
    const addTriangles = (mat: number, start: number, end: number) => {
      if (!hasLiquid) {
        merger.addTriangles(mat, m.indices, base, start, end);
        return;
      }
      const solid: number[] = [];
      const liquid: number[] = [];
      for (let i = start; i < end; i += 3) {
        const dst = (m.polyFlags[i / 3] & NON_SOLID) !== 0 ? liquid : solid;
        dst.push(m.indices[i], m.indices[i + 1], m.indices[i + 2]);
      }
      if (solid.length) merger.addTriangles(mat, solid, base);
      if (liquid.length) liquidMerger!.addTriangles(mat, liquid, liquidBase);
    };
    let poly = 0;
    const polyCount = m.indices.length / 3;
    if (m.materialGroups.length === 0) {
      // No groups: everything uses material 0
      const mf = wld.frag(refs[0]);
      const mat = mf?.type === 0x30 ? this.materialFor(ctx, mf) : this.fallbackMaterial();
      addTriangles(mat, 0, polyCount * 3);
      return;
    }
    for (const group of m.materialGroups) {
      const mf = wld.frag(refs[group.materialIndex]);
      const mat = mf?.type === 0x30 ? this.materialFor(ctx, mf) : this.fallbackMaterial();
      const start = poly * 3;
      const end = Math.min(polyCount, poly + group.count) * 3;
      addTriangles(mat, start, end);
      poly += group.count;
    }
    if (poly < polyCount) {
      const mf = wld.frag(refs[0]);
      const mat = mf?.type === 0x30 ? this.materialFor(ctx, mf) : this.fallbackMaterial();
      addTriangles(mat, poly * 3, polyCount * 3);
    }
  }

  private fallbackMaterial(): number {
    return this.materials.add({ key: 'fallback', name: 'fallback', mode: 'opaque', opacity: 1, unlit: true, doubleSided: true, color: [0.7, 0.7, 0.7] });
  }

  /** Compute bone world transforms (EQ space) for a 0x10 skeleton at its default pose. */
  private skeletonPose(ctx: WldContext, skelFrag: Frag): Transform[] {
    const { wld } = ctx;
    const skel = wld.skeleton(skelFrag);
    const out: Transform[] = skel.bones.map(() => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }));
    const visited = new Set<number>();
    const visit = (i: number, parent: Transform) => {
      if (i < 0 || i >= skel.bones.length || visited.has(i)) return;
      visited.add(i);
      const bone = skel.bones[i];
      let local: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
      const tf = wld.frag(bone.trackRef);
      if (tf?.type === 0x13) {
        const td = wld.frag(wld.trackRef(tf));
        if (td?.type === 0x12) {
          const frames = wld.trackDef(td).frames;
          if (frames.length) {
            const f = frames[0];
            local = { position: f.translation, rotation: f.rotation, scale: [f.scale, f.scale, f.scale] };
          }
        }
      }
      out[i] = composeTransform(parent, local);
      for (const c of bone.children) visit(c, out[i]);
    };
    visit(0, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    for (let i = 0; i < skel.bones.length; i++) if (!visited.has(i)) visit(i, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    return out;
  }

  /** Build a merged mesh for an actor definition (0x14). */
  private actorMesh(ctx: WldContext, actorFrag: Frag, name: string): SceneMesh | undefined {
    const { wld } = ctx;
    const def = wld.actorDef(actorFrag);
    const merger = new MeshMerger(name);
    for (const ref of def.componentRefs) {
      const comp = wld.frag(ref);
      if (!comp) continue;
      if (comp.type === 0x2d) {
        const mf = wld.frag(wld.meshRef(comp));
        if (mf?.type === 0x36) this.appendMesh(ctx, mf, merger);
      } else if (comp.type === 0x11) {
        const sf = wld.frag(wld.skeletonRef(comp));
        if (sf?.type !== 0x10) continue;
        const skel = wld.skeleton(sf);
        const pose = this.skeletonPose(ctx, sf);
        for (const mr of skel.meshRefs) {
          const r = wld.frag(mr);
          if (r?.type !== 0x2d) continue;
          const mf = wld.frag(wld.meshRef(r));
          if (mf?.type === 0x36) this.appendMesh(ctx, mf, merger, undefined, pose);
        }
        skel.bones.forEach((bone, i) => {
          if (!bone.meshRef) return;
          const r = wld.frag(bone.meshRef);
          if (r?.type !== 0x2d) return;
          const mf = wld.frag(wld.meshRef(r));
          if (mf?.type !== 0x36) return;
          const t = pose[i];
          this.appendMesh(ctx, mf, merger, (p) => transformPoint(t, p));
        });
      }
    }
    if (merger.isEmpty) return undefined;
    return merger.build();
  }

  build(): ZoneScene {
    const zone = this.zone;
    const mainFile = `${zone}.s3d`;
    const main = PfsArchive.open(join(this.eqDir, mainFile));
    const zoneCtx = this.openContext(main, mainFile, `${zone}.wld`);
    if (!zoneCtx) throw new Error(`${mainFile} has no ${zone}.wld`);
    const bounds = new Bounds();

    // Zone geometry: merge every 0x36 fragment.
    const zoneMerger = new MeshMerger('zone');
    const waterMerger = new MeshMerger('water');
    for (const f of zoneCtx.wld.byType(0x36)) this.appendMesh(zoneCtx, f, zoneMerger, undefined, undefined, waterMerger);
    let triangles = 0;
    for (const [merger, kind] of [[zoneMerger, 'zone'], [waterMerger, 'water']] as const) {
      if (merger.isEmpty) continue;
      const mesh = merger.build();
      bounds.addPositions(mesh.positions);
      triangles += mesh.groups.reduce((s, g) => s + g.indices.length / 3, 0);
      this.meshes.push(mesh);
      this.nodes.push({ name: kind, kind, mesh: this.meshes.length - 1, instances: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] });
    }

    // Object libraries
    const actors = new Map<string, { ctx: WldContext; frag: Frag }>();
    const libFiles = [`${zone}_obj.s3d`, `${zone}_2_obj.s3d`, `${zone}_obj2.s3d`, `${zone}_obj3.s3d`];
    const assetsTxt = join(this.eqDir, `${zone}_assets.txt`);
    if (existsSync(assetsTxt)) {
      for (const line of readFileSync(assetsTxt, 'latin1').split(/\r?\n/)) {
        const t = line.trim().toLowerCase();
        if (t.endsWith('.s3d') && !libFiles.includes(t)) libFiles.push(t);
      }
    }
    for (const lib of libFiles) {
      const p = join(this.eqDir, lib);
      if (!existsSync(p)) continue;
      let archive: PfsArchive;
      try {
        archive = PfsArchive.open(p);
      } catch (e: any) {
        this.warn(`cannot open ${lib}: ${e.message}`);
        continue;
      }
      for (const wldName of archive.namesWithExt('.wld')) {
        let ctx: WldContext | undefined;
        try {
          ctx = this.openContext(archive, lib, wldName);
        } catch (e: any) {
          this.warn(`cannot parse ${lib}/${wldName}: ${e.message}`);
          continue;
        }
        if (!ctx) continue;
        for (const f of ctx.wld.byType(0x14)) {
          const name = f.name.replace(/_ACTORDEF$/i, '').toLowerCase();
          if (!actors.has(name)) actors.set(name, { ctx, frag: f });
        }
      }
    }

    // Object placements
    const objCtx = this.openContext(main, mainFile, 'objects.wld');
    const meshByActor = new Map<string, number>();
    const instancesByActor = new Map<string, Instance[]>();
    const missingActors = new Map<string, number>();
    let instanceCount = 0;
    if (objCtx) {
      for (const f of objCtx.wld.byType(0x15)) {
        const inst = objCtx.wld.objectInstance(f);
        const name = inst.actorName;
        if (!name) continue;
        let meshIdx = meshByActor.get(name);
        if (meshIdx === undefined) {
          const actor = actors.get(name);
          if (!actor) {
            missingActors.set(name, (missingActors.get(name) || 0) + 1);
            continue;
          }
          let mesh: SceneMesh | undefined;
          try {
            mesh = this.actorMesh(actor.ctx, actor.frag, name);
          } catch (e: any) {
            this.warn(`actor ${name}: ${e.message}`);
          }
          if (!mesh) {
            meshByActor.set(name, -1);
            continue;
          }
          this.meshes.push(mesh);
          meshIdx = this.meshes.length - 1;
          meshByActor.set(name, meshIdx);
        }
        if (meshIdx < 0) continue;
        const scale = inst.scale[1] || inst.scale[0] || 1;
        const rz = inst.rotation[0] * TWO_PI_OVER_512 * ROT_SIGN;
        const ry = inst.rotation[1] * TWO_PI_OVER_512 * ROT_SIGN;
        const rx = inst.rotation[2] * TWO_PI_OVER_512 * ROT_SIGN;
        const t = transformEqToGl({ position: inst.position, rotation: quatFromEqEuler(rx, ry, rz), scale: [scale, scale, scale] });
        const instance: Instance = { position: t.position, rotation: t.rotation, scale: t.scale };
        if (inst.colorsRef) {
          const f33 = objCtx.wld.frag(inst.colorsRef);
          if (f33?.type === 0x33) {
            const f32 = objCtx.wld.frag(objCtx.wld.vertexColorsRef(f33));
            if (f32?.type === 0x32) {
              const c = objCtx.wld.vertexColors(f32).colors;
              const n = c.length / 4;
              if (n > 0) {
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < c.length; i += 4) {
                  r += c[i];
                  g += c[i + 1];
                  b += c[i + 2];
                }
                instance.color = [r / n / 255, g / n / 255, b / n / 255];
              }
            }
          }
        }
        let list = instancesByActor.get(name);
        if (!list) {
          list = [];
          instancesByActor.set(name, list);
        }
        list.push(instance);
        instanceCount++;
        bounds.addPoint(t.position[0], t.position[1], t.position[2]);
      }
    }
    for (const [name, instances] of instancesByActor) {
      const meshIdx = meshByActor.get(name)!;
      this.nodes.push({ name, kind: 'object', mesh: meshIdx, instances });
      triangles += this.meshes[meshIdx].groups.reduce((s, g) => s + g.indices.length / 3, 0) * instances.length;
    }
    for (const [name, count] of missingActors) this.warn(`missing object model ${name} (${count} placements)`);

    // Placed lights live in lights.wld inside the zone archive (0x28 placements -> 0x1C refs -> 0x1B definitions).
    const lights: SceneLight[] = [];
    const lightCtx = this.openContext(main, mainFile, 'lights.wld');
    if (lightCtx) {
      for (const f of lightCtx.wld.byType(0x28)) {
        const pl = lightCtx.wld.pointLight(f);
        let color: Vec3 = [1, 1, 1];
        const ref = lightCtx.wld.frag(pl.lightRef);
        if (ref?.type === 0x1c) {
          const def = lightCtx.wld.frag(lightCtx.wld.lightRef(ref));
          if (def?.type === 0x1b) {
            const d = lightCtx.wld.lightDef(def);
            color = [d.color[0] * d.level, d.color[1] * d.level, d.color[2] * d.level];
          }
        }
        lights.push({ position: eqToGl(pl.position[0], pl.position[1], pl.position[2]), color, radius: pl.radius });
      }
    }

    const center = bounds.valid ? bounds.center : ([0, 0, 0] as Vec3);
    const size = bounds.valid ? bounds.size : ([100, 100, 100] as Vec3);
    const extent = Math.max(size[0], size[2]);
    return {
      lights,
      name: zone,
      materials: this.materials.list,
      meshes: this.meshes,
      nodes: this.nodes,
      bounds: { min: bounds.min, max: bounds.max },
      warnings: this.warnings,
      stats: {
        format: `s3d (wld 0x${zoneCtx.wld.version.toString(16)})`,
        meshes: this.meshes.length,
        materials: this.materials.list.length,
        objects: instanceCount,
        objectTypes: instancesByActor.size,
        missingObjectTypes: missingActors.size,
        lights: lights.length,
        triangles,
      },
      start: {
        position: [center[0] - extent * 0.45, bounds.valid ? bounds.max[1] + extent * 0.35 : 100, center[2]],
        target: center,
      },
    };
  }
}

export function buildS3dZone(eqDir: string, zone: string): ZoneScene {
  return new S3dBuilder(eqDir, zone).build();
}

/**
 * The default sky from sky.s3d: dome layer 1 and its cloud layer. The file holds fifteen sky variants
 * (LAYER<n>1 dome, LAYER<n>3 clouds) but which one a zone uses is server-side data, so the viewer shows
 * the standard blue sky everywhere.
 */
export function buildSkyScene(eqDir: string, variant = 1): ZoneScene {
  const b = new S3dBuilder(eqDir, 'sky');
  const file = 'sky.s3d';
  const archive = PfsArchive.open(join(eqDir, file));
  const ctx = b.openContext(archive, file, 'sky.wld');
  if (!ctx) throw new Error('sky.s3d has no sky.wld');
  const bounds = new Bounds();
  for (const [suffix, name] of [
    ['1', 'skydome'],
    ['3', 'clouds'],
  ] as const) {
    const frag = ctx.wld.byType(0x36).find((f) => f.name === `LAYER${variant}${suffix}_DMSPRITEDEF`);
    if (!frag) continue;
    const merger = new MeshMerger(name);
    b.appendMesh(ctx, frag, merger);
    if (merger.isEmpty) continue;
    const mesh = merger.build();
    bounds.addPositions(mesh.positions);
    b.meshes.push(mesh);
    b.nodes.push({ name, kind: 'sky', mesh: b.meshes.length - 1, instances: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] });
  }
  return {
    name: 'sky',
    materials: b.materials.list,
    meshes: b.meshes,
    nodes: b.nodes,
    bounds: { min: bounds.min, max: bounds.max },
    warnings: b.warnings,
    stats: { format: 'sky.s3d', meshes: b.meshes.length },
  };
}
