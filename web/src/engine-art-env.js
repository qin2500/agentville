// Side-effect shim, imported before the classic art so its module-level browser probes survive a node test run.
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
