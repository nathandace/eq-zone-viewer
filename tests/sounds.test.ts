import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmt, parseSoundBank, parseSoundsEff, isSafeSoundName } from '../src/server/sounds.ts';

function record(fields: { x: number; y: number; z: number; radius: number; type: number; day: number; night: number; cooldown?: number; random?: number }): Buffer {
  const b = Buffer.alloc(84);
  b.writeFloatLE(fields.x, 16);
  b.writeFloatLE(fields.y, 20);
  b.writeFloatLE(fields.z, 24);
  b.writeFloatLE(fields.radius, 28);
  b.writeInt32LE(fields.cooldown ?? 0, 32);
  b.writeInt32LE(fields.cooldown ?? 0, 36);
  b.writeInt32LE(fields.random ?? 0, 40);
  b.writeInt32LE(fields.day, 48);
  b.writeInt32LE(fields.night, 52);
  b[56] = fields.type;
  b[57] = 0xff; // the bytes after the type are padding garbage in real files
  return b;
}

test('parseSoundBank splits EMIT and LOOP sections', () => {
  const bank = parseSoundBank('EMIT\r\nfire_lp\r\nbird1\r\nLOOP\r\nwind_lp2\r\nnight\r\n');
  assert.deepEqual(bank, { emit: ['fire_lp', 'bird1'], loop: ['wind_lp2', 'night'] });
});

test('parseSoundsEff maps records to emitters in viewer space', () => {
  const bank = parseSoundBank('EMIT\nfire_lp\nbird1\nLOOP\nwind_lp2\nnight\n');
  const buf = Buffer.concat([
    record({ x: 10, y: 20, z: 5, radius: 70, type: 2, day: 2, night: 0, cooldown: 4000, random: 2000 }),
    record({ x: -100, y: 50, z: 1, radius: 900, type: 1, day: 1, night: 2 }),
    record({ x: 0, y: 0, z: 0, radius: 1000, type: 0, day: 162, night: 164 }),
  ]);
  const { emitters, skippedMidi } = parseSoundsEff(buf, bank);
  assert.equal(skippedMidi, 1);
  assert.equal(emitters.length, 2);
  assert.deepEqual(emitters[0].p, [10, 5, -20]);
  assert.equal(emitters[0].kind, 'emit');
  assert.equal(emitters[0].day, 'bird1.wav');
  assert.equal(emitters[0].night, undefined);
  assert.deepEqual(emitters[0].cooldown, [4000, 6000]);
  assert.equal(emitters[1].kind, 'loop');
  assert.equal(emitters[1].day, 'wind_lp2.wav');
  assert.equal(emitters[1].night, 'night.wav');
  assert.equal(emitters[1].radius, 900);
});

test('parseEmt reads newer-zone emitters and music', () => {
  const text = [
    '2,mx_aalishai.mp3,0,0,0.75,0,0,1,-10.36,29.69,5.26,0.00,0.00,0.00,0.00,5000,5000,0,1.00,1,0,0',
    '2,sfx_water_lap_sm_lp.wav,0,0,0.90,500,1000,0,-859.79,10.39,127.36,20.00,65.00,0.00,65.00,0,0,0,1.00,1,0,0',
    'garbage line',
  ].join('\n');
  const out = parseEmt(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'music');
  assert.equal(out[0].day, 'mx_aalishai.mp3');
  assert.equal(out[0].volume, 0.75);
  assert.equal(out[1].kind, 'emit');
  assert.deepEqual(out[1].cooldown, [500, 1000]);
  assert.equal(out[1].radius, 65);
  assert.deepEqual(out[1].p, [-859.79, 127.36, -10.39]);
});

test('isSafeSoundName only accepts plain wav and mp3 names', () => {
  assert.equal(isSafeSoundName('fire_lp.wav'), true);
  assert.equal(isSafeSoundName('mx_aalishai.mp3'), true);
  assert.equal(isSafeSoundName('../config.json'), false);
  assert.equal(isSafeSoundName('a/b.wav'), false);
  assert.equal(isSafeSoundName('eqgame.exe'), false);
});
