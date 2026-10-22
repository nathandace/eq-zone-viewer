// Parser validation against real archives. Usage: node tools/inspect.ts "<eq dir>"
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { PfsArchive } from '../src/server/pfs.ts';
import { resolveEqDir } from '../src/server/config.ts';
import { Wld, wldMaterialMode } from '../src/server/wld.ts';
import { parseTerMod, parseZonBinary, parseZonV4, parseV4Terrain, isTextZon, parseEco, parseTog } from '../src/server/eqg.ts';
import { decodeTexture, encodePng, isDds, isBmp } from '../src/server/textures.ts';

const eqDir = resolveEqDir(process.argv[2]).eqDir!;
if (!eqDir) {
  console.error('No EverQuest directory found: pass it as the first argument, set EQ_DIR, or put "eqDir" in config.json.');
  process.exit(1);
}
const hist = (xs: (string | number)[]) => {
  const m = new Map<string | number, number>();
  for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${typeof k === 'number' ? '0x' + k.toString(16) : k}:${v}`).join(' ');
};

function inspectS3d(zone: string) {
  console.log(`\n===== ${zone}.s3d =====`);
  const a = PfsArchive.open(join(eqDir, `${zone}.s3d`));
  const wld = new Wld(a.get(`${zone}.wld`)!, `${zone}.wld`);
  console.log('version', wld.version.toString(16), 'frags', wld.frags.length);
  console.log('types:', hist(wld.frags.map((f) => f.type)));
  const names = wld.byType(0x03).map((f) => wld.bitmapName(f).names.join('|'));
  console.log('0x03 sample:', names.slice(0, 8).join(', '));
  const archiveNames = new Set(a.names());
  let found = 0, missing = 0;
  const missingList: string[] = [];
  for (const n of wld.byType(0x03)) {
    for (const nm of wld.bitmapName(n).names) {
      const base = nm.replace(/\.[^.]+$/, '');
      const candidates = [nm, `${zone}_${base}.dds`, `${base}.dds`, `${base}.bmp`];
      if (candidates.some((c) => archiveNames.has(c))) found++;
      else {
        missing++;
        if (missingList.length < 5) missingList.push(nm);
      }
    }
  }
  console.log(`textures found ${found}, missing ${missing}`, missingList);
  const mats = wld.byType(0x30).map((f) => wld.material(f));
  console.log('material types:', hist(mats.map((m) => m.type)));
  console.log('material modes:', hist(mats.map((m) => wldMaterialMode(m.type, m.bitmapInfoRef !== 0).mode)));
  const meshes = wld.byType(0x36).map((f) => wld.mesh(f));
  const tris = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  const verts = meshes.reduce((s, m) => s + m.vertexCount, 0);
  console.log(`meshes ${meshes.length}, verts ${verts}, tris ${tris}, with colors: ${meshes.filter((m) => m.colors).length}, with normals: ${meshes.filter((m) => m.normals).length}`);
  const m0 = meshes[0];
  if (m0) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length; i += 3) {
        minx = Math.min(minx, m.positions[i]); maxx = Math.max(maxx, m.positions[i]);
        miny = Math.min(miny, m.positions[i + 1]); maxy = Math.max(maxy, m.positions[i + 1]);
        minz = Math.min(minz, m.positions[i + 2]); maxz = Math.max(maxz, m.positions[i + 2]);
      }
    }
    console.log(`bounds x[${minx.toFixed(0)},${maxx.toFixed(0)}] y[${miny.toFixed(0)},${maxy.toFixed(0)}] z[${minz.toFixed(0)},${maxz.toFixed(0)}]`);
    console.log('uv sample:', Array.from(m0.uvs.slice(0, 8)).map((v) => v.toFixed(2)).join(','), 'groups:', m0.materialGroups.slice(0, 4).map((g) => `${g.count}@${g.materialIndex}`).join(' '));
    const groupSum = meshes.map((m) => m.materialGroups.reduce((s, g) => s + g.count, 0) === m.indices.length / 3);
    console.log('group counts match poly counts:', groupSum.every(Boolean));
  }
  // objects
  const objWld = new Wld(a.get('objects.wld')!, 'objects.wld');
  const inst = objWld.byType(0x15).map((f) => objWld.objectInstance(f));
  console.log(`objects.wld: ${inst.length} instances; sample:`, inst.slice(0, 3).map((i) => `${i.actorName} @${i.position.map((v) => v.toFixed(1))} rot${i.rotation.map((v) => v.toFixed(1))} s${i.scale.map((v) => v.toFixed(2))}`).join(' ; '));
  console.log('actor names:', hist(inst.map((i) => i.actorName)).slice(0, 300));
  const rotHist = hist(inst.map((i) => `${i.rotation[1] !== 0 ? 'y' : ''}${i.rotation[2] !== 0 ? 'x' : ''}`));
  console.log('non-heading rotations:', rotHist);
  const objFile = `${zone}_obj.s3d`;
  if (existsSync(join(eqDir, objFile))) {
    const ob = PfsArchive.open(join(eqDir, objFile));
    const ow = new Wld(ob.get(`${zone}_obj.wld`)!, `${zone}_obj.wld`);
    console.log(`${objFile}: types:`, hist(ow.frags.map((f) => f.type)));
    const actors = ow.byType(0x14).map((f) => ({ name: f.name, def: ow.actorDef(f) }));
    console.log('actors:', actors.length, actors.slice(0, 5).map((a) => `${a.name}->${a.def.componentRefs.map((r) => '0x' + (ow.frag(r)?.type ?? 0).toString(16))}`).join(' '));
    const compTypes = hist(actors.flatMap((a) => a.def.componentRefs.map((r) => ow.frag(r)?.type ?? -1)));
    console.log('actor component types:', compTypes);
    const objNames = new Set(ob.names());
    let f2 = 0, m2 = 0;
    for (const n of ow.byType(0x03)) for (const nm of ow.bitmapName(n).names) {
      const base = nm.replace(/\.[^.]+$/, '');
      if ([nm, `${zone}_obj_${base}.dds`, `${base}.dds`].some((c) => objNames.has(c))) f2++; else m2++;
    }
    console.log(`obj textures found ${f2} missing ${m2}`);
    const sk = ow.byType(0x10);
    if (sk.length) {
      const s = ow.skeleton(sk[0]);
      console.log(`skeleton ${sk[0].name}: bones ${s.bones.length}, meshRefs ${s.meshRefs.length}, flags 0x${s.flags.toString(16)}`);
      const td = ow.frag(ow.trackRef(ow.frag(s.bones[0].trackRef)!));
      if (td) console.log('trackdef frames', ow.trackDef(td).frames.length, JSON.stringify(ow.trackDef(td).frames[0]));
    }
  }
  // texture decode
  const texNames = a.names().filter((n) => /\.(bmp|dds)$/.test(n)).slice(0, 3);
  for (const t of texNames) {
    const b = a.get(t)!;
    const img = decodeTexture(b, false);
    console.log(`tex ${t}: ${isDds(b) ? 'dds' : isBmp(b) ? 'bmp' : '?'} ${img ? `${img.width}x${img.height} png=${encodePng(img).length}` : 'UNSUPPORTED'}`);
  }
}

function inspectEqg(zone: string) {
  console.log(`\n===== ${zone}.eqg =====`);
  const a = PfsArchive.open(join(eqDir, `${zone}.eqg`));
  const names = a.names();
  const zonInside = names.find((n) => n.endsWith('.zon'));
  const loose = join(eqDir, `${zone}.zon`);
  const zonBuf = zonInside ? a.get(zonInside)! : existsSync(loose) ? readFileSync(loose) : undefined;
  if (!zonBuf) {
    console.log('no zon');
  } else if (isTextZon(zonBuf)) {
    const z = parseZonV4(zonBuf);
    console.log('v4 zon:', JSON.stringify(z));
    const dat = a.get(`${z.name.toLowerCase()}.dat`) ?? a.get(`${zone}.dat`);
    if (dat) {
      const t0 = Date.now();
      const terr = parseV4Terrain(dat, z);
      console.log(`terrain: version ${terr.version} flags ${terr.flags} base ${terr.baseTileTexture} tiles ${terr.tiles.length} in ${Date.now() - t0}ms`);
      const t = terr.tiles[0];
      console.log(`tile0 lng ${t.lng} lat ${t.lat} start(${t.startX},${t.startY}) h[${Math.min(...t.heights).toFixed(1)},${Math.max(...t.heights).toFixed(1)}] base ${t.baseMaterial} layers ${t.layers.map((l) => `${l.material}:${l.dim}`)} placeables ${t.placeables.length} togs ${t.togRefs.length} color0 ${t.colors[0].toString(16)}`);
      const allPl = terr.tiles.flatMap((t) => t.placeables);
      console.log('placeables total', allPl.length, 'models:', hist(allPl.map((p) => p.modelName)).slice(0, 400));
      console.log('placeable sample:', allPl.slice(0, 3).map((p) => `${p.modelName} pos${p.position.map((v) => v.toFixed(1))} rot${p.rotation.map((v) => v.toFixed(1))} scale${p.scale.map((v) => v.toFixed(2))}`).join(' ; '));
      const togs = terr.tiles.flatMap((t) => t.togRefs);
      console.log('tog refs', togs.length, togs.slice(0, 2).map((t) => `${t.name} pos${t.position.map((v) => v.toFixed(1))} rot${t.rotation.map((v) => v.toFixed(1))} scale${t.scale} adj${t.zAdjust}`).join(' ; '));
      const baseMats = hist(terr.tiles.map((t) => t.baseMaterial));
      console.log('tile base materials:', baseMats);
      const ecos = names.filter((n) => n.endsWith('.eco'));
      console.log('ecos:', ecos.join(' '));
      if (ecos[0]) console.log('eco0 layers:', JSON.stringify(parseEco(a.get(ecos[0])!)));
      const togFiles = names.filter((n) => n.endsWith('.tog'));
      if (togFiles[0]) console.log(`tog ${togFiles[0]}:`, JSON.stringify(parseTog(a.get(togFiles[0])!).slice(0, 2)));
    }
  } else {
    const z = parseZonBinary(zonBuf);
    console.log(`binary zon v${z.version}: models ${z.models.length} placeables ${z.placeables.length} regions ${z.regions.length} lights ${z.lights.length}`);
    console.log('models:', z.models.slice(0, 10).join(' '));
    console.log('placeable sample:', z.placeables.slice(0, 3).map((p) => `${p.modelName} pos${p.position.map((v) => v.toFixed(1))} rot${p.rotation.map((v) => v.toFixed(2))} scale${p.scale.toFixed(2)}`).join(' ; '));
    const maxRot = Math.max(...z.placeables.map((p) => Math.max(...p.rotation.map(Math.abs))));
    console.log('max |rotation| =', maxRot.toFixed(2));
    console.log('regions sample:', z.regions.slice(0, 3).map((r) => r.name).join(' '));
  }
  const ter = names.find((n) => n.endsWith('.ter'));
  if (ter) {
    const g = parseTerMod(a.get(ter)!, ter);
    console.log(`ter ${ter}: v${g.version} mats ${g.materials.length} verts ${g.positions.length / 3} faces ${g.faceMaterial.length}`);
    console.log('mat0:', JSON.stringify(g.materials[0]));
    console.log('shaders:', hist(g.materials.map((m) => m.shader)));
    console.log('uv sample:', Array.from(g.uvs.slice(0, 6)).map((v) => v.toFixed(2)).join(','), 'uv2:', g.uvs2 ? Array.from(g.uvs2.slice(0, 6)).map((v) => v.toFixed(2)).join(',') : '-');
    console.log('face flags:', hist(Array.from(g.faceFlags)).slice(0, 200), 'face mats:', hist(Array.from(g.faceMaterial)).slice(0, 200));
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3) { minx = Math.min(minx, g.positions[i]); maxx = Math.max(maxx, g.positions[i]); miny = Math.min(miny, g.positions[i + 1]); maxy = Math.max(maxy, g.positions[i + 1]); }
    console.log(`ter bounds x[${minx.toFixed(0)},${maxx.toFixed(0)}] y[${miny.toFixed(0)},${maxy.toFixed(0)}]`);
  }
  const mods = names.filter((n) => n.endsWith('.mod')).slice(0, 2);
  for (const m of mods) {
    const g = parseTerMod(a.get(m)!, m);
    console.log(`mod ${m}: v${g.version} mats ${g.materials.length} verts ${g.positions.length / 3} faces ${g.faceMaterial.length} bones ${g.boneCount} shader ${g.materials[0]?.shader} props ${g.materials[0]?.props.map((p) => `${p.name}=${p.value}`).join(',')}`);
  }
  const dds = names.filter((n) => n.endsWith('.dds')).slice(0, 2);
  for (const t of dds) {
    const img = decodeTexture(a.get(t)!);
    console.log(`tex ${t}: ${img ? `${img.width}x${img.height}` : 'UNSUPPORTED'}`);
  }
}

inspectS3d('gfaydark');
inspectS3d('freporte');
inspectEqg('guildlobby');
inspectEqg('steamfontmts');
