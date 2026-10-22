// Which expansion a zone belongs to, for grouping the zone list. Covers the zones of the first expansions
// by short name; anything not listed is shown under "Later expansions". Grouping only affects the list.
const GROUPS: [string, string[]][] = [
  [
    'Original EverQuest',
    `airplane akanon arena befallen beholder blackburrow butcher cauldron cazicthule commons crushbone eastkarana
     ecommons erudnext erudnint erudsxing everfrost fearplane feerrott felwithea felwitheb freporte freportn freportw
     gfaydark grobb gukbottom guktop halas hateplane highkeep highpass hole innothule kaladima kaladimb kedge
     kerraridge kithicor lakerathe lavastorm lfaydark mistmoore misty najena nektulos neriaka neriakb neriakc
     northkarana nro oasis oggok oot paineel paw permafrost qcat qey2hh1 qeynos qeynos2 qeytoqrg qrg rathemtn
     rivervale runnyeye soldunga soldungb soltemple southkarana sro steamfont stonebrunt tox tutorial unrest warrens
     jaggedpine nedaria`.split(/\s+/),
  ],
  [
    'Ruins of Kunark',
    `burningwood cabeast cabwest charasis chardok citymist dalnir dreadlands droga emeraldjungle fieldofbone firiona
     frontiermtns kaesora karnor kurn lakeofillomen nurga overthere sebilis skyfire swampofnohope timorous trakanon
     veeshan warslikswood`.split(/\s+/),
  ],
  [
    'Scars of Velious',
    `cobaltscar crystal eastwastes frozenshadow greatdivide growthplane iceclad kael mischiefplane necropolis sirens
     skyshrine sleeper templeveeshan thurgadina thurgadinb velketor wakening westwastes`.split(/\s+/),
  ],
  [
    'Shadows of Luclin',
    `acrylia akheva bazaar dawnshroud echo fungusgrove griegsend grimling hollowshade katta letalis maiden mseru
     netherbian nexus paludal scarlet shadeweaver shadowhaven sharvahl sseru ssratemple tenebrous thedeep thegrey
     twilight umbral vexthal`.split(/\s+/),
  ],
  [
    'Planes of Power',
    `bothunder codecay hohonora hohonorb nightmareb poair podisease poeartha poearthb pofire poinnovation pojustice
     poknowledge ponightmare postorms potactics potimea potimeb potorment potranquility povalor powar powater
     solrotower`.split(/\s+/),
  ],
  ['Legacy of Ykesha', `gunthak dulak torgiran nadox hatesfury`.split(/\s+/)],
  [
    'Gates of Discord',
    `abysmal natimbi qinimi riwwi barindu ferubi snpool snlair sncrematory tipt vxed yxtta uqua kodtaz ikkinz qvic
     inktuta txevu tacvi`.split(/\s+/),
  ],
  [
    'Omens of War',
    `wallofslaughter bloodfields draniksscar causeway chambersa chambersb chambersc chambersd chamberse chambersf
     provinggrounds anguish dranik riftseekers harbingers`.split(/\s+/),
  ],
  ['Dragons of Norrath', `nest broodlands stillmoona stillmoonb thundercrest delvea delveb thenest guildlobby guildhall`.split(/\s+/)],
  ['Depths of Darkhollow', `corathus corathusb illsalin ruins dreadspire thalassius`.split(/\s+/)],
  [
    'Prophecy of Ro',
    `arcstone relic skylance devastation sverag theater freeporteast freeportwest freeportacademy freeportarena
     freeportcityhall freeporthall freeportmilitia freeportsewers freeporttheater elddar`.split(/\s+/),
  ],
  [
    'The Serpent’s Spine',
    `blightfire stonehive mesa roost steppes icefall valdeholm frostcrypt sunderock vergalid direwind ashengate
     hillsofshade`.split(/\s+/),
  ],
];

const LOOKUP = new Map<string, string>();
for (const [name, zones] of GROUPS) for (const z of zones) if (z) LOOKUP.set(z, name);

export const EXPANSION_ORDER: string[] = [...GROUPS.map((g) => g[0]), 'Later expansions'];

export function expansionOf(zone: string): string {
  const z = zone.toLowerCase();
  const hit = LOOKUP.get(z);
  if (hit) return hit;
  if (/^clz/.test(z)) return 'The Serpent’s Spine';
  if (/^(phinterior|plh|guildhall)/.test(z)) return 'Player housing & guild halls';
  return 'Later expansions';
}
