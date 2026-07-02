# Dawnline

A deterministic, agent-based civilization sandbox where autonomous people turn a
generated wilderness into history. Each person has needs, personality, skills,
memory and relationships; together they gather food, migrate, form families,
found settlements, grow cultures, discover technology, open trade routes, wage
war, survive disease and disasters, and sometimes collapse.

Live demo: https://catpockets.github.io/Dawnline/

## Run it

**Fastest:** open `dist/index.html` in any modern browser. It's a fully
self-contained single-file build — no server, no install, runs from disk.

**Rebuild the single file (no dependencies needed, just Node):**
```
npm run build:standalone   # or: node scripts/build-standalone.mjs
npm run test:engine        # headless engine + determinism + stress test
```
The standalone build vendors preact/compat (API-compatible with React 18,
`vendor/`) as the runtime, so it needs zero installs. The app source itself is
standard React written with `React.createElement` (JSX-free, so no transform
step is required).

**Full Vite + real React toolchain (needs network for npm):**
```
npm install
npm run dev          # Vite dev server on real React 18
npm run build        # Vite single-file production build
```

## Deploy it

Pushes to `main` deploy Dawnline to GitHub Pages with the workflow in
`.github/workflows/pages.yml`. The workflow runs the engine test, builds the
dependency-free standalone app, and publishes `dist/`.

Published site: https://catpockets.github.io/Dawnline/

In GitHub, set **Settings → Pages → Build and deployment → Source** to
**GitHub Actions**.

## How it works

| Layer | File | What it does |
|---|---|---|
| RNG / utils | `src/engine/rng.js` | Seeded mulberry32 streams, value noise, fBm, names |
| World gen | `src/engine/world.js` | Terrain, resources, fertility, temp, disease risk, danger, carrying capacity (typed arrays) |
| Agents | `src/engine/agents.js` | Utility-AI decisions + FSM states, combat, relationships, memory, reinforcement-style strategy weights |
| Settlements | `src/engine/settlements.js` | Culture drift, tech discoveries, buildings, births, stability, rule-based archetype classification |
| Orchestrator | `src/engine/simulation.js` | Tick pipeline: climate → regen → spatial grid → agents → settlements → trade/diplomacy/war → disease → disasters → analytics |
| Renderer | `src/render/renderer.js` | Canvas: pre-rendered terrain, heat-map overlays, routes, trails, agents, flashes; zoom/pan |
| UI | `src/App.js`, `src/ui/*` | React panels only — controls, analytics, charts, inspector, event log |

Key architecture rule: **React never holds per-agent state.** The engine lives in
a ref, the canvas repaints every frame via requestAnimationFrame, and React
panels read a compact snapshot 4×/sec.

## Using the sandbox

- **Drag** to pan, **wheel** to zoom, **click** any agent or settlement to inspect it.
- Left panel: world genesis (seed, size, population — applied on ⟲ restart),
  live dynamics sliders (aggression, climate, disease, tech, trade, disasters),
  god tools (droughts, plagues, quakes, resource booms, migration pressure),
  and 12 map overlays.
- Right panel: analytics, 8 time-series charts, and the event chronicle.
- **Stress mode** restarts with 2,200+ agents to probe performance; watch the
  fps/tps counter in the top bar.

Same seed ⇒ same world and same history (deterministic).
