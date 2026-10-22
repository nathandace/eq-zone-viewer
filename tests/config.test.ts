import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeEqDir } from '../src/server/config.ts';

test('looksLikeEqDir needs a folder with zone archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqzv-cfg-'));
  try {
    assert.equal(looksLikeEqDir(undefined), false);
    assert.equal(looksLikeEqDir(join(dir, 'missing')), false);
    assert.equal(looksLikeEqDir(dir), false);
    writeFileSync(join(dir, 'eqgame.exe'), '');
    assert.equal(looksLikeEqDir(dir), false);
    writeFileSync(join(dir, 'arena.S3D'), '');
    assert.equal(looksLikeEqDir(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
