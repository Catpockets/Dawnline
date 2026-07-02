import React from 'react';

const h = React.createElement;

const OVERLAYS = [
  'none', 'food', 'water', 'fertility', 'density', 'influence',
  'trade', 'conflict', 'disease', 'tech', 'wealth', 'culture'
];

const WORLD_SIZES = [
  { label: 'Small (80×52)', w: 80, h: 52 },
  { label: 'Medium (112×72)', w: 112, h: 72 },
  { label: 'Large (150×96)', w: 150, h: 96 },
  { label: 'Huge (190×120)', w: 190, h: 120 }
];

function Slider({ label, value, min, max, step, onChange, fmt }) {
  return h('div', { className: 'slider-row' },
    h('label', null, label, h('span', null, fmt ? fmt(value) : value)),
    h('input', {
      type: 'range', min, max, step, value,
      onChange: (e) => onChange(parseFloat(e.target.value))
    })
  );
}

/**
 * Left sidebar: world parameters (some live, some applied on restart),
 * god tools, and overlay selection. Pure controlled components — the
 * actual simulation lives outside React.
 */
export default function Controls({
  params, setParam, seed, setSeed, worldSize, setWorldSize,
  onRestart, overlay, setOverlay, showRoutes, setShowRoutes,
  showTrails, setShowTrails, godAction, stressMode, setStressMode
}) {
  return h('div', { className: 'sidebar' },
    h('div', { className: 'section' },
      h('h3', null, 'World Genesis ',
        h('span', { style: { color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 } }, '(applied on restart)')),
      h('div', { className: 'slider-row' },
        h('label', null, 'Seed'),
        h('input', { type: 'text', value: seed, onChange: (e) => setSeed(e.target.value) })
      ),
      h('div', { className: 'slider-row', style: { marginTop: 6 } },
        h('label', null, 'World size'),
        h('select', { value: worldSize, onChange: (e) => setWorldSize(+e.target.value) },
          WORLD_SIZES.map((s, i) => h('option', { key: i, value: i }, s.label))
        )
      ),
      h(Slider, { label: 'Starting population', value: params.startPop, min: 50, max: 3000, step: 10, onChange: (v) => setParam('startPop', v) }),
      h(Slider, { label: 'Resource abundance', value: params.resourceAbundance, min: 0.4, max: 2, step: 0.05, onChange: (v) => setParam('resourceAbundance', v), fmt: (v) => v.toFixed(2) }),
      h('button', { className: 'primary', style: { width: '100%', marginTop: 4 }, onClick: onRestart }, '⟲ Regenerate World'),
      h('button', {
        className: 'tiny' + (stressMode ? ' on' : ''), style: { width: '100%', marginTop: 6 },
        onClick: () => setStressMode(!stressMode)
      }, stressMode ? '⚡ Stress mode ON (2000+ agents)' : '⚡ Enable stress mode')
    ),

    h('div', { className: 'section' },
      h('h3', null, 'Live Dynamics'),
      h(Slider, { label: 'Aggression', value: params.aggression, min: 0, max: 2.5, step: 0.05, onChange: (v) => setParam('aggression', v), fmt: (v) => v.toFixed(2) }),
      h(Slider, { label: 'Climate volatility', value: params.climateVolatility, min: 0, max: 3, step: 0.05, onChange: (v) => setParam('climateVolatility', v), fmt: (v) => v.toFixed(2) }),
      h(Slider, { label: 'Disease severity', value: params.diseaseSeverity, min: 0, max: 3, step: 0.05, onChange: (v) => setParam('diseaseSeverity', v), fmt: (v) => v.toFixed(2) }),
      h(Slider, { label: 'Technology speed', value: params.techSpeed, min: 0.2, max: 3, step: 0.05, onChange: (v) => setParam('techSpeed', v), fmt: (v) => v.toFixed(2) }),
      h(Slider, { label: 'Trade friendliness', value: params.tradeFriendliness, min: 0, max: 2.5, step: 0.05, onChange: (v) => setParam('tradeFriendliness', v), fmt: (v) => v.toFixed(2) }),
      h(Slider, { label: 'Disaster frequency', value: params.disasterFrequency, min: 0, max: 3, step: 0.05, onChange: (v) => setParam('disasterFrequency', v), fmt: (v) => v.toFixed(2) })
    ),

    h('div', { className: 'section' },
      h('h3', null, 'God Tools'),
      h('div', { className: 'btn-grid' },
        h('button', { className: 'danger', onClick: () => godAction('drought') }, '🔥 Drought'),
        h('button', { className: 'danger', onClick: () => godAction('plague') }, '☣ Plague'),
        h('button', { className: 'danger', onClick: () => godAction('earthquake') }, '🌋 Earthquake'),
        h('button', { className: 'danger', onClick: () => godAction('wildfire') }, '🌲 Wildfire'),
        h('button', { className: 'danger', onClick: () => godAction('flood') }, '🌊 Flood'),
        h('button', { className: 'danger', onClick: () => godAction('globalDrought') }, '☀ Global drought'),
        h('button', { onClick: () => godAction('addResources') }, '✦ Add resources'),
        h('button', { onClick: () => godAction('migration') }, '👣 Migration push')
      )
    ),

    h('div', { className: 'section' },
      h('h3', null, 'Map Overlays'),
      h('div', { className: 'overlay-grid' },
        OVERLAYS.map((o) => h('button', {
          key: o, className: overlay === o ? 'on' : '', onClick: () => setOverlay(o)
        }, o))
      ),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
        h('button', { className: 'tiny' + (showRoutes ? ' on' : ''), onClick: () => setShowRoutes(!showRoutes) }, 'Trade routes'),
        h('button', { className: 'tiny' + (showTrails ? ' on' : ''), onClick: () => setShowTrails(!showTrails) }, 'Migration trails')
      )
    )
  );
}

export { WORLD_SIZES };
