import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PfsArchive, pfsCrc } from '../src/server/pfs.ts';

/** Minimal PFS writer mirroring the reader's expectations: header, deflate block chains, filename list, directory. */
function buildPfs(files: Record<string, Buffer>): Buffer {
  const encodeFile = (data: Buffer): Buffer => {
    const parts: Buffer[] = [];
    for (let i = 0; i < data.length; i += 8192) {
      const chunk = data.subarray(i, i + 8192);
      const def = deflateSync(chunk);
      const h = Buffer.alloc(8);
      h.writeUInt32LE(def.length, 0);
      h.writeUInt32LE(chunk.length, 4);
      parts.push(h, def);
    }
    return Buffer.concat(parts);
  };
  const blocks: Buffer[] = [];
  const entries: { crc: number; offset: number; size: number }[] = [];
  let offset = 12;
  for (const [name, data] of Object.entries(files)) {
    const enc = encodeFile(data);
    entries.push({ crc: pfsCrc(name), offset, size: data.length });
    blocks.push(enc);
    offset += enc.length;
  }
  const names = Object.keys(files);
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(names.length, 0);
  for (const n of names) {
    const b = Buffer.from(`${n}\0`, 'latin1');
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length, 0);
    parts.push(l, b);
  }
  const nameList = Buffer.concat(parts);
  const encNames = encodeFile(nameList);
  entries.push({ crc: 0x61580ac9 | 0, offset, size: nameList.length });
  blocks.push(encNames);
  offset += encNames.length;
  const dir = Buffer.alloc(4 + entries.length * 12);
  dir.writeUInt32LE(entries.length, 0);
  entries.forEach((e, i) => {
    dir.writeInt32LE(e.crc, 4 + i * 12);
    dir.writeUInt32LE(e.offset, 8 + i * 12);
    dir.writeUInt32LE(e.size, 12 + i * 12);
  });
  const header = Buffer.alloc(12);
  header.writeUInt32LE(offset, 0);
  header.write('PFS ', 4, 'latin1');
  header.writeUInt32LE(0x20000, 8);
  return Buffer.concat([header, ...blocks, dir]);
}

test('reads files back out of a PFS archive, including multi-block ones', () => {
  const big = Buffer.alloc(20000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const archive = PfsArchive.fromBuffer(buildPfs({ 'Arena.WLD': big, 'readme.txt': Buffer.from('hello pfs') }), 'test.s3d');
  assert.deepEqual(archive.names().sort(), ['arena.wld', 'readme.txt']);
  assert.equal(archive.has('ARENA.wld'), true);
  assert.equal(archive.has('missing.txt'), false);
  assert.ok(archive.get('arena.wld')!.equals(big));
  assert.equal(archive.get('readme.txt')!.toString('latin1'), 'hello pfs');
  assert.equal(archive.getHead('readme.txt', 5)!.toString('latin1'), 'hello');
  assert.deepEqual(archive.namesWithExt('.wld'), ['arena.wld']);
  assert.equal(archive.get('nope'), undefined);
});

test('rejects data that is not a PFS archive', () => {
  assert.throws(() => PfsArchive.fromBuffer(Buffer.from('definitely not an archive'), 'bad.s3d'), /Not a PFS archive/);
});

test('pfsCrc is stable and case-sensitive like the game', () => {
  assert.equal(pfsCrc('arena.wld'), pfsCrc('arena.wld'));
  assert.notEqual(pfsCrc('arena.wld'), pfsCrc('Arena.wld'));
});
