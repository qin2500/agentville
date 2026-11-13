# Your world

This folder is yours. Everything under `mods/<id>/` belongs to you; the engine under `web/src/engine/**` is shared.

- `index.js` is the whole mod: an id, a name, optional data (`rules`, `terrain`, `objects`, ...) and hooks.
- Import engine helpers only from `#agentville/mod`. Never import engine internals or another mod.
- Every hook starts as a call to the mod you extend, so the template runs as is.

```
node tools/mod.mjs check <id>     # validators, boundary check, determinism on the fixtures
node tools/mod.mjs shots <id>     # headless screenshots into out/mod-shots/<id>/
```

Open it in the app with `?engine=2&world=<id>`. Full guide: `docs/make-your-own-world.md`.
