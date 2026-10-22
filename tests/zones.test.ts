import { test } from 'node:test';
import assert from 'node:assert/strict';
import { longNameFor } from '../src/server/zones.ts';
import { EXPANSION_ORDER, expansionOf } from '../src/client/expansions.ts';
import { compareVersions } from '../src/client/housekeeping.ts';

test('longNameFor knows classic zones and housing patterns', () => {
  assert.equal(longNameFor('gfaydark'), 'Greater Faydark');
  assert.equal(longNameFor('GFAYDARK'), 'Greater Faydark');
  assert.match(longNameFor('phinterior1a2'), /^Player Housing/);
  assert.equal(longNameFor('somenewzone'), 'somenewzone');
});

test('expansionOf groups zones and falls back cleanly', () => {
  assert.equal(expansionOf('gfaydark'), 'Original EverQuest');
  assert.equal(expansionOf('sebilis'), 'Ruins of Kunark');
  assert.equal(expansionOf('poknowledge'), 'Planes of Power');
  assert.equal(expansionOf('definitely-not-a-zone'), 'Later expansions');
  assert.equal(EXPANSION_ORDER[0], 'Original EverQuest');
  assert.equal(EXPANSION_ORDER[EXPANSION_ORDER.length - 1], 'Later expansions');
});

test('compareVersions orders dotted versions', () => {
  assert.ok(compareVersions('v0.2.0', '0.1.0') > 0);
  assert.ok(compareVersions('0.1.0', 'v0.1.0') === 0);
  assert.ok(compareVersions('0.1.9', '0.2') < 0);
  assert.ok(compareVersions('1.0', '0.99.99') > 0);
});
