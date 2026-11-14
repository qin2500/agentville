// Style pool: a small, curated, data-driven source of per-project looks (architecture, streets, folk).
// Pure: no DOM, no imports. Every component is picked by its own FNV-1a hash stream of the project key,
// from short per-family lists chosen so that any combination stays harmonious (pastoral fantasy Europe).

export const FAMILIES = ['timber', 'mediterranean', 'stone', 'alpine', 'canal', 'thatch'];

// ---- curated lists, per family (index = family id) ----
// roofs: [base, ridge]   walls: [base, alt]   trims: [trim, shutter, door]
// pavings: [kind, base, joint]   trees: species order   folk: 3 sets of 4 [shirt, trousers, accent]
const POOL = [
  { // 0 timber: today's look first, then close cousins
    roofs: [['#a8543a', '#7d3b2a'], ['#8f4a38', '#6a3328'], ['#6f5a4c', '#4e3e34'], ['#9a6a40', '#6e4a2c']],
    walls: [['#ecdfc2', '#cf9d61'], ['#e2c987', '#d3a08a'], ['#9bb08d', '#e6d9bc'], ['#9fb0b8', '#eadfc8']],
    trims: [['#f3e7cd', '#4f7d4a', '#7a4a2a'], ['#6a4630', '#3f6f8f', '#3f6f8f'], ['#f6efdf', '#a8443c', '#6b4a8a']],
    windows: ['square', 'small'],
    pavings: [['cobble', '#8d8379', '#5f564d'], ['cobble', '#9a8f84', '#63594f'], ['flagstone', '#d2c7b2', '#9d927e']],
    lamps: ['lantern', 'post'],
    trees: [['round', 'big', 'pink'], ['big', 'round', 'pine'], ['round', 'birch', 'big']],
    folk: [
      [['#b75a42', '#5a4636', '#e9cc84'], ['#4f7d4a', '#6a5a46', '#f3e7cd'], ['#3f6f8f', '#4a4038', '#e9cc84'], ['#d9a08e', '#6b4a3a', '#fbf6ea']],
      [['#8a3f3f', '#4d4a5e', '#f3e7cd'], ['#c9a06a', '#5a4636', '#4f7d4a'], ['#6b4a8a', '#4a4038', '#e9cc84'], ['#e9cc84', '#6a5a46', '#b75a42']],
      [['#557a48', '#5a4636', '#f6efdf'], ['#a8443c', '#4a4038', '#f3e7cd'], ['#8eabc2', '#6b4a3a', '#cf9d61'], ['#d1a447', '#4d4a5e', '#8a3f3f']],
    ],
    hats: ['none', 'cap', 'hood'],
    accents: ['#c7623e', '#3f6f8f', '#8a3f3f', '#d1a447'],
  },
  { // 1 mediterranean
    roofs: [['#a8532f', '#7a3a22'], ['#9c5636', '#723f28'], ['#b4623a', '#85482b'], ['#8f4a30', '#683324']],
    walls: [['#efe6d2', '#c9b896'], ['#e6d9bb', '#cfae78'], ['#e3c895', '#efe6d2'], ['#eadac0', '#d4a995']],
    trims: [['#efe6d2', '#4a6f91', '#4a6f91'], ['#efe6d2', '#4f6f5c', '#4f6f5c'], ['#e6d9bb', '#4a6f91', '#7a5236'], ['#efe6d2', '#4f6f5c', '#4a6f91']],
    windows: ['arched', 'tall', 'square'],
    pavings: [['flagstone', '#d6c9ae', '#ab9e84'], ['cobble', '#cdbfa6', '#9f917a'], ['flagstone', '#d3c19c', '#a09070']],
    lamps: ['lantern', 'post', 'lantern', 'iron'],
    trees: [['cypress', 'round', 'pink'], ['cypress', 'cypress', 'round'], ['cypress', 'pine', 'round']],
    folk: [
      [['#f6efdf', '#7a5a3a', '#c4603a'], ['#3f6f9f', '#e6d7b8', '#e9b949'], ['#d9a08e', '#5a4636', '#f6efdf'], ['#e9cc84', '#4d4a5e', '#46705f']],
      [['#c4603a', '#e6d7b8', '#f6efdf'], ['#46705f', '#5a4636', '#e9cc84'], ['#f6efdf', '#3f6f9f', '#c4603a'], ['#b9a6cc', '#7a5a3a', '#f6efdf']],
      [['#e9b949', '#5a4636', '#3f6f9f'], ['#f6efdf', '#4d4a5e', '#d9a08e'], ['#8eabc2', '#e6d7b8', '#c4603a'], ['#a8443c', '#7a5a3a', '#f6efdf']],
    ],
    hats: ['straw', 'none', 'kerchief'],
    accents: ['#3f6f9f', '#46705f', '#c4603a', '#e9b949'],
  },
  { // 2 stone
    roofs: [['#5f5b62', '#443f48'], ['#585660', '#3d3b45'], ['#6a6258', '#4a4238'], ['#5c5560', '#403a44']],
    walls: [['#a89d88', '#8c8170'], ['#b3a283', '#968563'], ['#9d9588', '#827a6e'], ['#b0a58f', '#948a78']],
    trims: [['#d8d0c0', '#3d5f78', '#5a3a26'], ['#cfc8b8', '#4f6f5a', '#4a3a30'], ['#e0d9c8', '#7a3b2a', '#3d5f78']],
    windows: ['small', 'square', 'tall'],
    pavings: [['cobble', '#8d8379', '#5f564d'], ['cobble', '#837c78', '#575059'], ['flagstone', '#9a9690', '#6c6862']],
    lamps: ['lantern', 'post'],
    trees: [['pine', 'round', 'birch'], ['pine', 'big', 'round'], ['birch', 'pine', 'round']],
    folk: [
      [['#4d6a8a', '#4a4038', '#cfc8b8'], ['#6b5a7a', '#3d3842', '#d8d0c0'], ['#5a7a5a', '#4a4038', '#e9cc84'], ['#8a4a42', '#3f444e', '#d8d0c0']],
      [['#3d5f78', '#5a4636', '#e0d9c8'], ['#7a6a5a', '#3d3842', '#d1a447'], ['#556b5a', '#4a4038', '#cfc8b8'], ['#9aa0a8', '#4d5360', '#7a3b2a']],
      [['#6a4a5a', '#4a4038', '#e0d9c8'], ['#4f6f5a', '#3d3842', '#d8d0c0'], ['#8f9aa6', '#5a4636', '#a8443c'], ['#a8803c', '#3f444e', '#e0d9c8']],
    ],
    hats: ['hood', 'cap', 'none'],
    accents: ['#3d5f78', '#7a3b2a', '#4f6f5a', '#8a6fb0'],
  },
  { // 3 alpine
    roofs: [['#6a4a38', '#4a3226'], ['#7a5a40', '#563c2a'], ['#5c4a40', '#3f322a'], ['#80623f', '#5c4430']],
    walls: [['#eadfca', '#5a3a26'], ['#e6d8b8', '#4d3322'], ['#ede3cf', '#6b4429'], ['#ddd0b0', '#583423']],
    trims: [['#a8443c', '#a8443c', '#5a3a26'], ['#c2503e', '#46705f', '#4d3322'], ['#a8443c', '#3f6f8f', '#6b4429']],
    windows: ['square', 'small'],
    pavings: [['earth', '#a68a62', '#7f6745'], ['flagstone', '#bdb5a2', '#8a8272'], ['earth', '#9c8458', '#7a6440']],
    lamps: ['post', 'lantern', 'lantern'],
    trees: [['pine', 'birch', 'round'], ['pine', 'pine', 'birch'], ['birch', 'pine', 'big']],
    folk: [
      [['#a8443c', '#4d3322', '#f6efdf'], ['#46705f', '#5a4636', '#e9cc84'], ['#f6efdf', '#4d3322', '#a8443c'], ['#3f6f8f', '#5a4636', '#f3e7cd']],
      [['#c2503e', '#583423', '#f6efdf'], ['#557a48', '#4d3322', '#e9cc84'], ['#e9cc84', '#5a4636', '#a8443c'], ['#6b4a8a', '#4d3322', '#f6efdf']],
      [['#8a3f3f', '#4a3226', '#f3e7cd'], ['#3d5f78', '#583423', '#e9cc84'], ['#d9a08e', '#4d3322', '#46705f'], ['#f3eadb', '#5a4636', '#c2503e']],
    ],
    hats: ['feather', 'cap', 'none'],
    accents: ['#a8443c', '#46705f', '#3f6f8f', '#d1a447'],
  },
  { // 4 canal
    roofs: [['#4e4f58', '#34353e'], ['#5a4a46', '#3c302c'], ['#464b56', '#2f333c'], ['#6a4a3c', '#4a3028']],
    walls: [['#a0583f', '#7f4634'], ['#93503a', '#b0694d'], ['#8a5c45', '#a0583f'], ['#a8664a', '#82503a']],
    trims: [['#e6dcc4', '#3a2e28', '#3a2e28'], ['#dcd2ba', '#2f4a4a', '#3a2e28'], ['#e6dcc4', '#3a2e28', '#2f4a4a']],
    windows: ['tall', 'square'],
    pavings: [['brick', '#a97455', '#6f5444'], ['brick', '#9c6448', '#665040'], ['brick', '#b58262', '#7a5c48']],
    lamps: ['lantern', 'post', 'lantern'],
    trees: [['birch', 'round', 'big'], ['round', 'birch', 'pine'], ['big', 'birch', 'round']],
    folk: [
      [['#26405a', '#4a4038', '#f6efdf'], ['#8a3f3f', '#3d2f2a', '#e9cc84'], ['#f3e7cd', '#26405a', '#a8553f'], ['#2f5f56', '#4a4038', '#f6efdf']],
      [['#3f6f8f', '#4a3a30', '#f6efdf'], ['#a8553f', '#3d2f2a', '#f3e7cd'], ['#e9cc84', '#26405a', '#2f5f56'], ['#5a4a6a', '#4a4038', '#f6efdf']],
      [['#2f5f56', '#3d2f2a', '#e9cc84'], ['#c9a06a', '#26405a', '#8a3f3f'], ['#f6efdf', '#4a3a30', '#3f6f8f'], ['#8a3f3f', '#4a4038', '#f3e7cd']],
    ],
    hats: ['cap', 'none', 'kerchief'],
    accents: ['#2f5f56', '#26405a', '#c7623e', '#d1a447'],
  },
  { // 5 thatch
    roofs: [['#c9a64a', '#9a7a30'], ['#b8965a', '#8a6a3c'], ['#d2b45c', '#a58a3c'], ['#a8884c', '#7a6030']],
    walls: [['#e6d8b8', '#d0ba8e'], ['#e0c382', '#e6d8b8'], ['#d9c8a0', '#c29a68'], ['#eadabc', '#d2b284']],
    trims: [['#6a4630', '#4f7d4a', '#7a4a2a'], ['#7a5a3a', '#8a5a7a', '#6a4630'], ['#6a4630', '#3f6f8f', '#8a3f3f']],
    windows: ['small', 'square'],
    pavings: [['earth', '#a68a62', '#7f6745'], ['earth', '#b39a6c', '#8b7249'], ['cobble', '#9a8f84', '#6a5f54']],
    lamps: ['lantern', 'post'],
    trees: [['round', 'pink', 'big'], ['pink', 'round', 'birch'], ['round', 'big', 'pink']],
    folk: [
      [['#e9cc84', '#6a5a46', '#b75a42'], ['#d9a08e', '#5a4636', '#f6efdf'], ['#93b088', '#6b4a3a', '#f3e7cd'], ['#f3e7cd', '#7a5a3a', '#4f7d4a']],
      [['#c9a06a', '#5a4636', '#a8443c'], ['#b9a6cc', '#6a5a46', '#f6efdf'], ['#8eabc2', '#6b4a3a', '#e9cc84'], ['#ecdfc2', '#7a5a3a', '#8a5a7a']],
      [['#a8443c', '#6a5a46', '#f3e7cd'], ['#a9cdb3', '#5a4636', '#d9a08e'], ['#e9cc84', '#6b4a3a', '#3f6f8f'], ['#d9a08e', '#7a5a3a', '#f6efdf']],
    ],
    hats: ['kerchief', 'straw', 'none'],
    accents: ['#a8443c', '#8a5a7a', '#4f7d4a', '#d1a447'],
  },
];

