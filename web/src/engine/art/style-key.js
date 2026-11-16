// Engine art: styleKeyFor(style, reads) -> string. A hash of only the style fields a model reads (design §5.4), so a
// sprite is rebuilt only when something it draws changes. Generic: field names come from the model's `reads` list
// (dotted paths allowed, e.g. 'roof.base'); nothing here knows what a field means.

const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

function canon(v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

const get = (o, path) => { let c = o; for (const k of String(path).split('.')) { if (c == null) return undefined; c = c[k]; } return c; };

/** Stable (independent of key order and of fields not in `reads`), order of `reads` irrelevant. '' for no style. */
export function styleKeyFor(style, reads) {
  if (!style || typeof style !== 'object') return '';
  const names = [...new Set(Array.isArray(reads) ? reads.map(String) : [])].sort();
  if (!names.length) return '';
  return fnv(names.map(n => `${n}=${canon(get(style, n))}`).join('|')).toString(36);
}
