import React from 'react';
import MiniChart from './MiniChart.js';
import AgentSearchPanel from './AgentSearchPanel.js';

const h = React.createElement;

function Stat({ k, v, cls = '' }) {
  return h('div', { className: 'stat' },
    h('div', { className: 'v ' + cls }, v),
    h('div', { className: 'k' }, k)
  );
}

/**
 * Right sidebar: headline stats, eight time-series charts and the event log.
 * All values come from the periodic engine snapshot — nothing here touches
 * the simulation directly.
 */
export default function Analytics({ stats, history, events, onSearch, onPick }) {
  const s = stats || {};
  const fmt1 = (v) => (v === undefined ? '—' : (+v).toFixed(1));
  const pct = (v) => (v === undefined ? '—' : Math.round(v * 100) + '%');

  return h('div', { className: 'sidebar right' },
    h(AgentSearchPanel, { onSearch, onPick }),
    h('div', { className: 'section' },
      h('h3', null, 'Civilization Analytics'),
      h('div', { className: 'stat-grid' },
        h(Stat, { k: 'Population', v: s.population ?? '—' }),
        h(Stat, { k: 'Settlements', v: s.settlements ?? '—' }),
        h(Stat, { k: 'Births', v: s.births ?? '—' }),
        h(Stat, { k: 'Deaths', v: s.deaths ?? '—', cls: s.deaths > s.births ? 'warn' : '' }),
        h(Stat, { k: 'Avg health', v: fmt1(s.avgHealth), cls: s.avgHealth < 50 ? 'bad' : '' }),
        h(Stat, { k: 'Avg hunger', v: fmt1(s.avgHunger), cls: s.avgHunger > 60 ? 'bad' : '' }),
        h(Stat, { k: 'Total food', v: Math.round(s.totalFood ?? 0) }),
        h(Stat, { k: 'Avg tech', v: fmt1(s.avgTech) }),
        h(Stat, { k: 'Conflicts', v: s.conflicts ?? 0, cls: s.conflicts > 3 ? 'warn' : '' }),
        h(Stat, { k: 'Trade routes', v: s.tradeRoutes ?? 0 }),
        h(Stat, { k: 'Disease cases', v: s.diseaseCases ?? 0, cls: s.diseaseCases > 20 ? 'bad' : '' }),
        h(Stat, { k: 'Collapse risk', v: pct(s.collapseRisk), cls: s.collapseRisk > 0.5 ? 'bad' : s.collapseRisk > 0.3 ? 'warn' : '' }),
        h(Stat, { k: 'Richest', v: s.richest ?? '—', cls: 'small' }),
        h(Stat, { k: 'Largest', v: s.largest ?? '—', cls: 'small' }),
        h(Stat, { k: 'Most aggressive', v: s.mostAggressive ?? '—', cls: 'small' }),
        h(Stat, {
          k: 'Climate Δtemp',
          v: s.tempOffset !== undefined ? (s.tempOffset > 0 ? '+' : '') + s.tempOffset.toFixed(3) : '—',
          cls: s.tempOffset > 0.12 ? 'warn' : ''
        }),
        h(Stat, { k: 'Marriages', v: s.marriages ?? 0 }),
        h(Stat, { k: 'Colonies', v: s.colonies ?? 0 }),
        h(Stat, { k: 'Orphans', v: `${s.orphans ?? 0} / ${s.children ?? 0}`, cls: s.orphans > 3 ? 'warn' : '' }),
        h(Stat, { k: 'Avg AI reward', v: s.avgReward !== undefined ? s.avgReward.toFixed(2) : '—', cls: s.avgReward < 0 ? 'warn' : '' })
      )
    ),

    (s.ideologies && s.ideologies.length) ? h('div', { className: 'section' },
      h('h3', null, `Ideologies (${s.conversions ?? 0} conversions)`),
      s.ideologies.map((I) => h('div', { key: I.id, className: 'ideo-row' },
        h('div', { className: 'ideo-dot', style: { background: `hsl(${I.hue}, 80%, 60%)`, color: `hsl(${I.hue}, 80%, 60%)` } }),
        h('span', { className: 'nm' }, I.name),
        h('span', { className: 'meta' },
          `${I.type}${I.parent ? ' (schism)' : ''}`, h('br'),
          `${I.followers} souls · zeal ${(I.zeal * 100) | 0}% · tol ${(I.tolerance * 100) | 0}%`)
      ))
    ) : null,

    h('div', { className: 'section' },
      h('h3', null, 'Time Series'),
      h('div', { className: 'chart-grid' },
        h(MiniChart, { label: 'Population', data: history.pop, color: '#5eead4' }),
        h(MiniChart, { label: 'Food supply', data: history.food, color: '#4ade80' }),
        h(MiniChart, { label: 'Settlements', data: history.settlements, color: '#7dd3fc' }),
        h(MiniChart, { label: 'Conflicts', data: history.conflicts, color: '#f87171' }),
        h(MiniChart, { label: 'Disease', data: history.disease, color: '#a3e635' }),
        h(MiniChart, { label: 'Avg tech', data: history.tech, color: '#c084fc', format: (v) => v.toFixed(1) }),
        h(MiniChart, { label: 'Inequality', data: history.inequality, color: '#fbbf24', format: (v) => v.toFixed(2) }),
        h(MiniChart, { label: 'Deaths / sample', data: history.deaths, color: '#fb7185' })
      )
    ),

    h('div', { className: 'section' },
      h('h3', null, 'Chronicle'),
      h('div', { className: 'event-log' },
        [...events].reverse().map((e, i) => h('div', { key: i, className: 'event ' + e.kind },
          h('span', { className: 'yr' }, 'Y' + e.year), e.text
        )),
        events.length === 0 ? h('div', { className: 'event' }, 'History awaits…') : null
      )
    )
  );
}
