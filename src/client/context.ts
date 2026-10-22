// Shared surface the viewer core exposes to feature modules (maps, minimap, bookmarks, ...).
import type * as THREE from 'three';

export interface ZoneInfo {
  name: string;
  kind: 's3d' | 'eqg';
  longName: string;
}

export interface ZoneBounds {
  min: number[];
  max: number[];
}

interface Handlers {
  /** A zone finished loading and is in the scene (extras = glTF root extras: stats, bounds, start). */
  zoneLoaded: (zone: ZoneInfo, extras: any) => void;
  /** The current zone was removed from the scene. */
  zoneCleared: () => void;
  /** Once per animation frame, before the main render. */
  frame: (dt: number) => void;
}

export class Emitter {
  private handlers: Partial<{ [K in keyof Handlers]: Handlers[K][] }> = {};

  on<K extends keyof Handlers>(name: K, fn: Handlers[K]): void {
    ((this.handlers[name] ??= []) as Handlers[K][]).push(fn);
  }

  emit<K extends keyof Handlers>(name: K, ...args: Parameters<Handlers[K]>): void {
    for (const fn of (this.handlers[name] ?? []) as Handlers[K][]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (e) {
        console.error(`[${name}] handler failed`, e);
      }
    }
  }
}

export interface ViewerCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  events: Emitter;
  $: <T extends HTMLElement>(id: string) => T;
  zone(): ZoneInfo | null;
  zones(): ZoneInfo[];
  zoneRoot(): THREE.Group | null;
  bounds(): ZoneBounds | null;
  yaw(): number;
  pitch(): number;
  /** Camera heading in EverQuest degrees (0 = north, clockwise). */
  heading(): number;
  setView(yaw: number, pitch: number): void;
  /** Move the camera to a point in viewer space. With ground=true the camera is placed at eye height on the floor below. */
  goTo(x: number, y: number, z: number, opts?: { ground?: boolean }): void;
  /** Load a zone by short name; resolves true once it is in the scene. */
  loadZone(name: string): Promise<boolean>;
  walking(): boolean;
  swimming(): boolean;
  setWalkMode(on: boolean): void;
  setStatus(s: string): void;
  /** Object layer used for screen-space labels (excluded from the top-down renders). */
  layers: { labels: number };
  /** Build the URL fragment for the current view. */
  viewLink(): string;
}
