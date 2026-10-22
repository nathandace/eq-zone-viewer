import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadZoneMap, resolveTarget } from '../src/server/maps.ts';
import type { ZoneInfo } from '../src/server/zones.ts';

const zone = (name: string, longName: string): ZoneInfo => ({ name, kind: 's3d', longName, archive: `${name}.s3d`, sizeBytes: 0 });
const zones = [
  zone('gfaydark', 'Greater Faydark'),
  zone('crushbone', 'Clan Crushbone'),
  zone('felwithea', 'North Felwithe'),
  zone('lfaydark', 'Lesser Faydark'),
  zone('butcher', 'Butcherblock Mountains'),
  zone('oasis', 'Oasis of Marr'),
];

test('resolveTarget matches zone-line labels to zones', () => {
  assert.equal(resolveTarget('to_Crushbone', zones), 'crushbone');
  assert.equal(resolveTarget('to Northern Felwithe', zones), 'felwithea');
  assert.equal(resolveTarget('to_Lesser_Faydark', zones), 'lfaydark');
  assert.equal(resolveTarget('to Butcherblock', zones), 'butcher');
  assert.equal(resolveTarget('TO THE OASIS OF MARR', zones), 'oasis');
  assert.equal(resolveTarget('Bank', zones), undefined);
  assert.equal(resolveTarget('to Nowhere Special', zones), undefined);
});

test('loadZoneMap parses segments and labels into viewer space', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqzv-maps-'));
  try {
    mkdirSync(join(dir, 'maps'));
    writeFileSync(join(dir, 'maps', 'gfaydark.txt'), 'L 10, 20, 5,  30, 40, 5,  64, 64, 64\nP 52.4, -2596.6, 15.8,  0, 0, 0,  3,  to_Crushbone\nnot a map line\n');
    writeFileSync(join(dir, 'maps', 'GFAYDARK_1.txt'), 'P 1, 2, 3, 255, 0, 0, 2, Bank\n');
    const map = loadZoneMap(dir, 'gfaydark', zones);
    assert.ok(map);
    assert.deepEqual(map.files, ['GFAYDARK_1.txt', 'gfaydark.txt']);
    // map (x, y, z) = (-locX, -locY, locZ)  ->  viewer (x = -my, y = mz, z = mx)
    assert.deepEqual(map.lines, [-20, 5, 10, -40, 5, 30]);
    assert.deepEqual(map.colors, [64, 64, 64]);
    assert.equal(map.labels.length, 2);
    const zl = map.labels.find((l) => l.text === 'to Crushbone');
    assert.ok(zl);
    assert.equal(zl.target, 'crushbone');
    assert.deepEqual(zl.p, [2596.6, 15.8, 52.4]);
    assert.equal(map.labels.find((l) => l.text === 'Bank')?.target, undefined);
    assert.equal(loadZoneMap(dir, 'nowhere', zones), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
