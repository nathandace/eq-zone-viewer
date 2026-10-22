import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTexture, downsample, encodePng, isBmp, isDds } from '../src/server/textures.ts';

/** A 24-bit bottom-up BMP: bottom row red, green; top row blue, white. */
function bmp24(): Buffer {
  const width = 2;
  const height = 2;
  const rowBytes = 8; // 2 px * 3 bytes, padded to 4
  const data = Buffer.alloc(rowBytes * height);
  const px = (row: number, col: number, b: number, g: number, r: number) => {
    data[row * rowBytes + col * 3] = b;
    data[row * rowBytes + col * 3 + 1] = g;
    data[row * rowBytes + col * 3 + 2] = r;
  };
  px(0, 0, 0, 0, 255); // bottom-left red
  px(0, 1, 0, 255, 0); // bottom-right green
  px(1, 0, 255, 0, 0); // top-left blue
  px(1, 1, 255, 255, 255); // top-right white
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  return Buffer.concat([header, data]);
}

test('decodes a 24-bit BMP top-down into RGBA', () => {
  const buf = bmp24();
  assert.equal(isBmp(buf), true);
  assert.equal(isDds(buf), false);
  const img = decodeTexture(buf);
  assert.ok(img);
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  assert.deepEqual([...img.data.subarray(0, 4)], [0, 0, 255, 255], 'top-left is blue');
  assert.deepEqual([...img.data.subarray(4, 8)], [255, 255, 255, 255], 'top-right is white');
  assert.deepEqual([...img.data.subarray(8, 12)], [255, 0, 0, 255], 'bottom-left is red');
  assert.deepEqual([...img.data.subarray(12, 16)], [0, 255, 0, 255], 'bottom-right is green');
});

test('downsample averages blocks and encodePng writes a PNG', () => {
  const img = decodeTexture(bmp24())!;
  const small = downsample(img, 2);
  assert.equal(small.width, 1);
  assert.equal(small.height, 1);
  assert.equal(small.data[3], 255);
  const png = encodePng(img);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
});

test('rejects data that is neither BMP nor DDS', () => {
  assert.equal(decodeTexture(Buffer.from('hello world, not an image')), undefined);
});
