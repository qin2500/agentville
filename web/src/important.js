// Important agents ("Mark important" in the agent menu): never hidden or folded away automatically.
// Resting buckets, "+N resting" lines, folded teams, quiet projects and the village's resting-home
// cap all leave them out; only the user's own hide (`hidden`) or their own search and filters can.
// Pure, so node tests and the village layout can import it.

/** Important and not hidden by the user: shown wherever the app would otherwise fold it away. */
export const pinned = a => !!a && a.important === true && !a.hidden;

/** Resting and not pinned: what the default folds (resting sections, "+N resting", indoors) take. */
export const folds = a => a.bucket === 'resting' && !pinned(a);

/** A pinned agent that isn't running says so plainly: "Stopped · Closed". '' otherwise. */
export function stoppedNote(a) {
  if (!pinned(a) || a.live) return '';
  const why = a.reason && !/^stopped$/i.test(a.reason) ? a.reason : '';
  return why ? `Stopped · ${why}` : 'Stopped';
}
