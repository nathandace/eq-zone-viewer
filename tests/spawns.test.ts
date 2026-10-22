import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { displayName, importSpawns, parseValues } from '../src/server/spawns.ts';

test('parseValues handles strings, escapes, NULL and numbers', () => {
  const rows = parseValues("(1,'Guard_Kemper','O\\'Brien',NULL,-12.5),(2,'it''s',\"\",0,3)");
  assert.deepEqual(rows[0], [1, 'Guard_Kemper', "O'Brien", null, -12.5]);
  assert.equal(rows[1][1], "it's");
  assert.equal(rows[1].length, 5);
});

test('importSpawns joins spawn points, groups and NPC types per zone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqzv-spawns-'));
  try {
    const dump = [
      'CREATE TABLE `npc_types` (',
      '  `id` int(11) NOT NULL,',
      '  `name` text NOT NULL,',
      '  `lastname` varchar(32),',
      '  `level` tinyint(2),',
      '  `race` smallint(5),',
      '  `class` tinyint(2),',
      '  `bodytype` int(11),',
      '  `hp` int(11),',
      '  `mana` int(11),',
      '  `gender` tinyint(2),',
      '  `texture` tinyint(2),',
      '  `helmtexture` tinyint(2),',
      '  `herosforgemodel` int(11),',
      '  `size` float,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB;',
      "INSERT INTO `npc_types` VALUES (1001,'an_orc_pawn','',4,54,1,0,30,0,0,0,0,0,6),(1002,'Guard_Kemper','',40,1,1,0,2000,0,0,1,1,0,6);",
      'CREATE TABLE `spawn2` (',
      '  `id` int(11) NOT NULL,',
      '  `spawngroupID` int(11),',
      '  `zone` varchar(32),',
      '  `version` smallint(5),',
      '  `x` float,',
      '  `y` float,',
      '  `z` float,',
      '  `heading` float,',
      '  `respawntime` int(11),',
      ') ENGINE=InnoDB;',
      "INSERT INTO `spawn2` VALUES (1,10,'gfaydark',0,-100.5,2500.25,3,128,360),(2,11,'gfaydark',0,10,20,30,0,600),(3,10,'crushbone',1,1,2,3,0,100),(4,99,'nowhere',0,0,0,0,0,0);",
      'INSERT INTO `spawnentry` (`spawngroupID`, `npcID`, `chance`) VALUES (10,1001,70),(10,1002,30),(11,1002,100);',
    ].join('\n');
    const path = join(dir, 'dump.sql');
    writeFileSync(path, dump);
    const zones = await importSpawns(path);
    assert.deepEqual([...zones.keys()].sort(), ['crushbone', 'gfaydark']);
    const g = zones.get('gfaydark')!;
    assert.equal(g.spawns.length, 2);
    assert.equal(g.spawns[0].x, -100.5);
    assert.equal(g.spawns[0].h, 128);
    assert.deepEqual(g.spawns[0].npcs.map((n) => [n.name, n.chance, n.race, n.level]), [['an_orc_pawn', 70, 54, 4], ['Guard_Kemper', 30, 1, 40]]);
    assert.equal(g.spawns[1].npcs[0].gender, 0);
    assert.equal(g.spawns[1].npcs[0].size, 6);
    assert.equal(zones.get('crushbone')!.spawns[0].version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('displayName cleans emulator names', () => {
  assert.equal(displayName('an_orc_pawn'), 'an orc pawn');
  assert.equal(displayName('Guard_Kemper'), 'Guard Kemper');
  assert.equal(displayName('a_bat00'), 'a bat');
  assert.equal(displayName('#Lord_Nagafen'), 'Lord Nagafen');
});