// ---- hashing: FNV-1a (32-bit) with a final avalanche, one independent stream per component ----
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function stream(key, salt) {
  let h = fnv1a(salt + '\u0000' + key);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}

function build(family, ix, key) {
  const P = POOL[family];
  const [r, w, t, p, l, v, g, k, h, a] = ix;
  const roof = P.roofs[r], wall = P.walls[w], trim = P.trims[t], pave = P.pavings[p];
  return deepFreeze({
    key,
    family, familyName: FAMILIES[family],
    roof: { base: roof[0], ridge: roof[1] },
    wall: { base: wall[0], alt: wall[1] },
    trim: trim[0], shutter: trim[1], door: trim[2],
    window: P.windows[v],
    paving: { kind: pave[0], base: pave[1], joint: pave[2] },
    lamp: P.lamps[l],
    trees: P.trees[g].slice(),
    folk: { palettes: P.folk[k].map(x => x.slice()), hat: P.hats[h] },
    accent: P.accents[a],
  });
}

export function styleFor(projectKey, opts = {}) {
  const name = String(projectKey == null ? '' : projectKey);
  let family = opts && opts.family;
  if (!Number.isInteger(family) || family < 0 || family >= FAMILIES.length) family = stream(name, 'family') % FAMILIES.length;
  const P = POOL[family];
  const ix = [
    stream(name, 'roof') % P.roofs.length,
    stream(name, 'wall') % P.walls.length,
    stream(name, 'trim') % P.trims.length,
    stream(name, 'paving') % P.pavings.length,
    stream(name, 'lamp') % P.lamps.length,
    stream(name, 'window') % P.windows.length,
    stream(name, 'trees') % P.trees.length,
    stream(name, 'folk') % P.folk.length,
    stream(name, 'hat') % P.hats.length,
    stream(name, 'accent') % P.accents.length,
  ];
  const key = `f${family}.r${ix[0]}.w${ix[1]}.t${ix[2]}.p${ix[3]}.l${ix[4]}.v${ix[5]}.g${ix[6]}.k${ix[7]}.h${ix[8]}.a${ix[9]}`;
  return build(family, ix, key);
}

// Today's timber look: index 0 of every timber list (roof/wall/trim/paving match iso.js and ground-art.js).
export const STYLE_DEFAULT = build(0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'f0.default');
