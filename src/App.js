import React from 'react';
import { Simulation, DEFAULT_PARAMS } from './engine/simulation.js';
import { TICKS_PER_YEAR } from './engine/agents.js';
import { dominantCulture } from './engine/settlements.js';
import { Renderer } from './render/renderer.js';
import Controls, { WORLD_SIZES } from './ui/Controls.js';
import Analytics from './ui/Analytics.js';
import Inspector from './ui/Inspector.js';

const { useEffect, useRef, useState, useCallback } = React;
const h = React.createElement;

// Simulation ticks per animation frame. Values below 1 tick every few frames
// (0.1× = one tick per ~10 frames) — agent motion stays smooth because the
// renderer interpolates positions between ticks.
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
const DEFAULT_SPEED_IDX = 3; // 1×

/**
 * App shell. The Simulation and Renderer live in refs — React NEVER holds
 * per-agent state. The UI reads a compact snapshot 4×/sec; the canvas is
 * repainted every animation frame by the renderer directly.
 */
export default function App() {
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  const rendererRef = useRef(null);
  const runningRef = useRef(true);
  const speedRef = useRef(1);

  const [running, setRunning] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(DEFAULT_SPEED_IDX);
  const [seed, setSeed] = useState(DEFAULT_PARAMS.seed);
  const [worldSize, setWorldSize] = useState(1);
  const [stressMode, setStressMode] = useState(false);
  const [params, setParams] = useState({ ...DEFAULT_PARAMS });
  const [overlay, setOverlayState] = useState('none');
  const [showRoutes, setShowRoutesState] = useState(true);
  const [showTrails, setShowTrailsState] = useState(true);
  const [, setSelection] = useState(null);
  const [ui, setUi] = useState({ stats: {}, events: [], history: emptyHistory(), fps: 0, tps: 0, inspector: null });

  runningRef.current = running;
  speedRef.current = SPEEDS[speedIdx];

  // ---- engine bootstrap + master loop (mounted once) ----------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;

    const sim = new Simulation({ ...DEFAULT_PARAMS });
    simRef.current = sim;

    const parent = canvas.parentElement;
    const doResize = () => {
      renderer.resize(parent.clientWidth, parent.clientHeight);
      if (renderer.sim) renderer.draw();
    };
    doResize();
    renderer.attach(sim);
    const ro = new ResizeObserver(doResize);
    ro.observe(parent);

    let raf;
    let frames = 0, ticks = 0, lastRate = performance.now(), lastSnap = 0;
    let fps = 0, tps = 0;
    let acc = 0; // fractional tick accumulator (enables sub-1× speeds)

    const loop = (now) => {
      const s = simRef.current;
      let alpha = 1;
      // batched ticks per frame, with a wall-clock budget so UI never freezes
      if (runningRef.current && s) {
        acc += speedRef.current;
        let n = Math.floor(acc);
        if (n > 0) {
          const budget = performance.now() + 14; // ms per frame for simulation
          let done = 0;
          while (done < n) {
            s.tickOnce();
            ticks++; done++;
            if (performance.now() > budget) break;
          }
          acc -= done;
          if (acc > 3) acc = 0; // can't keep up — drop the backlog, no spiral
        }
        // at sub-1× speeds, acc (0..1) is the progress toward the next tick:
        // use it to interpolate agent positions for butter-smooth motion
        if (speedRef.current < 1) alpha = Math.min(1, acc);
      }
      renderer.draw(alpha);
      frames++;

      if (now - lastRate >= 1000) {
        fps = frames; tps = ticks;
        frames = 0; ticks = 0; lastRate = now;
      }
      // snapshot for the React panels 4×/sec (keeps React work tiny)
      if (now - lastSnap >= 250 && s) {
        lastSnap = now;
        setUi({
          stats: s.stats,
          events: s.events.slice(),
          history: s.history,
          fps, tps,
          inspector: buildInspector(s, renderer.selected)
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // ---- restart: build a fresh world from the draft parameters -------------
  const restart = useCallback(() => {
    const size = WORLD_SIZES[worldSize];
    const startPop = stressMode ? Math.max(2200, params.startPop) : params.startPop;
    const sim = new Simulation({
      ...params, seed, startPop,
      worldW: size.w, worldH: size.h
    });
    simRef.current = sim;
    rendererRef.current.attach(sim);
    rendererRef.current.selected = null;
    setSelection(null);
  }, [params, seed, worldSize, stressMode]);

  // live parameter changes flow straight into the running engine
  const setParam = useCallback((key, value) => {
    setParams((p) => ({ ...p, [key]: value }));
    if (simRef.current) simRef.current.params[key] = value;
  }, []);

  const setOverlay = (o) => {
    setOverlayState(o);
    const r = rendererRef.current;
    if (r) { r.overlay = o; r.lastOverlayTick = -999; }
  };
  const setShowRoutes = (v) => { setShowRoutesState(v); if (rendererRef.current) rendererRef.current.showRoutes = v; };
  const setShowTrails = (v) => { setShowTrailsState(v); if (rendererRef.current) rendererRef.current.showTrails = v; };

  const godAction = (kind) => {
    const s = simRef.current;
    if (!s) return;
    if (kind === 'globalDrought') s.forceDrought();
    else if (kind === 'addResources') s.addResources();
    else if (kind === 'migration') s.triggerMigrationPressure();
    else s.spawnDisaster(kind);
  };

  // ---- canvas interaction: drag = pan, wheel = zoom, click = inspect ------
  useEffect(() => {
    const canvas = canvasRef.current;
    let dragging = false, moved = false, lx = 0, ly = 0;

    const down = (e) => { dragging = true; moved = false; lx = e.clientX; ly = e.clientY; };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      rendererRef.current.panBy(dx, dy);
      lx = e.clientX; ly = e.clientY;
    };
    const up = (e) => {
      if (dragging && !moved) {
        const rect = canvas.getBoundingClientRect();
        const hit = rendererRef.current.pickAt(e.clientX - rect.left, e.clientY - rect.top);
        rendererRef.current.selected = hit;
        setSelection(hit);
      }
      dragging = false;
    };
    const wheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      rendererRef.current.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 0.87);
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }, []);

  const clearSelection = () => { setSelection(null); if (rendererRef.current) rendererRef.current.selected = null; };
  const st = ui.stats || {};

  const legendRow = (bg, label, extra) => h('div', { className: 'row' },
    h('div', { className: 'sw', style: Object.assign({ background: bg }, extra || {}) }), label);

  return h('div', { className: 'app' },
    h('div', { className: 'topbar' },
      h('h1', null, '⬡ HUMAN CIVILIZATION EMERGENCE SIMULATOR'),
      h('button', { className: 'primary', onClick: () => setRunning(!running) }, running ? '❚❚ Pause' : '▶ Play'),
      h('div', { style: { display: 'flex', gap: 4 } },
        SPEEDS.map((s, i) => h('button', {
          key: s, className: 'tiny' + (speedIdx === i ? ' on' : ''),
          title: s < 1 ? 'Slow motion — great for watching individual agents' : undefined,
          onClick: () => setSpeedIdx(i)
        }, (s < 1 ? String(s).replace('0.', '.') : s) + '×'))
      ),
      h('button', { onClick: restart }, '⟲ Restart'),
      h('div', { className: 'spacer' }),
      h('span', { className: 'chip' }, 'Year ', h('b', null, st.year ?? 0)),
      h('span', { className: 'chip' }, 'Tick ', h('b', null, st.tick ?? 0)),
      h('span', { className: 'chip' }, 'Pop ', h('b', null, st.population ?? 0)),
      h('span', { className: 'chip' }, h('b', null, ui.fps), ' fps · ', h('b', null, ui.tps), ' tps')
    ),

    h('div', { className: 'main' },
      h(Controls, {
        params, setParam, seed, setSeed, worldSize, setWorldSize,
        onRestart: restart, overlay, setOverlay,
        showRoutes, setShowRoutes, showTrails, setShowTrails,
        godAction, stressMode, setStressMode
      }),

      h('div', { className: 'map-area' },
        h('canvas', { ref: canvasRef }),
        h('div', { className: 'legend' },
          legendRow('#1d4e7a', 'Water'),
          legendRow('#607a46', 'Plains'),
          legendRow('#2c5a34', 'Forest'),
          legendRow('#5c8c42', 'Fertile'),
          legendRow('#c4a86e', 'Desert'),
          legendRow('#8a8a8f', 'Mountain'),
          h('div', { className: 'row', style: { marginTop: 4 } },
            h('div', { className: 'sw', style: { background: '#5eead4', borderRadius: '50%' } }), 'Agents'),
          h('div', { className: 'row' },
            h('div', { className: 'sw', style: { background: '#96ff5a', borderRadius: '50%' } }), 'Sick'),
          h('div', { className: 'row' },
            h('div', { className: 'sw', style: { border: '2px solid #78e6ff', background: 'transparent' } }), 'Trade route'),
          overlay !== 'none'
            ? h('div', { className: 'row', style: { marginTop: 4, color: 'var(--accent)' } }, 'Overlay: ' + overlay)
            : null
        ),
        h(Inspector, { data: ui.inspector, onClose: clearSelection })
      ),

      h(Analytics, { stats: ui.stats, history: ui.history, events: ui.events })
    )
  );
}

function emptyHistory() {
  return { pop: [], food: [], settlements: [], conflicts: [], disease: [], tech: [], inequality: [], deaths: [] };
}

/** Copy the selected agent/settlement into a plain display object. */
function buildInspector(sim, sel) {
  if (!sel) return null;
  if (sel.type === 'agent') {
    const a = sim.agentById.get(sel.id);
    if (!a) return null;
    const home = a.home >= 0 ? sim.settlementById.get(a.home) : null;
    const traitVals = {
      curious: a.curiosity, aggressive: a.aggression, clever: a.intelligence,
      social: a.sociability, greedy: a.greed, empathic: a.empathy
    };
    const traits = Object.entries(traitVals).sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${(v * 100) | 0}%`);
    const skills = Object.entries(a.skills).sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${(v * 100) | 0}%`);
    let friends = 0, enemies = 0;
    for (const v of a.rel.values()) { if (v > 0.3) friends++; else if (v < -0.3) enemies++; }
    return {
      type: 'agent', id: a.id,
      stateLabel: a.state, age: a.age | 0,
      homeName: home ? `of ${home.name}` : 'nomad',
      health: a.health | 0, hunger: a.hunger | 0, thirst: a.thirst | 0,
      energy: a.energy | 0, fear: a.fear | 0, sick: a.sick,
      food: a.inv.food.toFixed(1), wood: a.inv.wood.toFixed(1), wealth: a.inv.wealth.toFixed(1),
      partner: a.partner >= 0 ? `#${a.partner}` : '—',
      friends, enemies, traits, skills, memory: a.memory.slice(-4)
    };
  }
  const s = sim.settlementById.get(sel.id);
  if (!s) return null;
  let allies = 0, enemies = 0;
  for (const v of s.relations.values()) { if (v > 0.5) allies++; else if (v < -0.4) enemies++; }
  const cultureTags = Object.entries(s.culture).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([k, v]) => `${k} ${(v * 100) | 0}%`);
  const buildings = Object.entries(s.buildings).filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}×${n}`).join(' ') || 'none';
  return {
    type: 'settlement', id: s.id, name: s.name,
    archetype: s.archetype, dominant: dominantCulture(s),
    founded: (s.founded / TICKS_PER_YEAR) | 0,
    members: s.members,
    stability: (s.stability * 100) | 0,
    foodStore: s.foodStore | 0, woodStore: s.woodStore | 0, stoneStore: s.stoneStore | 0,
    wealth: s.wealth | 0,
    tech: s.tech.toFixed(2), techPct: (s.tech / 12) * 100,
    defense: (s.defense * 100) | 0,
    leaderInfluence: (s.leaderInfluence * 100) | 0,
    sickCount: s.sickCount,
    buildings, tradePartners: s.tradePartners.size,
    allies, enemies, cultureTags,
    discoveries: s.discoveries.slice()
  };
}
