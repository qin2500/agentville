// Fantasy mod: what a PR is (api.js PrSpec, mod.represent.pr keyed by PR state). Plain data, no functions.
// Split from represent.js so the PR representation and the behaviour table have separate owners.
// A live PR is a building site on a lot (the lots hook asks for it); a loading or merged PR is a sloop at the harbour
// (venues.js). A closed PR is not shown (the engine default for a state the table leaves out).

export const REPRESENT = {
  pr: {
    building: { as: 'lot' },
    loading: { as: 'venue', venue: 'harbour', model: 'sloop' },
    merged: { as: 'venue', venue: 'harbour', model: 'sloop' },
  },
};
