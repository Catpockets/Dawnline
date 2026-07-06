import React from 'react';
import { Simulation, DEFAULT_PARAMS } from './engine/simulation.js';
import { TICKS_PER_YEAR } from './engine/agents.js';
import { dominantCulture } from './engine/settlements.js';
import { Renderer } from './render/renderer.js';
import Controls, { WORLD_SIZES } from './ui/Controls.js';
import Analytics from './ui/Analytics.js';
import Inspector from './ui/Inspector.js';
import Timeline from './ui/Timeline.js';

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
  const [showRoutes, setShowRoutesState] = useState(false);
  const [showTrails, setShowTrailsState] = useState(true);
  const [, setSelection] = useState(null);
  const [armedGod, setArmedGod] = useState(null); // calamity awaiting a map click
  const [panel, setPanel] = useState(null); // mobile drawer: null | 'controls' | 'stats'
  const armedGodRef = useRef(null);
  const [ui, setUi] = useState({ stats: {}, events: [], history: emptyHistory(), milestones: [], fps: 0, tps: 0, inspector: null });

  runningRef.current = running;
  speedRef.current = SPEEDS[speedIdx];
  armedGodRef.current = armedGod;

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
          milestones: s.milestones,
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
    setPanel(null);
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

  // targetable calamities arm the cursor; the next map click strikes there
  const TARGETABLE = ['drought', 'plague', 'earthquake', 'wildfire', 'flood', 'migration'];
  const godAction = (kind) => {
    const s = simRef.current;
    if (!s) return;
    if (kind === 'globalDrought') s.forceDrought();
    else if (kind === 'addResources') s.addResources();
    else if (TARGETABLE.includes(kind)) {
      setArmedGod((cur) => (cur === kind ? null : kind));
      setPanel(null); // slide the drawer away so the map can be tapped
    }
  };

  // ---- canvas interaction: drag/touch = pan, wheel/pinch = zoom, tap = inspect
  useEffect(() => {
    const canvas = canvasRef.current;
    let dragging = false, moved = false, lx = 0, ly = 0;
    const pointers = new Map(); // active pointers → pinch support on touch
    let pinchDist = 0;

    const down = (e) => {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
      } else if (pointers.size === 2) {
        // second finger down: switch from pan to pinch
        dragging = false; moved = true;
        const [p1, p2] = [...pointers.values()];
        pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      }
    };
    const move = (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        // pinch: zoom toward the midpoint of the two fingers
        const [p1, p2] = [...pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (pinchDist > 0 && d > 0) {
          const rect = canvas.getBoundingClientRect();
          const mx = (p1.x + p2.x) / 2 - rect.left;
          const my = (p1.y + p2.y) / 2 - rect.top;
          rendererRef.current.zoomAt(mx, my, d / pinchDist);
        }
        pinchDist = d;
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      rendererRef.current.panBy(dx, dy);
      lx = e.clientX; ly = e.clientY;
    };
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (dragging && !moved) {
        const rect = canvas.getBoundingClientRect();
        if (armedGodRef.current) {
          // a calamity is armed: this click chooses where it strikes
          const [wx, wy] = rendererRef.current.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          const s = simRef.current;
          const kind = armedGodRef.current;
          if (s) {
            if (kind === 'migration') s.triggerMigrationPressure(wx, wy);
            else s.spawnDisaster(kind, wx, wy);
          }
          setArmedGod(null);
        } else {
          const hit = rendererRef.current.pickAt(e.clientX - rect.left, e.clientY - rect.top);
          rendererRef.current.selected = hit;
          setSelection(hit);
        }
      }
      dragging = false;
    };
    const cancelCtx = (e) => { e.preventDefault(); setArmedGod(null); };
    const cancelKey = (e) => { if (e.key === 'Escape') setArmedGod(null); };
    canvas.addEventListener('contextmenu', cancelCtx);
    window.addEventListener('keydown', cancelKey);
    const wheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      rendererRef.current.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 0.87);
    };
    const cancel = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchDist = 0; dragging = false; };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('contextmenu', cancelCtx);
      window.removeEventListener('keydown', cancelKey);
    };
  }, []);

  useEffect(() => {
    if (canvasRef.current) canvasRef.current.style.cursor = armedGod ? 'crosshair' : '';
  }, [armedGod]);

  const clearSelection = () => { setSelection(null); if (rendererRef.current) rendererRef.current.selected = null; };
  const st = ui.stats || {};

  const legendRow = (bg, label, extra) => h('div', { className: 'row' },
    h('div', { className: 'sw', style: Object.assign({ background: bg }, extra || {}) }), label);

  return h('div', { className: 'app' },
    h('div', { className: 'topbar' },
      h('button', {
        className: 'mobile-only' + (panel === 'controls' ? ' on' : ''),
        onClick: () => setPanel(panel === 'controls' ? null : 'controls')
      }, '☰'),
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
      h('span', { className: 'chip hide-sm' }, 'Tick ', h('b', null, st.tick ?? 0)),
      h('span', { className: 'chip' }, 'Pop ', h('b', null, st.population ?? 0)),
      h('span', { className: 'chip hide-sm' }, h('b', null, ui.fps), ' fps · ', h('b', null, ui.tps), ' tps'),
      h('button', {
        className: 'mobile-only' + (panel === 'stats' ? ' on' : ''),
        onClick: () => setPanel(panel === 'stats' ? null : 'stats')
      }, '📊')
    ),

    h('div', {
      className: 'main' + (panel === 'controls' ? ' show-left' : panel === 'stats' ? ' show-right' : '')
    },
      panel ? h('div', { className: 'drawer-backdrop', onClick: () => setPanel(null) }) : null,
      h(Controls, {
        params, setParam, seed, setSeed, worldSize, setWorldSize,
        onRestart: restart, overlay, setOverlay,
        showRoutes, setShowRoutes, showTrails, setShowTrails,
        godAction, armedGod, stressMode, setStressMode
      }),

      h('div', { className: 'map-area' },
        h('canvas', { ref: canvasRef, style: { touchAction: 'none' } }),
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
        armedGod ? h('div', { className: 'god-banner' },
          `☄ Click the map to unleash ${armedGod.toUpperCase()} — Esc or right-click to cancel`) : null,
        h(Timeline, { milestones: ui.milestones || [], tick: st.tick || 0, ticksPerYear: TICKS_PER_YEAR }),
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
    const spouse = a.spouse >= 0 ? sim.agentById.get(a.spouse) : null;
    const mother = a.mother >= 0 ? sim.agentById.get(a.mother) : null;
    const father = a.father >= 0 ? sim.agentById.get(a.father) : null;
    let kidsAlive = 0;
    for (const cid of a.children) if (sim.agentById.get(cid)) kidsAlive++;
    return {
      type: 'agent', id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      sex: a.sex,
      pregnant: !!a.pregnant,
      stateLabel: a.state, age: a.age | 0,
      homeName: home ? `of ${home.name}` : 'nomad',
      health: a.health | 0, hunger: a.hunger | 0, thirst: a.thirst | 0,
      energy: a.energy | 0, fear: a.fear | 0, sick: a.sick,
      food: a.inv.food.toFixed(1), wood: a.inv.wood.toFixed(1), wealth: a.inv.wealth.toFixed(1),
      spouseName: spouse ? `${spouse.firstName} ${spouse.lastName}` : (a.spouse >= 0 ? 'widowed' : '—'),
      childrenLabel: a.children.length ? `${kidsAlive} living of ${a.children.length}` : '—',
      parents: (mother || father)
        ? `${mother ? mother.firstName : '†'} & ${father ? father.firstName : '†'}`
        : (a.mother >= 0 || a.father >= 0 ? 'deceased' : 'unknown'),
      friends, enemies, traits, skills, memory: a.memory.slice(-4)
    };
  }
  if (sel.type === 'grave') {
    const gr = sim.graves.find((g) => g.id === sel.id);
    if (!gr) return null;
    return { type: 'grave', ...gr };
  }
  if (sel.type === 'ruin') {
    const r = sim.ruins?.find((ruin) => ruin.id === sel.id);
    if (!r) return null;
    return {
      type: 'ruin',
      id: r.id,
      name: r.name,
      icon: r.icon,
      cause: r.cause,
      year: r.year,
      finalMembers: r.finalMembers,
      stability: r.stability,
      foodStore: r.foodStore,
      refugees: r.refugees,
      casualties: r.casualties,
      summary: r.summary
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
    metalStore: s.metalStore | 0, luxuryStore: s.luxuryStore | 0,
    wealth: s.wealth | 0,
    tech: s.tech.toFixed(2), techPct: (s.tech / 12) * 100,
    defense: (s.defense * 100) | 0,
    leaderInfluence: (s.leaderInfluence * 100) | 0,
    sickCount: s.sickCount,
    buildings, tradePartners: s.tradePartners.size,
    allies, enemies, cultureTags,
    resources: s.resourceProfile
      ? `food ${s.resourceProfile.food | 0} · wood ${s.resourceProfile.wood | 0} · ore ${s.resourceProfile.metal | 0} · gems ${s.resourceProfile.gems | 0}`
      : 'surveying',
    discoveries: s.discoveries.slice()
  };
}
