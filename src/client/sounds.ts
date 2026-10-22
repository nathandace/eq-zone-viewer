// Zone sounds through the Web Audio API: positional ambient loops and one-shot emitters from the zone's
// sound placements, day or night variants by the Daylight slider, and MP3 zone music where the game has it.
import * as THREE from 'three';
import type { ViewerCtx } from './context.ts';

interface EmitterDef {
  p: [number, number, number];
  radius: number;
  kind: 'loop' | 'emit' | 'music';
  day?: string;
  night?: string;
  cooldown: [number, number];
  volume: number;
}

interface Playing {
  file: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
}

interface Emitter {
  def: EmitterDef;
  pos: THREE.Vector3;
  playing: Playing | null;
  starting: string | null;
  nextAt: number;
}

const MAX_ACTIVE = 24;

export function initSounds(ctx: ViewerCtx): void {
  const { $, camera } = ctx;
  const opt = $<HTMLInputElement>('opt-sound');
  const volumeEl = $<HTMLInputElement>('opt-volume');
  const ambientEl = $<HTMLInputElement>('opt-ambient');
  let actx: AudioContext | null = null;
  let master: GainNode | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  let emitters: Emitter[] = [];
  let music: { def: EmitterDef; el: HTMLAudioElement } | null = null;
  let acc = 1;
  let loadedZone = '';

  function ensureContext(): void {
    if (!opt.checked) return;
    if (!actx) {
      actx = new AudioContext();
      master = actx.createGain();
      master.connect(actx.destination);
    }
    if (actx.state === 'suspended') void actx.resume();
  }
  // Browsers only start audio after a user gesture.
  for (const ev of ['mousedown', 'keydown', 'touchstart']) window.addEventListener(ev, ensureContext, { passive: true });

  function buffer(file: string): Promise<AudioBuffer | null> {
    let p = buffers.get(file);
    if (!p) {
      p = (async () => {
        try {
          const res = await fetch(`/api/sound/${encodeURIComponent(file)}`);
          if (!res.ok) return null;
          return await actx!.decodeAudioData(await res.arrayBuffer());
        } catch {
          return null;
        }
      })();
      buffers.set(file, p);
    }
    return p;
  }

  function stop(e: Emitter): void {
    if (e.playing) {
      try {
        e.playing.src.stop();
      } catch {
        /* already stopped */
      }
      e.playing.src.disconnect();
      e.playing.gain.disconnect();
      e.playing = null;
    }
    e.starting = null;
  }

  function stopMusic(): void {
    if (music) {
      music.el.pause();
      music.el.src = '';
      music = null;
    }
  }

  function stopAll(): void {
    for (const e of emitters) stop(e);
    stopMusic();
  }

  async function start(e: Emitter, file: string, loop: boolean): Promise<void> {
    if (!actx || !master) return;
    e.starting = file;
    const buf = await buffer(file);
    if (!buf || e.starting !== file || !actx || !master) {
      if (e.starting === file) e.starting = null;
      return;
    }
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const gain = actx.createGain();
    gain.gain.value = e.def.volume;
    src.connect(gain);
    if (e.def.radius > 0) {
      const panner = actx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'linear';
      panner.refDistance = Math.max(1, e.def.radius * 0.15);
      panner.maxDistance = Math.max(2, e.def.radius);
      panner.rolloffFactor = 1;
      panner.positionX.value = e.pos.x;
      panner.positionY.value = e.pos.y;
      panner.positionZ.value = e.pos.z;
      gain.connect(panner);
      panner.connect(master);
    } else {
      gain.connect(master);
    }
    src.start();
    e.playing = { file, src, gain };
    e.starting = null;
    if (!loop) src.onended = () => {
      if (e.playing?.src === src) e.playing = null;
    };
  }

  function updateListener(): void {
    if (!actx) return;
    const l = actx.listener;
    const p = camera.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = u.x;
      l.upY.value = u.y;
      l.upZ.value = u.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  function updateMusic(def: EmitterDef | null): void {
    const vol = (Number(volumeEl.value) / 100) * 0.5;
    if (!def) {
      stopMusic();
      return;
    }
    const file = def.day ?? def.night;
    if (!file) return;
    if (music && music.def === def) {
      music.el.volume = vol;
      return;
    }
    stopMusic();
    const el = new Audio(`/api/sound/${encodeURIComponent(file)}`);
    el.loop = true;
    el.volume = vol;
    el.play().catch(() => undefined);
    music = { def, el };
  }

  function tick(): void {
    if (!opt.checked || !actx || !master || !ctx.zoneRoot()) {
      if (emitters.some((e) => e.playing || e.starting) || music) stopAll();
      return;
    }
    master.gain.value = Number(volumeEl.value) / 100;
    updateListener();
    const day = Number(ambientEl.value) >= 50;
    const now = performance.now();
    const cam = camera.position;
    let musicDef: EmitterDef | null = null;
    let musicDist = Infinity;
    const candidates: { e: Emitter; file: string; d: number }[] = [];
    for (const e of emitters) {
      const file = day ? e.def.day : e.def.night;
      const d = e.pos.distanceTo(cam);
      const inRange = e.def.radius <= 0 || d < e.def.radius;
      if (e.def.kind === 'music') {
        if (inRange && d < musicDist) {
          musicDist = d;
          musicDef = e.def;
        }
        continue;
      }
      if (!inRange || !file) {
        if (e.playing || e.starting) stop(e);
        continue;
      }
      if (e.playing && e.playing.file !== file) stop(e);
      candidates.push({ e, file, d: d - e.def.radius });
    }
    candidates.sort((a, b) => a.d - b.d);
    candidates.slice(MAX_ACTIVE).forEach(({ e }) => stop(e));
    for (const { e, file } of candidates.slice(0, MAX_ACTIVE)) {
      if (e.playing || e.starting) continue;
      const continuous = e.def.kind === 'loop' || (e.def.cooldown[0] === 0 && e.def.cooldown[1] === 0) || /_lp\d*\.wav$/.test(file);
      if (continuous) void start(e, file, true);
      else if (now >= e.nextAt) {
        const [min, max] = e.def.cooldown;
        e.nextAt = now + min + Math.random() * Math.max(0, max - min);
        void start(e, file, false);
      }
    }
    updateMusic(musicDef);
  }

  ctx.events.on('zoneLoaded', async (zone) => {
    stopAll();
    emitters = [];
    loadedZone = zone.name;
    try {
      const res = await fetch(`/api/zone/${zone.name}/sounds.json`);
      if (!res.ok || ctx.zone()?.name !== zone.name) return;
      const data = (await res.json()) as { emitters: EmitterDef[]; files: string[]; skippedMidi: number };
      if (ctx.zone()?.name !== zone.name) return;
      emitters = data.emitters.map((def) => ({ def, pos: new THREE.Vector3(def.p[0], def.p[1], def.p[2]), playing: null, starting: null, nextAt: 0 }));
      console.log(`[sound] ${data.files.join(', ')}: ${emitters.length} emitters (${emitters.filter((e) => e.def.kind === 'music').length} music)${data.skippedMidi ? `, ${data.skippedMidi} MIDI music entries skipped` : ''}`);
    } catch (e) {
      console.warn('[sound] failed to load', e);
    }
  });
  ctx.events.on('zoneCleared', () => {
    stopAll();
    emitters = [];
    loadedZone = '';
  });
  ctx.events.on('frame', (dt) => {
    acc += dt;
    if (acc < 0.25) return;
    acc = 0;
    tick();
  });
  opt.addEventListener('change', () => {
    if (opt.checked) ensureContext();
    else stopAll();
  });

  (window as any).eqViewer ??= {};
  (window as any).eqViewer.sound = () => ({
    zone: loadedZone,
    context: actx?.state ?? null,
    emitters: emitters.length,
    playing: emitters.filter((e) => e.playing).map((e) => e.playing!.file),
    music: music ? music.def.day : null,
  });
}
