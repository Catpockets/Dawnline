import React from 'react';

const h = React.createElement;

const Bar = ({ v, color }) => h('div', { className: 'bar' },
  h('div', { style: { width: `${Math.max(0, Math.min(100, v))}%`, background: color } })
);
const KV = ({ k, v }) => h('div', { className: 'kv' },
  h('span', { className: 'k' }, k), h('span', { className: 'v' }, v)
);

/**
 * Floating inspector for a clicked agent or settlement. Receives a plain
 * snapshot object (copied out of the engine 4×/sec) so it stays live while
 * the simulation runs.
 */
export default function Inspector({ data, onClose, onFollow }) {
  if (!data) return null;

  if (data.type === 'agent') {
    const a = data;
    return h('div', { className: 'inspector' },
      h('h4', null, `${a.sex === 'F' ? '♀' : '♂'} ${a.name} `, h('button', { onClick: onClose }, '✕')),
      h('div', { className: 'sub' },
        `${a.stateLabel}${a.pregnant ? ' · 🤰 expecting' : ''} · ${a.stage}, ${a.age} · ${a.homeName}${a.ideologyName ? ' · ' + a.ideologyName : ''}`),
      onFollow ? h('button', { className: 'tiny', style: { marginBottom: 7 }, onClick: () => onFollow(a.id) }, '🎥 Follow') : null,
      h(KV, { k: 'Health', v: a.health }), h(Bar, { v: a.health, color: a.health > 50 ? 'var(--good)' : 'var(--bad)' }),
      h(KV, { k: 'Hunger', v: a.hunger }), h(Bar, { v: a.hunger, color: a.hunger > 60 ? 'var(--bad)' : 'var(--warn)' }),
      h(KV, { k: 'Thirst', v: a.thirst }), h(Bar, { v: a.thirst, color: '#7dd3fc' }),
      h(KV, { k: 'Energy', v: a.energy }), h(Bar, { v: a.energy, color: '#c084fc' }),
      h(KV, { k: 'Fear', v: a.fear }), h(Bar, { v: a.fear, color: '#fb7185' }),
      h(KV, { k: 'Sick', v: a.sick ? 'YES' : 'no' }),
      h(KV, { k: 'Inventory', v: `🍖${a.food} 🪵${a.wood} 💰${a.wealth}` }),
      h(KV, { k: 'Spouse', v: a.spouseName }),
      h(KV, { k: 'Children', v: a.childrenLabel }),
      h(KV, { k: 'Parents', v: a.parents }),
      h(KV, { k: 'Relationships', v: `${a.friends} friends · ${a.enemies} rivals` }),
      h('div', { style: { margin: '7px 0 3px' } },
        a.traits.map((t) => h('span', { key: t, className: 'tag' }, t))),
      h('div', { style: { marginBottom: 5 } },
        a.skills.map((t) => h('span', {
          key: t, className: 'tag',
          style: { borderColor: 'rgba(94,234,212,0.4)', color: 'var(--accent)' }
        }, t))),
      a.memory.length > 0 ? h(React.Fragment, null,
        h('div', { className: 'kv' }, h('span', { className: 'k' }, 'Recent memory')),
        a.memory.map((m, i) => h('div', { key: i, className: 'mem' }, `“${m}”`))
      ) : null,
      // ---- AI MIND: why this agent chose what it chose ----
      a.ai ? h('div', { className: 'ai-mind' },
        h('div', { className: 'hdr' }, '🧠 AI MIND'),
        h('div', { className: 'ai-row' }, h('span', { className: 'k' }, 'Chosen action'), h('span', { className: 'v' }, a.ai.action)),
        h('div', { className: 'ai-row' }, h('span', { className: 'k' }, 'Life-stage rule'), h('span', { className: 'v' }, a.ai.legality)),
        a.ai.top.map(([nm, sc, note], i) => h('div', { key: i, className: 'ai-row' },
          h('span', { className: 'k' }, `${i + 1}. ${nm}`),
          h('span', { className: 'v' + (note ? ' block' : '') }, note || (+sc).toFixed(2)))),
        a.ai.learned.length ? h('div', { className: 'ai-row' },
          h('span', { className: 'k' }, 'Learned prefs'), h('span', { className: 'v' }, a.ai.learned.join(' · '))) : null,
        a.ai.rewards.length ? h('div', { className: 'ai-row' },
          h('span', { className: 'k' }, 'Recent rewards'),
          h('span', { className: 'v' }, a.ai.rewards.map(r => `${r.a} ${r.r > 0 ? '+' : ''}${r.r}`).join(', '))) : null,
        h('div', { className: 'ai-row' }, h('span', { className: 'k' }, 'Avg outcome'), h('span', { className: 'v' }, a.ai.ema)),
        h('div', { className: 'ai-row' }, h('span', { className: 'k' }, 'Exploration'), h('span', { className: 'v' }, a.ai.eps)),
        a.ai.mentor ? h('div', { className: 'ai-row' },
          h('span', { className: 'k' }, 'Learned from'), h('span', { className: 'v' }, a.ai.mentor)) : null
      ) : null
    );
  }

  if (data.type === 'grave') {
    const g = data;
    return h('div', { className: 'inspector' },
      h('h4', null, `🪦 ${g.name} `, h('button', { onClick: onClose }, '✕')),
      h('div', { className: 'sub' }, `${g.sex === 'F' ? '♀' : '♂'} died Year ${g.year}, aged ${g.age}`),
      h(KV, { k: 'Cause of death', v: g.cause }),
      g.killer ? h(KV, { k: 'Slain by', v: g.killer }) : null,
      h('div', { className: 'mem', style: { marginTop: 8 } },
        g.killer ? `${g.name} was killed by ${g.killer}.` : `Here lies ${g.name}, taken by ${g.cause}.`)
    );
  }

  if (data.type === 'ruin') {
    const r = data;
    return h('div', { className: 'inspector' },
      h('h4', null, `${r.icon} ${r.name} `, h('button', { onClick: onClose }, '✕')),
      h('div', { className: 'sub' }, `Fell in Y${r.year} · ${r.cause}`),
      h(KV, { k: 'Downfall', v: r.cause }),
      h(KV, { k: 'Final population', v: r.finalMembers }),
      h(KV, { k: 'Final stability', v: `${r.stability}%` }),
      h(KV, { k: 'Food left', v: r.foodStore }),
      h(KV, { k: 'Survivors', v: `${r.refugees} fled · ${r.casualties} died` }),
      h('div', { className: 'mem', style: { marginTop: 8 } }, r.summary)
    );
  }

  const s = data;
  return h('div', { className: 'inspector' },
    h('h4', null, `⬢ ${s.name} `, h('button', { onClick: onClose }, '✕')),
    h('div', { className: 'sub' },
      `${s.archetype}${s.specialty ? ' · known for ' + s.specialty : ''} · founded Y${s.founded} · ${s.dominant} culture`,
      s.lineage ? h('div', { style: { marginTop: 2, color: 'var(--warn)' } }, s.lineage) : null),
    h(KV, { k: 'Population', v: s.members }),
    h(KV, { k: 'Stability', v: `${s.stability}%` }), h(Bar, { v: s.stability, color: s.stability > 50 ? 'var(--good)' : 'var(--bad)' }),
    h(KV, { k: 'Food store', v: s.foodStore }),
    h(KV, { k: 'Wood / Stone', v: `${s.woodStore} / ${s.stoneStore}` }),
    h(KV, { k: 'Metal / Luxuries', v: `${s.metalStore} / ${s.luxuryStore}` }),
    h(KV, { k: 'Local resources', v: s.resources }),
    h(KV, { k: 'Wealth', v: s.wealth }),
    h(KV, { k: 'Technology', v: s.tech }), h(Bar, { v: Math.min(100, s.techPct), color: '#c084fc' }),
    h(KV, { k: 'Defense', v: `${s.defense}%` }),
    h(KV, { k: 'Leader influence', v: `${s.leaderInfluence}%` }),
    h(KV, { k: 'Sick residents', v: s.sickCount }),
    h(KV, { k: 'Buildings', v: s.buildings }),
    h(KV, { k: 'Trade partners', v: s.tradePartners }),
    h(KV, { k: 'Diplomacy', v: `${s.allies} allies · ${s.enemies} enemies` }),
    h('div', { style: { margin: '7px 0 3px' } },
      s.cultureTags.map((t) => h('span', { key: t, className: 'tag' }, t))),
    s.discoveries.length > 0 ? h(React.Fragment, null,
      h('div', { className: 'kv' }, h('span', { className: 'k' }, 'Discoveries')),
      h('div', { style: { marginTop: 3 } },
        s.discoveries.map((d) => h('span', {
          key: d, className: 'tag',
          style: { borderColor: 'rgba(192,132,252,0.4)', color: '#c084fc' }
        }, d)))
    ) : null
  );
}
