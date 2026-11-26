// Pure helpers for images pasted or dropped onto the terminal (term.js does the DOM work).
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The image files in a DataTransfer (paste or drop), in order. Text-only pastes give []. */
export function imageFiles(dt) {
  const out = [];
  for (const f of Array.from(dt?.files || [])) if (IMAGE_TYPES.includes(f.type)) out.push(f);
  if (!out.length) {
    for (const it of Array.from(dt?.items || [])) {
      if (it.kind === 'file' && IMAGE_TYPES.includes(it.type)) { const f = it.getAsFile?.(); if (f) out.push(f); }
    }
  }
  return out;
}

/** A drag that carries files (the types list says so before the drop gives the files). */
export const hasFiles = dt => Array.from(dt?.types || []).includes('Files');

/** The text to type for saved paths: each quoted if it has whitespace, then a trailing space. */
export function pathsToInput(paths) {
  return paths.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + ' ';
}

/** Alt+V (no Ctrl/Meta) is Claude Code's image paste on Windows and Linux: it wants ESC v. */
export const isAltV = e => e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyV' || String(e.key).toLowerCase() === 'v');
