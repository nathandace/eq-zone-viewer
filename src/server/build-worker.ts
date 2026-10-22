// Runs one zone build on a worker thread so the server keeps answering requests (textures, the zone list,
// the viewer itself) while a big zone is being converted.
import { parentPort, workerData } from 'node:worker_threads';
import { buildS3dZone } from './build-s3d.ts';
import { buildEqgZone } from './build-eqg.ts';
import { buildGlb } from './gltf.ts';

export interface BuildRequest {
  eqDir: string;
  name: string;
  kind: 's3d' | 'eqg';
}

export interface BuildResult {
  ok: true;
  glb: ArrayBuffer;
  stats: Record<string, unknown>;
  warnings: string[];
  bounds: unknown;
}

export interface BuildFailure {
  ok: false;
  error: string;
  stack: string;
}

const req = workerData as BuildRequest;
try {
  const scene = req.kind === 's3d' ? buildS3dZone(req.eqDir, req.name) : buildEqgZone(req.eqDir, req.name);
  const glb = buildGlb(scene);
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const msg: BuildResult = { ok: true, glb: ab, stats: scene.stats, warnings: scene.warnings, bounds: scene.bounds };
  parentPort!.postMessage(msg, [ab]);
} catch (e: any) {
  const msg: BuildFailure = { ok: false, error: String(e?.message || e), stack: String(e?.stack || '') };
  parentPort!.postMessage(msg);
}
