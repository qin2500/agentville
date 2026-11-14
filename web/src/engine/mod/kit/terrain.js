// Terrain kit for mods (re-exported by mod/public.js): checkClasses(classes) -> lint[], classByName(table, name).
// A mod's terrain classes (api.js TerrainClass) are the terrain-layer codes 0..15 its layout writes.
const CLASS_CODE_MAX = 15;

/** Lint a `terrain.classes` list. Returns strings (empty = fine): not an array, bad entry, bad or duplicate code or
 *  name, code over 15, a missing class 0, a non-boolean flag, a colour that is not a string.
 *  @param {any} classes @returns {string[]} */
export function checkClasses(classes) {
  const lint = [];
  if (!Array.isArray(classes)) return ['terrain.classes must be an array'];
  const codes = new Set(), names = new Set();
  classes.forEach((c, i) => {
    if (!c || typeof c !== 'object') { lint.push(`terrain.classes[${i}] must be an object`); return; }
    const where = `terrain.classes[${i}]${typeof c.name === 'string' ? ` (${c.name})` : ''}`;
    if (!Number.isInteger(c.code) || c.code < 0) lint.push(`${where}: code must be a non-negative integer`);
    else if (c.code > CLASS_CODE_MAX) lint.push(`${where}: code ${c.code} is over ${CLASS_CODE_MAX}`);
    else if (codes.has(c.code)) lint.push(`${where}: duplicate code ${c.code}`);
    else codes.add(c.code);
    if (typeof c.name !== 'string' || !c.name) lint.push(`${where}: name must be a non-empty string`);
    else if (names.has(c.name)) lint.push(`${where}: duplicate name ${c.name}`);
    else names.add(c.name);
    for (const f of ['water', 'wild', 'grows']) if (c[f] !== undefined && typeof c[f] !== 'boolean') lint.push(`${where}: ${f} must be a boolean`);
    if (c.color !== undefined && typeof c.color !== 'string') lint.push(`${where}: color must be a string`);
  });
  if (!codes.has(0)) lint.push('terrain.classes: class 0 is required (it is also "outside the grid")');
  return lint;
}

/** The class named `name` in `table.classes`, or undefined.
 *  @param {{ classes?: any[] } | null | undefined} table @param {string} name */
export function classByName(table, name) {
  return table?.classes?.find(c => c.name === name);
}
